/**
 * backfillPublishedAt 单元测试（published-at-inference 1.4 / 1.5 / 1.5b / 1.6 / 1.7）。
 *
 * 用注入的内存 RedisLike 桩 + 可配置 db 桩（仅实现本模块用到的 select/update 链），
 * mock generateObjectFn，**无需真实 DB / Redis / LLM key**。CAS 防覆盖、并发仅一次落值、
 * 超窗剪枝、单次上限等「真实 SQL 语义」断言由 backfill.integration.test.ts（真实库）承载；
 * 本套件聚焦**降级与控制流**：未抢锁跳过、Redis 异常降级、判不出保持 NULL、CAS DB 写异常降级、
 * 锁经 finally 释放不死锁、作用域谓词正确选择。
 *
 * backfill.js 间接 import env（启动期校验）。注入占位 env 后再动态 import（同 value-judge 范式）。
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { RedisLike } from '../../../push/lock.js';
import { env } from '../../../config/env.js';
import { DEFAULT_MAX_ATTEMPTS } from '../index.js';

let backfillPublishedAt: typeof import('../backfill.js').backfillPublishedAt;
let publishedAtInferLockKey: typeof import('../backfill.js').publishedAtInferLockKey;

beforeAll(async () => {
  process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
  process.env.REDIS_URL ||= 'redis://localhost:6379';
  process.env.LLM_API_KEY ||= 'test-key';
  process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
  process.env.LLM_BASE_URL ||= 'https://example.invalid/v1';
  process.env.TELEGRAM_BOT_TOKEN ||= 'test-bot-token';
  process.env.TELEGRAM_CHAT_ID ||= 'test-chat-id';
  process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph-token';
  const mod = await import('../backfill.js');
  backfillPublishedAt = mod.backfillPublishedAt;
  publishedAtInferLockKey = mod.publishedAtInferLockKey;
});

const NOW = new Date('2026-06-13T12:00:00Z');

interface FakeCandidate {
  eventId: string;
  title: string;
  canonicalUrl: string | null;
  content: string | null;
  source: string | null;
}

/**
 * 可配置 db 桩：select 链返回预置候选；update 链按注入的 updateImpl 决定 returning 行数（CAS 命中与否）
 * 或抛错（模拟 DB 写异常）。只实现本模块用到的链式方法，断言落在控制流（非真实 SQL 语义）。
 */
function fakeDb(args: {
  candidates: FakeCandidate[];
  updateImpl?: (eventId: string) => Promise<Array<{ eventId: string }>>;
  limitSpy?: (n: number) => void;
}) {
  const selectChain = {
    from: () => selectChain,
    innerJoin: () => selectChain,
    where: () => selectChain,
    orderBy: () => selectChain,
    limit: (n: number) => {
      args.limitSpy?.(n);
      return Promise.resolve(args.candidates);
    },
  };
  return {
    select: () => selectChain,
    update: () => {
      const capturedEventId = '';
      const updateChain = {
        set: () => updateChain,
        where: (cond: unknown) => {
          // backfill.ts 的 where 是 and(eq(eventId,...), ...)；这里无法解析 drizzle SQL，
          // 改由 updateImpl 通过 returning 时的闭包拿 eventId。为简化：把 eventId 从候选反查不可行，
          // 故 updateImpl 直接对「当前唯一在途事件」决策——见各用例只放一条候选或用顺序计数。
          void cond;
          return updateChain;
        },
        returning: () => {
          const impl =
            args.updateImpl ??
            (() => Promise.resolve([{ eventId: capturedEventId }]));
          return impl(capturedEventId);
        },
      };
      // 用一个外层包装在 set() 时记录 eventId 不可得（drizzle set 收的是列对象）。
      // 改：updateImpl 不依赖 eventId 时传空串即可（各用例据调用次数而非 id 决策）。
      void capturedEventId;
      return updateChain;
    },
  } as unknown as NonNullable<Parameters<typeof backfillPublishedAt>[0]['dbh']>;
}

/** 内存 Redis 桩：实现 SET NX PX 与「核对令牌再删」eval 语义（同 alert-lock.test.ts）。 */
function memoryRedis(): RedisLike & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    set(key, value, _mode, _ttl, _nx) {
      if (store.has(key)) return Promise.resolve(null);
      store.set(key, value);
      return Promise.resolve('OK');
    },
    eval(_script, _numKeys, key, token) {
      if (store.get(String(key)) === String(token)) {
        store.delete(String(key));
        return Promise.resolve(1);
      }
      return Promise.resolve(0);
    },
  };
}

