## 上下文

5c 交付了 `src/mr/snapshot/cache.ts`：进程内单例缓存 `{snapshot, version}`、内容哈希 version、fail-closed rebuild、`invalidate`/`get`/`peek`/`rebuild` 四个 seam。5c 注释明写「跨进程失效随 5d 接线」。3 进程拓扑（HTTP server 持缓存服务页面 / worker 链1-6 写 flag·staleness / 一次性脚本改价）下，5c 缓存只对「写它自己的那个进程」一致。本变更（5d-A）补上跨进程一致性 + stale 翻转驱动，是 5d Web 页正确性的地基。决策依据见 `docs/model-radar-tech-plan.md`「5d 决策记录」。

## 目标 / 非目标

**目标：**
- HTTP server 进程的缓存能反映其它进程的写（经 Redis pub/sub 失效通知）。
- `freshness.stale` 随时间推进翻转（经服务进程内周期 rebuild）。
- 复用 5c 既有 seam（`invalidate`/`rebuild`/`computeSnapshotVersion`），新增面最小。

**非目标：**
- 不存快照 Redis blob、不把 DB 移出读路径、不 CDN/R2。
- 不做保证投递/exactly-once/outbox（at-most-once + 周期兜底）。
- 不动 5c fail-closed/内容哈希 version/ETag/「请求路径只读」契约。
- 不新增 BullMQ 链、不为多副本水平扩展设计、不做 Web 页/5d-C。

## 决策

### D1. Redis 仅作 pub/sub 通道，不存 blob（复用内容哈希的免协调一致性）

5c 的 `version = computeSnapshotVersion(snapshot)`（内容哈希）使**任意进程从同一 DB 状态独立 build 出逐字节相同的 snapshot → 相同 version**。这正是「共享 blob + 自增计数器」要靠共享存储才换来的一致性属性——5c 已白送。故 Redis 只需承载「失效消息」，各进程仍各自 build-from-DB。

替代：共享 Redis blob（写方 build→写 Redis+bump version；server 订阅→从 Redis 重载）。拒绝：失败模式严格更差（Redis 宕+server 冷启动→无副本可服务→503；blob 与 DB 第二事实源失谐；DTO 经 Redis JSON round-trip 须保证回灌后哈希逐字节一致）；唯一收益「读路径免 DB」被数据极小证伪（探针：~14 plan、几 KB、build ~58ms）。

### D2. 周期 rebuild 是 HTTP server 进程的 `setInterval`，不是 worker BullMQ 链

周期 rebuild 加进 worker 进程**无效**（刷 worker 内存、没人服务）。它属于**服务进程**（process 1 = `src/index.ts`），是进程内定时器。它非可选：`freshness.stale` 是烤进哈希的 now 派生离散量，无写能驱动翻转，只有「推进 now 再 build」才行。它顺带是 pub/sub 漏消息的自愈网，并令**不走 publish 的 flag/staleness 日级写**（改 `reviewStatus.pending`）在一个间隔内可见。

**承重不变量（周期 rebuild 必须用非 publish 的 cache fn）**：周期 rebuild 调 `rebuildModelRadarSnapshot`（cache 层、**不** publish），**绝不**调会 publish 的 `runSnapshotRebuild`，也**不得**把 publish 下沉进 cache 层——否则服务进程每 tick 自 publish→自订阅 invalidate→冷重建 thrash。「server 周期用不 publish 的那个、writer 用 publish 的那个」是承重却隐蔽的边界，须在 `cache.ts`/`rebuild.ts` 加守卫注释 + 测试断言（tasks 4.6）固化。

替代：把周期 rebuild 做成 worker 链7。拒绝：见上（跨进程无效）。

### D3. 失效语义 at-most-once + 周期兜底，不搭投递保证

写方 publish 失败仅记日志、非致命（不阻塞/不回滚写）。漏消息由 D2 周期 rebuild 在一个间隔内自愈。间隔（`MR_SNAPSHOT_REBUILD_INTERVAL_MS`）是「价改/staleness 可见延迟上界」校准旋钮——先分钟级（建议默认 5min），实测再收紧。

**已知 at-most-once 丢失路径（均 ≤ 一个间隔由周期 rebuild 收敛，与「漏消息自愈」同包络）**：① 订阅断连/Redis 抖动期 publish 漏失；② subscriber 收到消息走 `invalidate`（清缓存、惰性重建），若紧接的冷启动 build 又失败则 5c 既有「冷启动失败→503」生效——仅 DB 同时不可达的窄窗，503 诚实失败、绝不服务脏数据，刻意不改为 rebuild-on-receipt（那会引入 in-flight 复用陈旧 build + 需 db 句柄）；③ `cache.ts` 无 epoch，`invalidate` 落在某 in-flight rebuild 的 build 期内会被其完成赋值覆盖（缓存留陈旧）。三者皆刻意不加 epoch/去抖（YAGNI，数据极小、≤间隔自愈足够）。

