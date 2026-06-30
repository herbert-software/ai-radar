/**
 * Model Radar（P5 / 5c，add-model-radar-compare-api）进程内只读快照缓存 + 版本/ETag（task 5.1/5.2，design D2/D8）。
 *
 * 职责（**只管缓存与版本，不含 rebuild job body**——那在 ./rebuild.ts）：
 * - 进程内单例缓存 `{ snapshot, version }`；冷启动从 DB 构建、手动 invalidate/rebuild。
 * - **唯一公开 version/ETag 源 = 快照内容哈希**（方案①，design D8）：canonical 序列化（对象键排序 +
 *   数组/行序固定，行序由 build.ts 各表 ORDER BY id 保证）后 sha256。
 *
 * ETag = **服务表征的纯函数**（design D1/D8 哈希内容契约）：
 * - 哈希输入 = 组 B DTO（`ModelRadarSnapshot`）的全部服务表征字段，**含离散 `freshness.stale`**（由注入 now 算）
 *   **与 per-fact 日粒度 `lastCheckedDate`**（= `trunc_UTC(该行 last_checked)`、5d-B/design D1）；DTO 本身**不含**
 *   `builtAt`/`version`/raw 秒级 `last_checked`/now 派生连续量，故「排除构建时刻 / now 连续量 / raw 秒级 last_checked」
 *   对 hash 与 served 同时成立、无 served-vs-hash 错配。`lastCheckedDate` 进哈希但因按固定 UTC 截断、**完全 now 无关**
 *   → now 推进（即便跨 UTC 午夜）不改它、哈希仍稳定，仅该行被重核**写**到新 UTC 日才变。
 * - `version` == 该哈希，是从 canonical 服务表征派生的**传输别名**，包在响应外层（组 E）、**不入哈希输入**
 *   （DTO 无 version 字段，天然无自引用）。
 * - `mr_catalog_version`/`builtAt` 纯内部、**绝不进服务表征、不作公开 version 源**；5c 不引入「bump
 *   mr_catalog_version 作公开 version」备选；GET 路径只读、绝不写库（rebuild 写的是进程内缓存、非 mr_*）。
 *
 * 由此：① 同一注入 now、无服务表征变化 → 哈希稳定、304 命中、不过度失效；② now 跨 staleness 阈值 →
 * `stale` 翻转 → 服务表征变 → 哈希变（客户端不会拿到 304-with-stale）；③ 仅推 raw last_checked、**未翻 stale
 * 且未跨其 UTC 日界**的写不改服务表征 → 哈希可不变；若推到**新 UTC 日**则其 `lastCheckedDate` 变 → 哈希变。
 *
 * **fail-closed**（task 5.4 / spec「schema 校验失败不对外服务且不覆盖旧快照」）：rebuild = 先 build（可抛）
 * 再原子替换——build 抛错则替换不发生、旧快照保留、错误上抛。冷启动首建失败同样上抛（供组 E API 接 503）、
 * 不缓存坏快照。
 *
 * **后续扩展口**（design D2，5c 不实现）：当前是进程内单 blob；Redis key / pub-sub / CDN/R2 写出后续接入——
 * 本模块只暴露 `rebuild`/`get`/`invalidate`/`peek` 抽象，下游不耦合「内存」实现细节。跨进程失效随 5d 接线。
 */
import { createHash } from 'node:crypto';
import { db as defaultDb } from '../../db/index.js';
import { env } from '../../config/env.js';
import { buildModelRadarSnapshot } from './build.js';
import type { ModelRadarSnapshot } from './dto.js';

/** db 句柄类型（drizzle 实例或事务），对齐 build.ts。 */
type DbLike = typeof defaultDb;

/**
 * 快照构建函数签名（默认真 builder；测试注入桩验缓存语义，不触 DB）。
 * `thresholdDays` 由 cache 显式喂（build.ts env-clean 后无默认，design D5）——cache 只在 app 进程跑、import env 无妨。
 */
export type SnapshotBuildFn = (
  dbh: DbLike,
  now: Date,
  thresholdDays: number,
) => Promise<ModelRadarSnapshot>;