/** 捕获型 Redis 桩：同 memoryRedis 的 SET NX / eval 语义，额外记录最近一次 set 收到的 PX(ttlMs)。 */
function capturingRedis(): RedisLike & { lastTtlMs: number | undefined } {
  const store = new Map<string, string>();
  const self = {
    lastTtlMs: undefined as number | undefined,
    set(key, value, _mode, ttl, _nx) {
      self.lastTtlMs = ttl;
      if (store.has(key)) return Promise.resolve(null);
      store.set(key, value);
      return Promise.resolve('OK');
    },
    eval(_script, _numKeys, key, token) {
      if (store.get(String(key)) === String(token)) {
        store.delete(String(key));
        return Promise.resolve(1);
      }
      return Promise.resolve(0);
    },
  } satisfies RedisLike & { lastTtlMs: number | undefined };
  return self;
}

const ONE_CANDIDATE: FakeCandidate[] = [
  {
    eventId: 'evt-1',
    title: 'Introducing ChatGPT',
    canonicalUrl: 'https://openai.com/blog/chatgpt',
    content: null,
    source: 'openai_blog',
  },
];

describe('publishedAtInferLockKey', () => {
  it('锁键为 published-at-infer:{event_id}（与告警锁 alert:{event_id} 区分开）', () => {
    expect(publishedAtInferLockKey('evt-1')).toBe('published-at-infer:evt-1');
    expect(publishedAtInferLockKey('evt-1')).not.toBe('alert:evt-1');
  });
});