替代：outbox/持久失效队列/exactly-once。拒绝：数据极小、最终一致秒~分钟级足够，投递保证是大数据集复杂度，YAGNI。

### D4. 接线点与连接（publisher 短连接 / subscriber 长连接，配置相反）

- **subscriber + 定时器**接进 `src/index.ts`（服务进程唯一入口），与既有 SIGINT/SIGTERM 优雅关闭同口径：关闭时 `clearInterval` + subscriber `quit()`（best-effort、包 `.catch()`，定时器 `.unref()`）。
- **pub/sub 模块**：新增 `src/mr/snapshot/invalidation.ts`，导出 `publishSnapshotInvalidation()`（写方调）+ `createSnapshotInvalidationSubscriber(onInvalidate)`（server 调）。channel 名常量 `mr:snapshot:invalidate`。两连接皆独立、**不复用 BullMQ 连接**，但**形态相反**：
  - **publisher = 短连接「连/发/拆」**（仿 `health/redis.ts` pingRedis：`enableOfflineQueue:false` + `maxRetriesPerRequest:1` + `retryStrategy:()=>null` + `lazyConnect:true` + 挂 'error' handler + **显式 `await connect()`→`publish()` 序列**（勿依赖 lazy 自连——`enableOfflineQueue:false` 下直接 `publish()` 会立即 reject「Stream isn't writeable」**即便 Redis 在线**，丢该条 happy-path）+ `catch` reject + `finally` `disconnect()`）。`connectTimeout`（≤1s，界 TCP 握手）**+ `commandTimeout`（≤1s，界 half-open 命令——仿 `alert-lock.ts:83`/`push-lock.ts:106`：Redis「连上不回包」时命令快速失败而非无限挂）共同 = 每次 post-commit publish 的阻塞上界（≤~2s）**；二者缺一则 half-open Redis 会令 `await publish()` 永不 settle、吊住 post-commit 路径（`connectTimeout` 不界已建连后的命令）。publish 被 await 以保证 `disconnect()` 在 seed 事件循环排空前发生。**绝不留常驻连接**——`runSnapshotRebuild` 在 5d-A 的运行时活跃调用者是 seed 进程（`seed-main.ts:29`，**末尾 1 次**；seed 占位价 NULL→`upsertPlan` 全走 `inserted` 分支、不触 `upsert.ts:376` 的 price-delegated rebuild，故 runSeed 期 0 次）；`recordPriceChange`/`upsert` price-delegated 是代码层 post-commit chokepoint，但 `recordPriceChange` 5d-A 无运行时触发（5d-C 策展才接）。seed **刻意不调 `process.exit`**（靠事件循环排空 flush stdout artifact）；常驻 publisher socket 会吊住其事件循环致永不退出，且默认 ioredis（`enableOfflineQueue`+无限 retry）在 Redis 挂时会静默入队、既不报错也不退出。短连接同时满足「publish 失败立即 reject→被 catch 记日志」（at-most-once 不阻塞写）。
  - **subscriber = 长连接保持自动重连**：用 ioredis **默认/退避 `retryStrategy`** + **必设 `maxRetriesPerRequest: null`**（同仓 BullMQ 长连约定，如 `queue.ts:40`/`staleness-queue.ts:34`）（**禁拷贝探针的 `retryStrategy:()=>null`/`lazyConnect`/`enableOfflineQueue:false`**——pingRedis 是一次性探针、故意不重连），依赖 ioredis 断线自动重连后**自动 re-SUBSCRIBE**（ioredis 内部维护订阅集自动重放，**仅重放成功订阅过的 channel**，无需手写 ready handler）。**`maxRetriesPerRequest:null` 是承重项**：默认 20 时，冷启动恰逢 Redis 宕的窄窗里首个 `SUBSCRIBE` 排进 offline queue，重试预算耗尽后被 `flushQueue`（默认含 offlineQueue）以 `MaxRetriesPerRequestError` 清掉、永不进订阅集 → 重连后无可重放 → channel 永久未订阅（直到重启）；设 `null` 则首订阅滞留 offline queue 直至连上、成功后才进订阅集、此后重放正常。挂 'error' handler 吞噪声。否则 Redis 抖一次即永久静默失活、pub/sub 退化 interval-only 无告警。
  - **post-commit 前置**：上述「publish 在提交后」依赖**公开 writer（`recordPriceChange`/`upsertPlan`）须以顶层 `db` 调、禁注入已开外层事务**——若以已开 tx 作 `dbh`，其内部 `db.transaction` 退化为 SAVEPOINT、`runSnapshotRebuild` 落在 savepoint 释放后但外层 commit 前，publish 先于真提交。当前全仓无此 caller（grep 证实）；将来若出现，peer build 读不到未提交数据→ ≤ 一个间隔由周期 rebuild 自愈。
