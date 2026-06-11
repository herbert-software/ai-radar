/**
 * 实时告警独立单例锁 `alert:{event_id}`（per-event，realtime-alerts / design D6）。
 *
 * `push_records` 的 `UNIQUE(target_type,target_id,channel,push_date)` 只保证「记录不重复插」，
 * **挡不住并发**：两并发 alert-scan 实例都读到同一达阈值候选、各自分发告警 → 双发。故告警推送
 * 路径必须带独立单例锁兜住「某 event_id 的告警全局只有一个实例在发」。
 *
 * **统一模型（Model B）**：选题与通道解耦——告警事件 channel-agnostic 选出后**同份发放给所有通道**，
 * 故锁按 **event_id（per-event，覆盖该事件的多通道分发）** 而非按 (channel,event_id)：一个事件的告警
 * 决策只发生一次、整批发给所有通道，由该事件锁串行化并发实例。
 *
 * 关键不变量（绝不可违背，realtime-alerts）：
 * - 锁键为 `alert:{event_id}`（**不含时间**），用 Redis `SET key val NX PX ttl` 原子获取。
 * - **必须带 TTL 或 finally 释放**：锁键无时间，无 TTL 且崩溃未释放会使该事件告警**永久死锁**
 *   （该 event_id 再也拿不到锁、再也发不出告警）。故释放语义不可省——本实现两者兼具：
 *   TTL 兜底崩溃，正常路径 finally 用「核对持有令牌再删」释放（防误删他人锁）。
 * - 告警是 **job 级短时持有**（单事件向各通道一次发送，非数百条 LLM 长任务）：无需看门狗续租，
 *   一个覆盖「单事件渲染 + 多通道送达」最坏时长的 TTL 足矣（默认 env.ALERT_LOCK_TTL_MS）。
 * - 崩溃后同 event_id 须能在 TTL 到期后重新获取，完成 failed 告警重试（不死锁）。
 *
 * 与 daily 锁（push/lock.ts，长任务带看门狗续租 + isHeld 防丢锁双发）的区别：告警短任务无需续租，
 * 故本模块刻意精简——不实现 isHeld/续租，只提供「获取 + finally 释放（核对令牌）」。
 */
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import type { RedisLike } from '../push/lock.js';

/** 已持有的告警锁句柄；释放时核对令牌防误删他人锁。 */
export interface AlertLock {
  readonly key: string;
  readonly token: string;
  /** 释放锁（核对令牌后删除）。重复调用安全（已释放则无操作）。 */
  release(): Promise<void>;
}

export interface AcquireAlertLockOptions {
  /** 注入 Redis（默认按 env.REDIS_URL 新建一次性短连接）。 */
  redis?: RedisLike;
  /** 锁 TTL（毫秒），默认 env.ALERT_LOCK_TTL_MS。须覆盖「单事件渲染 + 单通道送达」最坏时长。 */
  ttlMs?: number;
}

// 「核对令牌再删」——只删自己持有的锁，避免锁过期被他人重获后误删（经典分布式锁安全）。
const RELEASE_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
else
  return 0
end`;

/** 告警锁键：`alert:{event_id}`（per-event，不含时间，故释放语义不可省，见模块头）。 */
export function alertLockKey(eventId: string): string {
  return `alert:${eventId}`;
}

/**
 * 尝试获取某 event_id 的告警单例锁（per-event，覆盖该事件向所有通道的分发）。
 *
 * 成功 → 返回 AlertLock（含 release）；已被他人持有 → 返回 null（调用方应跳过该告警事件，不重复发）。
 * 调用方**必须**在 finally 中 `await lock.release()`（即便如此 TTL 仍兜底崩溃场景）。
 *
 * @param eventId  告警事件 id。
 * @param options  注入点（redis / ttlMs）。
 */
export async function acquireAlertLock(
  eventId: string,
  options: AcquireAlertLockOptions = {},
): Promise<AlertLock | null> {
  const ttlMs = options.ttlMs ?? env.ALERT_LOCK_TTL_MS;
  const key = alertLockKey(eventId);
  const token = randomUUID();

  // 未注入 redis 时新建一次性连接，并在 release 时关闭（避免句柄泄漏）。
  // 自有连接加 commandTimeout：Redis 半死（连上不回包）时释放命令快速失败而非无限阻塞。
  const ownsConnection = !options.redis;
  const redis: RedisLike =
    options.redis ??
    (new Redis(env.REDIS_URL, { commandTimeout: 5000 }) as unknown as RedisLike);

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

  let released = false;
  return {
    key,
    token,
    async release(): Promise<void> {
      if (released) return;
      released = true;
      try {
        await redis.eval(RELEASE_SCRIPT, 1, key, token);
      } finally {
        if (ownsConnection) (redis as unknown as Redis).disconnect();
      }
    },
  };
}