/** 缓存条目：服务表征快照 + 其内容哈希（= 公开 version/ETag）。 */
export interface CachedSnapshot {
  snapshot: ModelRadarSnapshot;
  /** 内容哈希（sha256 hex）；作公开 version/ETag 的传输别名，不入哈希输入。 */
  version: string;
}

/** 进程内单例缓存（5c 单 blob；跨进程失效随 5d 接线）。 */
let cached: CachedSnapshot | undefined;

/** 进行中的 rebuild（去重并发：冷启动 thundering-herd + 跨阈值 now-race 共享同一次 build）。 */
let inFlight: Promise<CachedSnapshot> | undefined;

/**
 * canonical 序列化：递归**排序对象键**（数组/行序由调用方保证 = build.ts ORDER BY id），
 * 使内容哈希与字段书写顺序解耦（build.ts 重排字段不致哈希漂移，spec「canonical 既排序对象键也固定数组/行序」）。
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * 计算快照内容哈希（= 公开 version/ETag）。纯函数：仅依赖 `snapshot` 的服务表征字段。
 * 同一服务表征 → 同哈希（304 稳定）；任一服务表征字段变（含 `stale` 翻转）→ 哈希变（失效）。
 */
export function computeSnapshotVersion(snapshot: ModelRadarSnapshot): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(snapshot)), 'utf8')
    .digest('hex');
}

/**
 * 构建并**原子替换**缓存（手动 rebuild / 冷启动共用）。
 *
 * **fail-closed**：先 `buildFn`（可抛——schema 校验失败/撕裂/连接错）再算 version 再替换；任一步抛错则
 * 缓存**不被覆盖**（旧快照保留）、错误上抛。成功返回新 `{ snapshot, version }`。
 *
 * @param dbh   db 句柄（注入隔离实例/测试桩）。
 * @param now   参考时刻（**可注入**：staleness 阈值穿越靠它驱动 `stale` 翻转）。
 * @param buildFn 构建函数（默认真 builder；测试注入桩）。
 */
export async function rebuildModelRadarSnapshot(
  dbh: DbLike = defaultDb,
  now: Date = new Date(),
  buildFn: SnapshotBuildFn = buildModelRadarSnapshot,
): Promise<CachedSnapshot> {
  // 并发去重：已有进行中的 rebuild 直接复用（N 并发只 build 1 次、拿同一 version）。
  if (inFlight) return inFlight;
  // 先 build（可抛）；抛错时不执行替换 → cached 不变（fail-closed，不覆盖旧快照）。finally 清空 inFlight 使下次可重试。
  inFlight = (async () => {
    // 显式喂 staleness 阈值（build.ts env-clean 后必填、无默认）：与排程/MCP 同口径 `MR_STALENESS_THRESHOLD_DAYS`。
    const snapshot = await buildFn(dbh, now, env.MR_STALENESS_THRESHOLD_DAYS);
    const version = computeSnapshotVersion(snapshot);
    cached = { snapshot, version };
    return cached;
  })();
  try {
    return await inFlight;
  } finally {
    inFlight = undefined;
  }
}

/**
 * 取缓存快照；**冷启动**（缓存空）时从 DB 构建一次并缓存（请求路径只读 SELECT、无写）。
 * 冷启动首建失败时上抛（不缓存坏快照）——组 E API 接此抛错返回 503。
 */
export async function getModelRadarSnapshot(
  dbh: DbLike = defaultDb,
  now: Date = new Date(),
  buildFn: SnapshotBuildFn = buildModelRadarSnapshot,
): Promise<CachedSnapshot> {
  if (cached) return cached;
  // 冷启动：build 失败上抛、不缓存（fail-closed）。warm 后再读直接命中、不触 DB。
  return rebuildModelRadarSnapshot(dbh, now, buildFn);
}

/** 手动失效：清空缓存，下次 `getModelRadarSnapshot` 冷启动重建。 */
export function invalidateModelRadarSnapshot(): void {
  cached = undefined;
}

/** 只读窥视当前缓存（不触发构建）；测试/可观测用，未 warm 时为 undefined。 */
export function peekCachedSnapshot(): CachedSnapshot | undefined {
  return cached;
}