describe('backfillPublishedAt 降级与控制流（mock db / redis / LLM）', () => {
  it('推断成功 + CAS 命中 → backfilled=1', async () => {
    const generateObjectFn = vi
      .fn()
      .mockResolvedValue({ object: { publishedAt: '2022-11-30T00:00:00Z' } });
    const dbh = fakeDb({
      candidates: ONE_CANDIDATE,
      updateImpl: () => Promise.resolve([{ eventId: 'evt-1' }]),
    });
    const result = await backfillPublishedAt({
      scope: { kind: 'daily' },
      windowDays: 3,
      now: NOW,
      dbh,
      infer: { generateObjectFn, logError: () => {} },
      lock: { redis: memoryRedis() },
      logError: () => {},
    });
    expect(result.backfilled).toBe(1);
    expect(result.attempted).toBe(1);
    expect(result.undetermined).toBe(0);
    expect(result.failed).toBe(0);
  });

  it('AI 判不出（推断 null）→ undetermined=1，不调 update（保持 NULL，不臆造）', async () => {
    const generateObjectFn = vi
      .fn()
      .mockResolvedValue({ object: { publishedAt: null } });
    const updateImpl = vi.fn(() => Promise.resolve([{ eventId: 'evt-1' }]));
    const dbh = fakeDb({ candidates: ONE_CANDIDATE, updateImpl });
    const result = await backfillPublishedAt({
      scope: { kind: 'daily' },
      windowDays: 3,
      now: NOW,
      dbh,
      infer: { generateObjectFn, logError: () => {} },
      lock: { redis: memoryRedis() },
      logError: () => {},
    });
    expect(result.undetermined).toBe(1);
    expect(result.backfilled).toBe(0);
    expect(updateImpl).not.toHaveBeenCalled();
  });

  it('CAS WHERE 未命中（已被另一链路先回填）→ undetermined（不计 backfilled、不报错）', async () => {
    const generateObjectFn = vi
      .fn()
      .mockResolvedValue({ object: { publishedAt: '2022-11-30T00:00:00Z' } });
    const dbh = fakeDb({
      candidates: ONE_CANDIDATE,
      updateImpl: () => Promise.resolve([]), // 0 行：WHERE published_at IS NULL 不命中。
    });
    const result = await backfillPublishedAt({
      scope: { kind: 'daily' },
      windowDays: 3,
      now: NOW,
      dbh,
      infer: { generateObjectFn, logError: () => {} },
      lock: { redis: memoryRedis() },
      logError: () => {},
    });
    expect(result.backfilled).toBe(0);
    expect(result.undetermined).toBe(1);
    expect(result.failed).toBe(0);
  });

  it('CAS 的 DB 写异常 → failed（按未回填降级，不抛断）+ 记日志', async () => {
    const generateObjectFn = vi
      .fn()
      .mockResolvedValue({ object: { publishedAt: '2022-11-30T00:00:00Z' } });
    const dbh = fakeDb({
      candidates: ONE_CANDIDATE,
      updateImpl: () => Promise.reject(new Error('deadlock detected')),
    });
    const logError = vi.fn();
    // 关键：不抛（resolves），按 failed 降级。
    const result = await backfillPublishedAt({
      scope: { kind: 'daily' },
      windowDays: 3,
      now: NOW,
      dbh,
      infer: { generateObjectFn, logError: () => {} },
      lock: { redis: memoryRedis() },
      logError,
    });
    expect(result.failed).toBe(1);
    expect(result.backfilled).toBe(0);
    expect(logError).toHaveBeenCalled();
  });

  it('未抢到 Redis 锁 → skippedLocked，不调 LLM（CAS 兜底，不重复推断）', async () => {
    const redis = memoryRedis();
    // 预占锁键，使 backfill 的 SET NX 失败 → 返回 null → 跳过。
    redis.store.set(publishedAtInferLockKey('evt-1'), 'other-token');
    const generateObjectFn = vi.fn();
    const result = await backfillPublishedAt({
      scope: { kind: 'daily' },
      windowDays: 3,
      now: NOW,
      dbh: fakeDb({ candidates: ONE_CANDIDATE }),
      infer: { generateObjectFn, logError: () => {} },
      lock: { redis },
      logError: () => {},
    });
    expect(result.skippedLocked).toBe(1);
    expect(result.attempted).toBe(0);
    expect(generateObjectFn).not.toHaveBeenCalled();
  });

  it('Redis 自身异常（SET 抛）→ skippedLocked 降级、不抛断、记日志', async () => {
    const throwingRedis: RedisLike = {
      set: () => Promise.reject(new Error('redis connection lost')),
      eval: () => Promise.resolve(0),
    };
    const generateObjectFn = vi.fn();
    const logError = vi.fn();
    const result = await backfillPublishedAt({
      scope: { kind: 'daily' },
      windowDays: 3,
      now: NOW,
      dbh: fakeDb({ candidates: ONE_CANDIDATE }),
      infer: { generateObjectFn, logError: () => {} },
      lock: { redis: throwingRedis },
      logError,
    });
    // 关键：不抛（resolves），按 skippedLocked 降级 + 记日志。
    expect(result.skippedLocked).toBe(1);
    expect(result.attempted).toBe(0);
    expect(generateObjectFn).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalled();
  });

  it('抢到锁的事件在 finally 释放锁（不死锁）：跑完后该锁键可再抢', async () => {
    const redis = memoryRedis();
    const generateObjectFn = vi
      .fn()
      .mockResolvedValue({ object: { publishedAt: '2022-11-30T00:00:00Z' } });
    await backfillPublishedAt({
      scope: { kind: 'daily' },
      windowDays: 3,
      now: NOW,
      dbh: fakeDb({
        candidates: ONE_CANDIDATE,
        updateImpl: () => Promise.resolve([{ eventId: 'evt-1' }]),
      }),
      infer: { generateObjectFn, logError: () => {} },
      lock: { redis },
      logError: () => {},
    });
    // finally 已 release：锁键被删，store 不应残留该键（不死锁）。
    expect(redis.store.has(publishedAtInferLockKey('evt-1'))).toBe(false);
  });

  it('推断锁 TTL 覆盖最坏推断 + CAS 写（不传 ttlMs 走默认计算）', async () => {
    const redis = capturingRedis();
    const generateObjectFn = vi
      .fn()
      .mockResolvedValue({ object: { publishedAt: '2022-11-30T00:00:00Z' } });
    await backfillPublishedAt({
      scope: { kind: 'daily' },
      windowDays: 3,
      now: NOW,
      dbh: fakeDb({
        candidates: ONE_CANDIDATE,
        updateImpl: () => Promise.resolve([{ eventId: 'evt-1' }]),
      }),
      infer: { generateObjectFn, logError: () => {} },
      lock: { redis },
      logError: () => {},
    });
    // 锁 TTL 必须 >= 最坏推断时长（maxAttempts × LLM_TIMEOUT_MS），不可退化到告警锁短 TTL。
    expect(redis.lastTtlMs).toBeGreaterThanOrEqual(
      env.LLM_TIMEOUT_MS * DEFAULT_MAX_ATTEMPTS,
    );
  });

  it('注入 options.lock.ttlMs 优先（覆盖默认计算）', async () => {
    const redis = capturingRedis();
    const generateObjectFn = vi
      .fn()
      .mockResolvedValue({ object: { publishedAt: '2022-11-30T00:00:00Z' } });
    await backfillPublishedAt({
      scope: { kind: 'daily' },
      windowDays: 3,
      now: NOW,
      dbh: fakeDb({
        candidates: ONE_CANDIDATE,
        updateImpl: () => Promise.resolve([{ eventId: 'evt-1' }]),
      }),
      infer: { generateObjectFn, logError: () => {} },
      lock: { redis, ttlMs: 999 },
      logError: () => {},
    });
    expect(redis.lastTtlMs).toBe(999);
  });

  it('单次上限传入 LIMIT（成本闸）：limit 收到 maxPerRun', async () => {
    const limitSpy = vi.fn();
    const generateObjectFn = vi
      .fn()
      .mockResolvedValue({ object: { publishedAt: null } });
    await backfillPublishedAt({
      scope: { kind: 'daily' },
      windowDays: 3,
      now: NOW,
      maxPerRun: 7,
      dbh: fakeDb({ candidates: [], limitSpy }),
      infer: { generateObjectFn, logError: () => {} },
      lock: { redis: memoryRedis() },
      logError: () => {},
    });
    expect(limitSpy).toHaveBeenCalledWith(7);
  });
});
