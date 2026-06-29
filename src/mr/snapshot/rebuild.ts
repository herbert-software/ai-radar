/**
 * Model Radar（P5 / 5c，add-model-radar-compare-api）快照 rebuild job body（task 5.3/5.3b，design D8）。
 *
 * 交付**可直接调用的 rebuild job body** `runSnapshotRebuild`：注入 `now`（供 CI 断言陈旧/阈值穿越）、
 * 注入 `dbh`/`buildFn`，**never-throws**（内部 try/catch + 结构化结果），失败时旧快照保留（fail-closed
 * 由 cache 层 `rebuildModelRadarSnapshot` 的「先 build 再替换」保证）。
 *
 * 它既是「rebuild job 的纯函数体」，又被授权写编排边界**复用为提交后触发器**（design D8：价改耦合 rebuild
 * 经调用方触发、不需常驻 worker）——`recordPriceChange` / `upsertPlan` 委托改价路径在**最外层事务提交后**
 * `await runSnapshotRebuild({ dbh })`，覆盖全部 success outcome（recompute 必跑；ETag 是否变取决于服务表征
 * 是否真变，纯 noop-same-tuple 可不变）。seed/策展脚本末尾亦调本函数。
 *
 * **5d 已落地（跨进程一致性，add-model-radar-snapshot-cross-process-invalidation）**：
 * - **周期 rebuild = 服务进程（`src/index.ts`）的 `setInterval`**（间隔 `MR_SNAPSHOT_REBUILD_INTERVAL_MS`），
 *   **非 BullMQ 链7**（design D2 否决常驻 worker：刷 worker 内存没人服务）。它驱动 `freshness.stale` 随
 *   now 推进翻转、并令不走 publish 的 flag/staleness 日级 cron 写在一个间隔内可见。
 *   ⚠️ 周期 rebuild 调**不 publish 的 `rebuildModelRadarSnapshot`**（cache 层），**绝不**调本函数——
 *   否则服务进程每 tick 自 publish→自订阅 invalidate→冷重建 thrash（D2 承重不变量）。
 * - **跨进程失效 = 本函数提交后 `publishSnapshotInvalidation()`**（Redis pub/sub，design D4）：写方进程
 *   commit 后广播失效信号，HTTP server 订阅后各自 build-from-DB（内容哈希 version 免协调收敛）。
 *   at-most-once，漏的失效由上面周期 rebuild 兜底。
 */
import { db as defaultDb } from '../../db/index.js';
import {
  rebuildModelRadarSnapshot,
  type SnapshotBuildFn,
} from './cache.js';
import { publishSnapshotInvalidation } from './invalidation.js';

type DbLike = typeof defaultDb;

/** rebuild job 结果（可观测；never-throws，失败以 `ok:false` + error 表达，旧快照已保留）。 */
export interface SnapshotRebuildResult {
  ok: boolean;
  /** 成功时 = 新内容哈希（公开 version/ETag）；失败时 null。 */
  version: string | null;
  /** 成功时 = 快照 plan 数；失败时 null。 */
  planCount: number | null;
  /** 失败原因（成功时省略）。 */
  error?: string;
}

export interface RunSnapshotRebuildOptions {
  /** db 句柄（默认全局 db；测试/seed 注入隔离实例）。 */
  dbh?: DbLike;
  /** 参考时刻（默认当前；CI 注入以驱动 staleness 阈值穿越）。 */
  now?: Date;
  /** 构建函数（默认真 builder；测试注入桩）。 */
  buildFn?: SnapshotBuildFn;
  /** 跨进程失效 publish（默认真 publisher；测试注入桩，D4/3.1）。 */
  publish?: () => Promise<void>;
}

/**
 * rebuild job body —— 重建进程内快照缓存并刷新 version/ETag。**never-throws**。
 *
 * fail-closed：构建/校验失败时 cache 层不覆盖旧快照，本函数捕获后返回 `ok:false`、记日志，
 * **不把异常抛给调用方**（价改/seed 的成功路径不因 rebuild 失败而中断）。
 */
export async function runSnapshotRebuild(
  options: RunSnapshotRebuildOptions = {},
): Promise<SnapshotRebuildResult> {
  const dbh = options.dbh ?? defaultDb;
  const now = options.now ?? new Date();
  const publish = options.publish ?? publishSnapshotInvalidation;
  let result: SnapshotRebuildResult;
  try {
    const { snapshot, version } = await rebuildModelRadarSnapshot(
      dbh,
      now,
      options.buildFn,
    );
    result = { ok: true, version, planCount: snapshot.plans.length };
  } catch (err) {
    // fail-closed：旧快照已保留（cache 层「先 build 再替换」）；这里只记日志、返回失败结果，不上抛。
    const error = err instanceof Error ? err.message : String(err);
    console.error('[mr-snapshot] rebuild 失败（旧快照保留，不覆盖）：', error);
    result = { ok: false, version: null, planCount: null, error };
  }
  // 提交后无条件跨进程失效通知（design D4 / 3.1）：本函数只被最外层 db.transaction 提交后调用，
  // commit 已发生→peer 必须被通知，不论本进程 rebuild ok/fail。publish 自吞错且此处再防御性包 try/catch
  // （注入桩可能抛）——at-most-once，绝不影响 outcome。
  try {
    await publish();
  } catch (e) {
    console.error('[mr-snapshot] publish 失效通知失败（at-most-once，已忽略）：', e);
  }
  return result;
}
