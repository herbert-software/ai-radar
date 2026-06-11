/**
 * 日报任务全局单例锁（telegram-push 9.4，design D6）。
 *
 * push_records 的 `UNIQUE(target_type, target_id, channel, push_date)` 只保证「记录不重复插」，
 * **挡不住并发**：两个并发实例都读到同批 pending、各自拼一条消息发送 → 双发。故必须由
 * 单例锁兜住「某一 push_date 的日报任务全局只有一个实例在跑」。
 *
 * 关键不变量（绝不可违背）：
 * - 锁键为 `daily-digest:{push_date}`，用 Redis `SET key val NX PX ttl` 原子获取。
 * - **必须带 TTL 或 finally 释放**：无 TTL 的 SETNX 崩溃未释放会使当日永远拿不到锁，
 *   与「僵尸 pending 下次重试」需求直接冲突（死锁）。本实现两者兼具——TTL 兜底崩溃，
 *   正常路径 finally 用「核对持有令牌再删」释放（防误删他人锁）。
 * - **TTL 须显著大于最坏 runDailyWorkflow 时长**（采集 + 数百条 LLM 调用可达十几分钟），
 *   且配看门狗续租：固定小 TTL 提前过期会让第二实例拿锁双发（经典分布式锁陷阱）。
 *   默认 TTL 15 分钟 + 每 TTL/3 续租一次，长任务不会中途失锁。
 * - 崩溃后同 push_date 须能在 TTL 到期后重新获取，完成僵尸 pending 重试（不死锁）。
 */
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { env } from '../config/env.js';

/** 默认锁 TTL（毫秒）：15 分钟，显著大于最坏 workflow 时长，配续租进一步兜底。 */
const DEFAULT_TTL_MS = 15 * 60 * 1000;

