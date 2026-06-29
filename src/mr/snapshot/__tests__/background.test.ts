/**
 * 服务进程后台刷新生命周期 + 自激守卫纯单测（tasks 4.5 / 4.6，design D2/D4，fake timer + 模块 spy）。
 * 不触真 Redis/DB：mock `../invalidation.js`（subscriber/publisher）+ `../cache.js`（rebuild/invalidate）为 spy。
 *
 * - 4.5 优雅关闭：`stop()` 清 interval（timer 不再触发 rebuild）+ subscriber `quit()` 被调 + quit reject 被 catch（不抛）。
 * - 4.6 自激守卫（F7 防回归）：周期 rebuild tick 调非 publish 的 `rebuildModelRadarSnapshot(undefined, Date)`，
 *   `publishSnapshotInvalidation` 调用数 = 0；且 subscriber 回调走 `invalidateModelRadarSnapshot`、不 publish。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
process.env.TELEGRAM_CHAT_ID ||= 'test-chat';
process.env.LLM_API_KEY ||= 'test-key';
process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph-token';

vi.mock('../cache.js', () => ({
  rebuildModelRadarSnapshot: vi.fn(async () => ({ snapshot: { plans: [] }, version: 'v-test' })),
  invalidateModelRadarSnapshot: vi.fn(),
}));

vi.mock('../invalidation.js', () => ({
  createSnapshotInvalidationSubscriber: vi.fn(() => ({ quit: vi.fn(async () => {}) })),
  publishSnapshotInvalidation: vi.fn(async () => {}),
  SNAPSHOT_INVALIDATION_CHANNEL: 'mr:snapshot:invalidate',
}));

const { startSnapshotBackgroundRefresh } = await import('../background.js');
const { rebuildModelRadarSnapshot, invalidateModelRadarSnapshot } = await import('../cache.js');
const { createSnapshotInvalidationSubscriber, publishSnapshotInvalidation } = await import(
  '../invalidation.js'
);

const rebuildSpy = vi.mocked(rebuildModelRadarSnapshot);
const invalidateSpy = vi.mocked(invalidateModelRadarSnapshot);
const createSubSpy = vi.mocked(createSnapshotInvalidationSubscriber);
const publishSpy = vi.mocked(publishSnapshotInvalidation);

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('4.5 生命周期：优雅关闭清 interval + quit subscriber', () => {
  it('stop() 调 clearInterval（timer 不再触发 rebuild）+ subscriber quit 被调 + quit reject 被 catch', async () => {
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    // subscriber.quit reject → 须被 stop() 的 .catch() 吞掉、不成 unhandledRejection。
    const failingQuit = vi.fn(async () => {
      throw new Error('redis 挂时 quit reject');
    });
    createSubSpy.mockReturnValueOnce({ quit: failingQuit });

    const handle = startSnapshotBackgroundRefresh(1000);
    await expect(handle.stop()).resolves.toBeUndefined(); // quit reject 被 catch、stop 不抛
    expect(failingQuit).toHaveBeenCalledTimes(1);
    expect(clearSpy).toHaveBeenCalled();

    // interval 已清：再推进时间也不触发周期 rebuild（句柄不泄漏）。
    rebuildSpy.mockClear();
    vi.advanceTimersByTime(10_000);
    expect(rebuildSpy).not.toHaveBeenCalled();
  });
});

describe('4.6 自激守卫（F7）：周期 rebuild 不自 publish', () => {
  it('每 tick 调非 publish 的 rebuildModelRadarSnapshot(undefined, Date)，publish 调用数 = 0', async () => {
    const handle = startSnapshotBackgroundRefresh(1000);
    expect(rebuildSpy).not.toHaveBeenCalled(); // 尚未到间隔

    vi.advanceTimersByTime(1000);
    expect(rebuildSpy).toHaveBeenCalledTimes(1);
    // 周期 rebuild 用默认 db（undefined）+ 注入推进的 now（Date 实例），驱动 staleness 阈值穿越。
    expect(rebuildSpy).toHaveBeenCalledWith(undefined, expect.any(Date));
    // 承重不变量：周期 rebuild 路径绝不 publish（否则自 publish→自订阅→冷重建 thrash）。
    expect(publishSpy).not.toHaveBeenCalled();

    await handle.stop();
  });

  it('subscriber 回调走 invalidateModelRadarSnapshot、不 publish', async () => {
    const handle = startSnapshotBackgroundRefresh(1000);
    const onInvalidate = createSubSpy.mock.calls[0]![0];
    onInvalidate();
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
    expect(publishSpy).not.toHaveBeenCalled();
    await handle.stop();
  });
});
