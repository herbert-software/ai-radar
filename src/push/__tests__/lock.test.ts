/**
 * acquireDigestLock 看门狗丢锁感知单测（Codex C3）：续租 Lua 返 0（令牌不匹配/键已不存在）
 * 时，锁句柄须把 isHeld() 从 true 翻成 false，让调用方在 dispatch 前据此中止，避免双发。
 * 用注入的内存 RedisLike 桩 + fake timers 驱动看门狗，无需真实 Redis。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireDigestLock, type RedisLike } from '../lock.js';

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** 可控返回值的 RedisLike 桩：set 永远成功获锁，eval 返回 evalResult。 */
function makeRedis(evalResult: number): RedisLike {
  return {
    set: () => Promise.resolve('OK'),
    eval: () => Promise.resolve(evalResult),
  };
}

describe('acquireDigestLock 丢锁感知', () => {
  it('续租 Lua 返 0（锁被抢占/过期）→ isHeld() 由 true 变 false 并停续租', async () => {
    const redis = makeRedis(0);
    const lock = await acquireDigestLock('2099-01-09', {
      redis,
      ttlMs: 30_000,
      renewIntervalMs: 100,
    });
    expect(lock).not.toBeNull();
    expect(lock!.isHeld()).toBe(true);

    // 推进到首次续租并让其 promise 落地。
    await vi.advanceTimersByTimeAsync(100);

    expect(lock!.isHeld()).toBe(false);
    await lock!.release();
  });

  it('续租 Lua 返 1（成功）→ isHeld() 保持 true', async () => {
    const redis = makeRedis(1);
    const lock = await acquireDigestLock('2099-01-10', {
      redis,
      ttlMs: 30_000,
      renewIntervalMs: 100,
    });
    expect(lock).not.toBeNull();

    await vi.advanceTimersByTimeAsync(100);

    expect(lock!.isHeld()).toBe(true);
    await lock!.release();
  });

  it('续租命令持续报错（非 Lua 返 0）→ 原 TTL 到期后 isHeld() 转 false，杜绝双发', async () => {
    // 续租命令一直抛错（如 Redis 半死 commandTimeout），从未成功续租：
    // TTL 窗口内保守不判丢锁，但越过原 TTL 截止点后必须转 false
    // （此刻 Redis 键已过期、他人可重获，自认持有即双发）。
    const redis: RedisLike = {
      set: () => Promise.resolve('OK'),
      eval: () => Promise.reject(new Error('ETIMEDOUT')),
    };
    const lock = await acquireDigestLock('2099-01-13', {
      redis,
      ttlMs: 30_000,
      renewIntervalMs: 10_000,
    });
    expect(lock!.isHeld()).toBe(true);

    // 首次续租（10s）报错：仍在 TTL 内，保守保持持有。
    await vi.advanceTimersByTimeAsync(10_000);
    expect(lock!.isHeld()).toBe(true);

    // 推进越过原 TTL（30s），期间续租始终报错、从未前推截止点 → 转 false。
    await vi.advanceTimersByTimeAsync(20_001);
    expect(lock!.isHeld()).toBe(false);
  });

  it('release 后 isHeld() 为 false', async () => {
    const redis = makeRedis(1);
    const lock = await acquireDigestLock('2099-01-11', {
      redis,
      ttlMs: 30_000,
      renewIntervalMs: 0,
    });
    expect(lock!.isHeld()).toBe(true);
    await lock!.release();
    expect(lock!.isHeld()).toBe(false);
  });
});
