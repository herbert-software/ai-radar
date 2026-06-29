## 为什么

5c 的 Model Radar 快照缓存是**每进程内存单例**（`src/mr/snapshot/cache.ts`），rebuild 钩子在「调用 `recordPriceChange`/`upsertPlan` 的那个进程」刷新。但 3 进程拓扑下——HTTP server（`src/index.ts`，持缓存、服务 `/model-radar/*`）/ worker（`src/pipeline/worker-main.ts` 链4/链6 写 `mr_review_flag`/staleness）/ 一次性脚本（seed/策展改价）——**服务页面的 HTTP server 进程对其它进程的写一无所知**，要到进程重启才可见。此外 `freshness.stale` 是烤进内容哈希的 now 派生离散量，**没有任何写能驱动它翻转**，只有「推进 now 再 build」才行 → 不周期 rebuild 则陈旧态永不更新。这是 5d Web 比价页正确性的地基（5d-A），须先落。

## 变更内容

- **跨进程失效通道（Redis pub/sub，仅通道不存 blob）**：经 `runSnapshotRebuild` 的写方（改价/seed/策展，均在最外层事务**提交后**调）`publish` 一条失效消息；HTTP server 进程 `subscribe` 后调既有 `invalidateModelRadarSnapshot()`，下次读冷启动 build-from-DB。**publisher 短连接「连/发/拆」**（不留常驻 socket 吊住一次性 seed 进程的事件循环）；**subscriber 长连接保持自动重连 + 重连后 re-SUBSCRIBE**（不拷贝探针的不重连配置，否则抖一次即永久失活）。
- **HTTP server 进程内周期 rebuild**（`setInterval`，非 BullMQ 链）：按 `MR_SNAPSHOT_REBUILD_INTERVAL_MS` 周期以「推进的 now」调**非 publish 的** `rebuildModelRadarSnapshot` 重建——驱动 `stale` 阈值穿越翻转、作 pub/sub 漏消息的自愈网，并令**不走 publish 的 flag/staleness 日级写**在一个间隔内可见。
- **接线进 `src/index.ts`**：HTTP server 启动时建 subscriber + 周期 rebuild 定时器（`.unref()`）；优雅关闭时清定时器 + best-effort `quit()`（包 `.catch()`）subscriber 连接。
- **写方接线（提交后、不在事务内）**：在 `runSnapshotRebuild`（已是 post-commit 边界）内**无条件**追加 `publish`；**严禁**塞进事务内被调的 `setReviewFlag`/任何 `TxLike` 函数（提交前 publish→脏快照回灌）。flag/staleness 日级 cron 写**不 publish**，可见性走周期 rebuild。
- 新增 env：`MR_SNAPSHOT_REBUILD_INTERVAL_MS`（周期 rebuild 间隔，`_MS`/setInterval 而非 `_CRON`）+ pub/sub channel 常量。

### 非目标

- **不存快照 Redis blob**：DB 是唯一 SOT；Redis 只当 pub/sub 通道。复用 5c 内容哈希 version 的「免协调一致性」（任意进程从同一 DB 状态 build 出逐字节相同快照 → 相同 version），无需共享存储。
- **不把 DB 移出读路径**、不做 CDN/R2/边缘缓存（数据极小：满 seed ~14 plan、几 KB、build ~58ms；实测有压再议）。
- **不做保证投递 / exactly-once / outbox / 持久失效队列**：契约 = at-most-once pub/sub + 周期 rebuild 兜底。
- **不动 5c 契约**：fail-closed、内容哈希 version、ETag、「请求路径只读不写库」原样保留（周期 rebuild/订阅写的是进程内缓存，非 `mr_*`）。
- 不为 HTTP server 多副本水平扩展做设计（今单副本；内容哈希 version 已保证多副本独立 build 收敛同 version）。
- 不做 Web 页面（5d-B）、不做 browser/egress 生产启用与桶2 真价策展（5d-C）。

## 功能 (Capabilities)

### 新增功能
（无）

### 修改功能
- `model-radar-compare-api`: 追加快照跨进程失效 + 服务进程周期 rebuild 的需求（5c 的「快照版本与 ETag」「请求路径只读」之上叠加跨进程一致性与 stale 翻转驱动）。

## 影响

- 代码：新增 `src/mr/snapshot/invalidation.ts`（短连接 publisher + 自动重连 subscriber，复用既有 `invalidate`/`rebuild`/`computeSnapshotVersion`，不新增 rebuild 函数）；接线 `src/index.ts`（subscriber + setInterval 调非 publish 的 `rebuildModelRadarSnapshot` + 优雅关闭）；`runSnapshotRebuild` 提交后无条件追加 publish；`src/config/env.ts` 加 `MR_SNAPSHOT_REBUILD_INTERVAL_MS`；更新 `rebuild.ts:14-20` 过时注释（被 D2 否决的链7 方案）。
- 运维：HTTP server 进程新增一条**长驻自动重连** Redis subscriber 连接 + 一个进程内定时器（`.unref()`）；写方 publisher 为**短连接「连/发/拆」**（不留常驻句柄）。Redis 不可用时降级（publish 失败仅记日志、周期 rebuild 不依赖 Redis、DB 兜读路径）。
- 不改 DB schema、不新增 BullMQ 链、不改既有 worker-main 链1-6；不动 `flag.ts`/`staleness.ts`（其可见性走周期 rebuild）。
- 测试：注入桩验「写方 publish→server invalidate→下次读重建」「周期 rebuild 推进 now→stale 翻转→version 变」「Redis 挂时周期 rebuild 仍自愈」「冷启动/fail-closed 不回归」+ 三守卫「周期 rebuild 不自 publish（防自激）」「publisher publish 后 disconnect（不吊进程）」「改价 publish 只在提交后、不在事务内」。