/** 最小 Redis 能力面（便于集成测注入内存桩；真实用 ioredis）。 */
export interface RedisLike {
  set(
    key: string,
    value: string,
    mode: 'PX',
    ttlMs: number,
    nx: 'NX',
  ): Promise<'OK' | null>;
  /** 用 Lua 脚本「核对值再删/续租」，保证原子且只动自己持有的锁。 */
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

/** 已持有的锁句柄；释放时核对令牌防误删他人锁。 */
export interface DigestLock {
  readonly key: string;
  readonly token: string;
  /**
   * 当前是否仍真正持有锁（租约未失、未释放、且未越过租约截止点）。false 的三条触发：
   * - 看门狗续租发现令牌不匹配/键已不存在（锁被抢占或过期），置租约已失；
   * - 已 release()；
   * - 续租命令持续报错、从未成功续租，直到原 TTL 到期（租约截止点已过）——此刻 Redis 键
   *   也已过期、他人可重获，故必须自认失锁（不能寄望 Redis 端 TTL 回传进程内状态）。
   * 调用方（如 run-daily-workflow）在 dispatch 前应检查此值，false 时立即中止以避免双发。
   */
  isHeld(): boolean;
  /** 释放锁（核对令牌后删除）。重复调用安全（已释放则无操作）。 */
  release(): Promise<void>;
}

export interface AcquireLockOptions {
  /** 注入 Redis（默认按 env.REDIS_URL 新建一次性短连接）。 */
  redis?: RedisLike;
  /** 锁 TTL（毫秒），默认 15 分钟。须显著大于最坏 workflow 时长。 */
  ttlMs?: number;
  /**
   * 看门狗续租间隔（毫秒），默认 ttl/3。设为 0 关闭续租（仅靠 TTL，测试用）。
   * 续租使长任务不会因固定 TTL 提前过期而失锁致双发。
   */
  renewIntervalMs?: number;
}

// 「核对令牌再删」——只删自己持有的锁，避免锁过期被他人重获后误删（经典分布式锁安全）。
const RELEASE_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
else
  return 0
end`;

// 「核对令牌再续租」——只续自己持有的锁；若已被他人重获则不续（返回 0）。
const RENEW_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('pexpire', KEYS[1], ARGV[2])
else
  return 0
end`;

function lockKey(pushDate: string): string {
  return `daily-digest:${pushDate}`;
}

/**
 * 尝试获取某 push_date 的日报单例锁。
 *
 * 成功 → 返回 DigestLock（含 release + 后台看门狗续租）；
 * 已被他人持有 → 返回 null（调用方应放弃本次运行，不发任何消息）。
 *
 * 调用方**必须**在 finally 中 `await lock.release()`（即便如此 TTL 仍兜底崩溃场景）。
 */
export async function acquireDigestLock(
  pushDate: string,
  options: AcquireLockOptions = {},
): Promise<DigestLock | null> {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const renewIntervalMs =
    options.renewIntervalMs ?? Math.floor(ttlMs / 3);
  const key = lockKey(pushDate);
  const token = randomUUID();

  // 未注入 redis 时新建一次性连接，并在 release 时关闭（避免句柄泄漏）。
  // 自有连接加 commandTimeout：Redis 半死（连上不回包）时续租/释放命令快速失败而非无限阻塞。
  const ownsConnection = !options.redis;
  const redis: RedisLike =
    options.redis ??
    (new Redis(env.REDIS_URL, { commandTimeout: 5000 }) as unknown as RedisLike);

  // 租约保障截止点（本地时钟）：获取/每次续租成功后前推一个 TTL。以「命令发起时刻」为基准
  // （早于 Redis 服务端实际应用 PX 的时刻），故本地截止点保守地**早于** Redis 真实过期——
  // 杜绝「本地仍自认持有、Redis 键却已过期被他人重获」的双发窗口。
  const acquireSentAt = Date.now();

  let acquired: 'OK' | null;
  try {
    acquired = await redis.set(key, token, 'PX', ttlMs, 'NX');
  } catch (error) {
    if (ownsConnection) (redis as unknown as Redis).disconnect();
    throw error;
  }

  if (acquired !== 'OK') {
    if (ownsConnection) (redis as unknown as Redis).disconnect();
    return null;
  }

  // 看门狗：周期性续租，使长任务不会因固定 TTL 中途过期失锁致双发。
  // leaseLost：续租发现锁已不属于自己（Lua 返 0：令牌不匹配/键已不存在）即置真，
  // 供 isHeld() 暴露给调用方在 dispatch 前中止，避免「已丢锁仍发送 → 双发」。
  let leaseLost = false;
  let leaseDeadlineMs = acquireSentAt + ttlMs;
  let timer: ReturnType<typeof setInterval> | undefined;
  if (renewIntervalMs > 0) {
    timer = setInterval(() => {
      const renewSentAt = Date.now();
      void redis
        .eval(RENEW_SCRIPT, 1, key, token, ttlMs)
        .then((result) => {
          // Lua 返 1=续租成功；返 0=令牌不匹配或键已不存在 → 锁已被抢占/过期，租约已失。
          if (result === 1) {
            // 续租成功：把租约截止点前推一个 TTL（基准取发起时刻，保守早于 Redis 实际过期）。
            leaseDeadlineMs = renewSentAt + ttlMs;
          } else {
            leaseLost = true;
            if (timer) clearInterval(timer);
            console.error(
              `[lock] 续租失败：租约已失（锁被抢占或过期），${key}`,
            );
          }
        })
        .catch((error: unknown) => {
          // 续租命令抛错（如 Redis commandTimeout）可能仅瞬时抖动，不立刻判丢锁
          // （误判会让正常长任务无谓中止）；仅告警，下次续租成功则自愈。
          // **关键**：报错时绝不前推 leaseDeadlineMs——若续租持续失败直到原 TTL 到期，
          // isHeld() 会据租约截止点自动转 false（此刻 Redis 键也已过期、他人可重获），
          // 杜绝「续租一直报错却仍自认持有 → 双发」（不能依赖 Redis 端 TTL 兜底，
          // 那不会回传到进程内的持有状态）。
          console.error(`[lock] 续租命令出错（瞬时，未判丢锁），${key}:`, error);
        });
    }, renewIntervalMs);
    // 不阻塞进程退出。
    if (typeof timer.unref === 'function') timer.unref();
  }

  let released = false;
  return {
    key,
    token,
    isHeld(): boolean {
      // 持有 = 未被 Lua 判丢 && 未释放 && 仍在租约截止点之内。截止点防「续租持续报错
      // 至 TTL 过期仍自认持有」：报错路径不前推截止点，过点即转 false（见看门狗 catch）。
      return !leaseLost && !released && Date.now() < leaseDeadlineMs;
    },
    async release(): Promise<void> {
      if (released) return;
      released = true;
      if (timer) clearInterval(timer);
      try {
        await redis.eval(RELEASE_SCRIPT, 1, key, token);
      } finally {
        if (ownsConnection) (redis as unknown as Redis).disconnect();
      }
    },
  };
}