- **写方触发点（提交后、不在事务内）**：publish 只加在 `runSnapshotRebuild` 内（它本就在最外层 `db.transaction` 提交后被 `recordPriceChange`(`:226`)/`upsert`(`:376`)/seed(`:29`) 调），**无条件触发**（不论本进程 rebuild ok/fail——commit 已发生，peer 必须被通知）。**严禁**把 publish 塞进 `setReviewFlag` 或任何接收 `TxLike` 的函数：`_recordPriceChangeTx`(`record-price-change.ts:203`) 在事务内调 `setReviewFlag`，事务内 publish→subscriber 立即失效→server 从未提交状态 build→脏快照回灌。**flag/staleness 日级 cron 写不经 `runSnapshotRebuild`、不 publish**，可见性走周期 rebuild（D2）。rebuild-in-writer-process 仍保留（刷写方自己缓存，无害），跨进程靠 publish；二者不冲突。
- **env**：`MR_SNAPSHOT_REBUILD_INTERVAL_MS`（`z.coerce.number().int().positive()`，默认 300_000）。刻意用 `_MS`/setInterval 而非既有 `MR_*_CRON`+`_CRON_TZ`（那是 BullMQ repeatable job 约定，D2 已否决 BullMQ 链）；与既有 `MR_SNAPSHOT_TTL_MS`（5b scrape 文件 TTL，无关）区分命名。**并随本变更更新 `rebuild.ts:14-20` 的 5c 过时注释**（它仍描述被 D2 否决的「常驻 worker 链7 四件套 + `MR_SNAPSHOT_REBUILD_ENABLED`」5d 装配方案）。

### D5. 可测性（注入时钟，不靠真等待）

周期 rebuild 的 body = 调 `rebuildModelRadarSnapshot(dbh, injectedNow)`（`index.ts` 接线用默认 db：`rebuildModelRadarSnapshot(undefined, new Date())`）；测试直接调该 body 注入 now（不靠 setInterval 真流逝）。pub/sub 失效测试用注入的 onInvalidate 回调断言「收到消息→调 invalidate」。Redis-down 用桩 publisher 抛错断言「写不受影响 + 周期 rebuild 仍刷新」。另三条守卫测试：① **自激守卫**——spy 断言周期 rebuild 路径调非 publish 的 `rebuildModelRadarSnapshot`、`publishSnapshotInvalidation` 调用数=0（防回归 thrash，tasks 4.6）；② **publisher 不吊进程**——spy `disconnect()` 在 publish 后被调（短连接序列，tasks 4.7）；③ **提交后才 publish**——`recordPriceChange` history-conflict 分支（事务内 `setReviewFlag`）下断言 publish 不在 tx 回调内被调（tasks 4.8）。

## 风险 / 权衡

- **pub/sub 漏消息**（订阅断连/Redis 抖动）→ 服务旧快照，由周期 rebuild 一个间隔内自愈（间隔可调）。
- **Redis 全挂** → publish 失败仅日志；周期 rebuild 纯 setInterval 不依赖 Redis；读路径 DB 兜底永远可服务。无单点致命。
- **间隔取值** → 太长则价改/陈旧可见延迟大、太短则 server 进程频繁 build（数据极小、成本低）。默认分钟级、实测调。
- **多副本 HTTP server**（未来）→ 每副本各自 subscribe + 各自周期 rebuild + 内容哈希 version 自动收敛同 version；本变更不为此额外设计，但不阻断。
- **rebuild-in-writer 与 publish 并存** → 写方进程既刷自己缓存又 publish，server 收 publish 再各自 build；无双写竞争（各进程独立缓存 + 内容哈希幂等）。
- **publisher 常驻连接吊住一次性进程**（B1）→ seed 等不调 `process.exit` 的脚本会被常驻 socket 卡到不退出；故 publisher 强制短连接「连/发/拆」+ `finally disconnect()`（D4）。
- **subscriber 永久静默失活**（M1）→ 若拷贝探针的不重连配置，Redis 抖一次后订阅永久死亡、pub/sub 退化 interval-only 无告警；故 subscriber 强制保持自动重连 + 重连后 re-SUBSCRIBE（D4）。
- **事务内 publish 致脏快照回灌**（B3）→ 若把 publish 塞进事务内被调的 `setReviewFlag`，提交前 publish→server 从未提交状态 build；故 publish 只在最外层提交后的 `runSnapshotRebuild` 边界、严禁入任何 `TxLike` 函数（D4 + tasks 4.8）。
- **服务进程自 publish 自激**（F7）→ 若周期 rebuild 误用会 publish 的 `runSnapshotRebuild`，每 tick 自 publish→自订阅 invalidate→冷重建 thrash；故周期 rebuild 强制用非 publish 的 `rebuildModelRadarSnapshot`（D2 承重不变量 + tasks 4.6 守卫）。
