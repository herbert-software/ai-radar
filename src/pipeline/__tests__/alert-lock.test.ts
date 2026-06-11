/**
 * acquireAlertLock 单测（realtime-alerts 独立单例锁 `alert:{channel}:{event_id}`）。
 * 用注入的内存 RedisLike 桩，无需真实 Redis。
 *
 * 覆盖：
 * - 锁键为 `alert:{channel}:{event_id}`（不含时间）。
 * - 首个实例 NX 获锁成功；并发第二实例 NX 失败返 null（不双发）。
 * - release 核对令牌后删键（幂等：重复 release 安全）。
 */
import { describe, expect, it, vi } from 'vitest';

process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
process.env.TELEGRAM_CHAT_ID ||= 'test-chat';
process.env.LLM_API_KEY ||= 'test-key';
process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph-token';

const { acquireAlertLock, alertLockKey } = await import('../alert-lock.js');
import type { RedisLike } from '../../push/lock.js';

/** 内存 Redis 桩：实现 SET NX PX 与「核对令牌再删」eval 语义。 */
function memoryRedis(): RedisLike & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    set(key, value, _mode, _ttl, _nx) {
      if (store.has(key)) return Promise.resolve(null); // NX：已存在则失败。
      store.set(key, value);
      return Promise.resolve('OK');
    },
    eval(_script, _numKeys, key, token) {
      // RELEASE_SCRIPT：get(key)==token 则 del 返 1，否则 0。
      if (store.get(String(key)) === String(token)) {
        store.delete(String(key));
        return Promise.resolve(1);
      }
      return Promise.resolve(0);
    },
  };
}

describe('acquireAlertLock 告警单例锁（per-event）', () => {
  it('锁键为 alert:{event_id}（per-event，不含通道/时间）', () => {
    expect(alertLockKey('evt-1')).toBe('alert:evt-1');
    expect(alertLockKey('evt-2')).toBe('alert:evt-2');
  });

  it('首个实例获锁成功；并发第二实例 NX 失败返 null（防双发）', async () => {
    const redis = memoryRedis();
    const lock1 = await acquireAlertLock('evt-A', { redis, ttlMs: 60_000 });
    expect(lock1).not.toBeNull();
    expect(lock1!.key).toBe('alert:evt-A');

    // 同一 event_id 第二实例并发获锁：NX 失败 → null（应跳过该告警事件，不重复发）。
    const lock2 = await acquireAlertLock('evt-A', { redis, ttlMs: 60_000 });
    expect(lock2).toBeNull();

    // 释放后可重新获取（failed 告警跨天重试的基础）。
    await lock1!.release();
    const lock3 = await acquireAlertLock('evt-A', { redis, ttlMs: 60_000 });
    expect(lock3).not.toBeNull();
    await lock3!.release();
  });

  it('不同 event_id 互不挤占（各自独立锁键）', async () => {
    const redis = memoryRedis();
    const a = await acquireAlertLock('evt-X', { redis });
    const b = await acquireAlertLock('evt-Y', { redis }); // 不同 event。
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    await a!.release();
    await b!.release();
  });

  it('release 幂等：重复调用安全、不抛错', async () => {
    const redis = memoryRedis();
    const evalSpy = vi.spyOn(redis, 'eval');
    const lock = await acquireAlertLock('evt-Z', { redis });
    await lock!.release();
    await lock!.release(); // 第二次 release 应无操作（不再 eval）。
    expect(evalSpy).toHaveBeenCalledTimes(1);
  });
});
