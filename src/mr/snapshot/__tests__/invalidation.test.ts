/**
 * 快照跨进程失效 pub/sub 纯单测（tasks 4.1 / 4.7 / 4.9，design D4）。**绝不触真 Redis**：
 * 全程 `vi.mock('ioredis')` 假实现（本仓测试自动加载 .env、含生产 Redis 凭据，直连即触红线）。
 *
 * - 4.1 subscriber 收到 channel 消息 → onInvalidate 被调；publish 桩抛错 → 不抛、仅记日志、不阻塞调用方。
 * - 4.7 publisher 短连接「连/发/拆」序列：`connect` 先于 `publish`、`disconnect` 后于 `publish`（无常驻句柄）。
 * - 4.9 subscriber 保持自动重连（M1 防回归）：连接配置不含 `retryStrategy:()=>null`/`lazyConnect`/
 *   `enableOfflineQueue:false`；与 publisher 的探针式不重连配置形成对比。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
process.env.TELEGRAM_CHAT_ID ||= 'test-chat';
process.env.LLM_API_KEY ||= 'test-key';
process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph-token';

// hoisted 状态：记录所有 FakeRedis 实例 + 控制下一次 connect/publish 是否抛错（模拟 Redis-down）。
const { redisInstances, ctrl } = vi.hoisted(() => ({
  redisInstances: [] as FakeRedisLike[],
  ctrl: { failMode: 'none' as 'none' | 'connect' | 'publish' },
}));

interface FakeRedisLike {
  opts: Record<string, unknown>;
  connect: ReturnType<typeof vi.fn>;
  publish: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  quit: ReturnType<typeof vi.fn>;
  on(ev: string, h: (...a: unknown[]) => void): FakeRedisLike;
  emit(ev: string, ...a: unknown[]): void;
}

vi.mock('ioredis', () => {
  class FakeRedis {
    opts: Record<string, unknown>;
    handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
    connect = vi.fn(async () => {
      if (ctrl.failMode === 'connect') throw new Error('fake redis connect 失败');
    });
    publish = vi.fn(async () => {
      if (ctrl.failMode === 'publish') throw new Error('fake redis publish 失败');
      return 1;
    });
    subscribe = vi.fn(async () => 1);
    disconnect = vi.fn();
    quit = vi.fn(async () => 'OK');
    constructor(_url: string, opts?: Record<string, unknown>) {
      this.opts = opts ?? {};
      redisInstances.push(this as unknown as FakeRedisLike);
    }
    on(ev: string, h: (...a: unknown[]) => void) {
      (this.handlers[ev] ??= []).push(h);
      return this;
    }
    emit(ev: string, ...a: unknown[]) {
      (this.handlers[ev] ?? []).forEach((h) => h(...a));
    }
  }
  return { Redis: FakeRedis, default: FakeRedis };
});

const {
  publishSnapshotInvalidation,
  createSnapshotInvalidationSubscriber,
  SNAPSHOT_INVALIDATION_CHANNEL,
} = await import('../invalidation.js');

beforeEach(() => {
  redisInstances.length = 0;
  ctrl.failMode = 'none';
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('4.1 subscriber 收消息 → onInvalidate', () => {
  it('收到约定 channel 消息即调 onInvalidate；非本 channel 不调', async () => {
    const onInvalidate = vi.fn();
    const sub = createSnapshotInvalidationSubscriber(onInvalidate);
    const inst = redisInstances.at(-1)!;
    expect(inst.subscribe).toHaveBeenCalledWith(SNAPSHOT_INVALIDATION_CHANNEL);

    inst.emit('message', SNAPSHOT_INVALIDATION_CHANNEL);
    expect(onInvalidate).toHaveBeenCalledTimes(1);

    // 非本 channel 的消息不触发（channel-only）。
    inst.emit('message', 'some:other:channel');
    expect(onInvalidate).toHaveBeenCalledTimes(1);

    await sub.quit();
    expect(inst.quit).toHaveBeenCalledTimes(1);
  });
});

describe('4.1 publish 失败不阻塞调用方', () => {
  it('publish 桩抛错 → publishSnapshotInvalidation 不抛、resolve、仅 console.error、仍 disconnect', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    ctrl.failMode = 'publish';

    await expect(publishSnapshotInvalidation()).resolves.toBeUndefined();

    const inst = redisInstances.at(-1)!;
    expect(inst.publish).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalled(); // at-most-once 仅记日志
    expect(inst.disconnect).toHaveBeenCalledTimes(1); // finally 仍拆连接、不留常驻 socket
  });

  it('connect 桩抛错（Redis-down）→ 同样不抛、resolve、仍 disconnect', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    ctrl.failMode = 'connect';
    await expect(publishSnapshotInvalidation()).resolves.toBeUndefined();
    const inst = redisInstances.at(-1)!;
    expect(inst.disconnect).toHaveBeenCalledTimes(1);
  });
});

describe('4.7 publisher 短连接序列（不吊进程，B1）', () => {
  it('connect → publish → disconnect 有序；publish 发约定 channel；无常驻句柄', async () => {
    await publishSnapshotInvalidation();
    const inst = redisInstances.at(-1)!;
    expect(inst.connect).toHaveBeenCalledTimes(1);
    expect(inst.publish).toHaveBeenCalledWith(SNAPSHOT_INVALIDATION_CHANNEL, '1');
    expect(inst.disconnect).toHaveBeenCalledTimes(1);

    const c = inst.connect.mock.invocationCallOrder[0]!;
    const p = inst.publish.mock.invocationCallOrder[0]!;
    const d = inst.disconnect.mock.invocationCallOrder[0]!;
    expect(c).toBeLessThan(p); // 显式 connect 先于 publish（enableOfflineQueue:false 下不可裸 publish）
    expect(p).toBeLessThan(d); // disconnect 在 publish 之后（连/发/拆，不留 socket）
  });
});

describe('4.9 subscriber 保持自动重连守卫（M1 防回归）', () => {
  it('subscriber 连接配置不含探针式不重连项；publisher 反之保留探针式短连接配置', async () => {
    const sub = createSnapshotInvalidationSubscriber(vi.fn());
    const subInst = redisInstances.at(-1)!;
    // 保留 ioredis 默认自动重连：禁 retryStrategy:()=>null / lazyConnect / enableOfflineQueue:false。
    expect(subInst.opts.retryStrategy).toBeUndefined();
    expect(subInst.opts.lazyConnect).toBeUndefined();
    expect(subInst.opts.enableOfflineQueue).not.toBe(false);
    // V2 守卫：maxRetriesPerRequest:null 让冷启动首个 SUBSCRIBE 不被 flush（否则永不进订阅集 → 永久静默失活）。
    expect(subInst.opts.maxRetriesPerRequest).toBeNull();
    await sub.quit();

    // 对照：publisher 是一次性探针短连接，故意不重连。
    await publishSnapshotInvalidation();
    const pubInst = redisInstances.at(-1)!;
    expect(typeof pubInst.opts.retryStrategy).toBe('function');
    expect((pubInst.opts.retryStrategy as () => unknown)()).toBeNull();
    expect(pubInst.opts.lazyConnect).toBe(true);
    expect(pubInst.opts.enableOfflineQueue).toBe(false);
    // V1 守卫：commandTimeout 兜 connectTimeout 漏掉的「半开」情形（半死不回包时命令快速失败，不无限吊住 post-commit publish）。
    // 断言「存在且 ≤1s」（契约 spec/design 只承诺 ≤1s）——非空 = 未设则 undefined 落空、过大则越界，合规重调不误红。
    expect(pubInst.opts.commandTimeout).toBeGreaterThan(0);
    expect(pubInst.opts.commandTimeout).toBeLessThanOrEqual(1000);
  });
});
