## 新增需求

### 需求:快照跨进程失效（Redis pub/sub，仅通道不存 blob）

经 `runSnapshotRebuild` 的写方（改价 `recordPriceChange` / seed / 策展脚本——均在**最外层事务提交后**调 `runSnapshotRebuild`）在本进程 invalidate/rebuild 之外，必须经 Redis pub/sub `publish` 一条失效消息到约定 channel。服务快照的 HTTP server 进程必须 `subscribe` 该 channel，收到消息即调既有 `invalidateModelRadarSnapshot()`（下次读冷启动 build-from-DB）。**Redis 只作 pub/sub 通道，禁止把快照 blob 存入 Redis**（DB 是唯一 SOT；复用 5c 内容哈希 version 的免协调一致性）。失效语义为 **at-most-once**：publish 失败仅记日志、非致命（不阻塞写、不抛断写事务），漏消息由周期 rebuild 自愈；不实现保证投递 / exactly-once / outbox。

**publish 时机（务必提交后、务必不在事务内）**：publish 只允许在**最外层事务提交后的 run 边界**发出（即 `runSnapshotRebuild` 内——它本就在 `db.transaction` 提交后被调），**无条件触发**（不论本进程 rebuild ok/fail——commit 已发生，peer 必须被通知）；**绝不置于 `setReviewFlag` 或任何接收 `TxLike` 的函数内**——`_recordPriceChangeTx` 在事务内调 `setReviewFlag`，事务内 publish 会令 subscriber 立即失效、server 从**未提交**的 DB 状态 build-from-DB，把脏快照回灌缓存。

**连接形态（publisher 短连接 / subscriber 长连接，配置相反）**：
- **publisher** 用短连接「连/发/拆」（仿 `health/redis.ts` 的 pingRedis：`enableOfflineQueue:false` + `maxRetriesPerRequest:1` + `retryStrategy:()=>null` + `lazyConnect:true` + `connectTimeout`（≤1s，界握手）+ **`commandTimeout`（≤1s，界 half-open 命令——Redis 连上不回包时快速失败，仿 `alert-lock.ts`/`push-lock.ts`）** + **显式 `await connect()`→`publish()` 序列**（勿依赖 lazy 自连——`enableOfflineQueue:false` 下直接 `publish()` 会立即 reject「Stream isn't writeable」即便 Redis 在线）+ 'error' handler + catch reject + finally `disconnect()`；每写 publish 阻塞上界 = `connectTimeout`+`commandTimeout`（≤~2s）——只设 `connectTimeout` 则 half-open Redis 令 `await publish()` 永不 settle、吊住 post-commit 路径），**绝不留常驻连接**——一次性 seed/脚本进程靠事件循环排空自然退出（刻意不调 `process.exit`，避免截断 stdout artifact），常驻 socket 会吊住其事件循环致永不退出；短连接同时使「publish 失败立即 reject→被 catch 记日志」成立（默认 ioredis `enableOfflineQueue` 会静默入队、既不报错也不退出）。
- **subscriber** 反之必须**保持自动重连**（用 ioredis 默认/退避 `retryStrategy` + **`maxRetriesPerRequest: null`**（同仓 BullMQ 长连约定），**禁拷贝探针的 `retryStrategy:()=>null`/`lazyConnect`**——那是一次性探针、故意不重连），断线重连后**自动 re-SUBSCRIBE**（ioredis 仅重放成功订阅过的 channel），并挂 'error' handler 吞噪声；否则 Redis 抖一次即永久静默失活、pub/sub 退化 interval-only 无告警。**`maxRetriesPerRequest:null` 是承重项**——默认 20 时冷启动恰逢 Redis 宕的窄窗会 flush 掉首个未成功的 `SUBSCRIBE`、永不重订阅；设 `null` 则首订阅滞留 offline queue 直至连上。

**flag/staleness 不走 publish**：保鲜回路 flag/staleness 是**日级 cron**写（`MR_EVENT_REVIEW_CRON='23 8 * * *'` / `MR_STALENESS_CRON='43 9 * * *'`），只经 `setReviewFlag`、**不经 `runSnapshotRebuild`**，故**不 publish**；其对服务表征（`reviewStatus.pending` / `freshness.stale`）的变更由**周期 rebuild（≤ 一个间隔）**兜底可见——日级写叠秒级 publish 无意义。

#### 场景:跨进程写经 pub/sub 令服务进程失效
- **当** 经 `runSnapshotRebuild` 的写方（seed / 策展改价）在最外层事务提交后 publish 失效
- **那么** HTTP server 进程的 subscriber 收到后调 `invalidateModelRadarSnapshot()`，其下一次读 build-from-DB 反映该变更

#### 场景:publish 只在提交后、不在事务内
- **当** 改价经 `_recordPriceChangeTx` 在同事务内调 `setReviewFlag`（history-conflict 分支）
- **那么** publish **不**在该事务内发出，只在最外层 `db.transaction` 提交后的 `runSnapshotRebuild` 边界发出；server 绝不从未提交状态 build 出脏快照回灌缓存

#### 场景:publisher 短连接不吊住一次性进程
- **当** seed/一次性脚本 publish 失效后进入自然退出（不调 `process.exit`、靠事件循环排空 flush stdout artifact）
- **那么** publisher 短连接已 `disconnect()`、不留常驻 socket，进程正常退出，不被 publish 连接吊住

#### 场景:subscriber 断线自动重连并恢复订阅
- **当** Redis 抖动致 subscriber 断线后恢复
- **那么** subscriber 自动重连并 re-SUBSCRIBE，继续接收后续失效消息（不因一次抖动永久静默失活）

#### 场景:publish 失败不阻塞写
- **当** Redis 不可达导致 publish 抛错
- **那么** 写方经 'error' handler + catch 吞错、仅记日志，写本身照常成功提交，不因失效通知失败而回滚或崩溃

#### 场景:不存快照 blob 到 Redis
- **当** 检查跨进程失效实现
- **那么** Redis 仅承载失效消息（pub/sub），不存快照内容；DB 仍是唯一 SOT、仍在读路径作冷启动来源

### 需求:服务进程内周期 rebuild（驱动 stale 翻转 + 漏消息自愈 + flag/staleness 可见）

服务快照的 HTTP server 进程必须有一个**进程内周期 rebuild**（`setInterval`，**非 BullMQ 链**——周期 rebuild 在 worker 进程内刷新对服务进程无效），按 `MR_SNAPSHOT_REBUILD_INTERVAL_MS` 以**推进的 now** 调既有**非 publish 的** `rebuildModelRadarSnapshot`（**不是会 publish 的 `runSnapshotRebuild`**——否则服务进程每 tick 自 publish→自订阅失效→冷重建 thrash）。它有三个职责：① 驱动 `freshness.stale`（now 派生离散量，无任何写能翻转它）随 now 跨 staleness 阈值翻转；② 作 pub/sub 漏消息的自愈网（间隔即「价改可见延迟上界」）；③ 令**不走 publish 的 flag/staleness 日级写**（改 `reviewStatus.pending`）在一个间隔内可见。周期 rebuild **不依赖 Redis**（纯定时器）。rebuild 失败沿用 5c fail-closed（不覆盖旧快照、记日志），不使进程崩溃。

#### 场景:周期 rebuild 翻转 stale
- **当** 无任何 DB 写，但周期 rebuild 以推进后的 now 重建、跨过某事实/源的 staleness 阈值
- **那么** 该 plan 的 `freshness.stale` 翻为 true、内容哈希 version 变（下游不会拿到 304-with-stale）

#### 场景:周期 rebuild 自愈漏消息
- **当** 某次跨进程失效漏失（Redis 抖动 / 订阅断连 / in-flight rebuild 期 `invalidate` 被完成赋值覆盖）
- **那么** 服务进程在一个 rebuild 间隔内经周期 rebuild 反映该变更，不需进程重启

#### 场景:flag/staleness 写经周期 rebuild 可见
- **当** worker 日级 cron 经 `setReviewFlag` 打 review flag / staleness（不经 publish）
- **那么** 服务进程在一个 rebuild 间隔内经周期 rebuild 反映 `reviewStatus.pending` / `freshness.stale` 变化，不依赖 pub/sub

#### 场景:周期 rebuild 用非 publish 的 cache fn（不自激）
- **当** 服务进程周期 rebuild 触发
- **那么** 它调非 publish 的 `rebuildModelRadarSnapshot`、**不** publish 失效，故不产生「自 publish→自订阅 invalidate→冷重建」回环

#### 场景:Redis 全挂周期 rebuild 仍工作
- **当** Redis 不可用（pub/sub 通道断）
- **那么** 周期 rebuild 作为纯 setInterval 照常重建、读路径 DB 兜底仍可服务；不因 Redis 故障停止刷新

### 需求:服务进程订阅/定时器生命周期与只读不变量

HTTP server 进程启动时必须建立 subscriber 连接 + 周期 rebuild 定时器；优雅关闭（SIGINT/SIGTERM）时必须清除定时器并 quit subscriber 连接（不泄漏句柄、不阻塞退出）。`subscriber.quit()` 为 **best-effort**（须包 `.catch()` 防 Redis 挂时 quit reject 成 unhandledRejection；只读 subscriber 无未刷状态，被 `process.exit` 截断亦无害）；定时器须 `.unref()` 不阻塞退出。跨进程失效与周期 rebuild **不得违反 5c「请求路径只读」**：周期 rebuild / 订阅回调写的是**进程内缓存**（与 fail-closed 替换），**绝不写 `mr_*` 或既有表**，也不 bump `mr_catalog_version`（公开 version 仍唯一来自内容哈希）。

#### 场景:优雅关闭清理订阅与定时器
- **当** HTTP server 收到 SIGINT/SIGTERM
- **那么** 周期 rebuild 定时器被 `clearInterval`、subscriber 连接被 `quit()`（best-effort、包 `.catch()`），进程不因悬挂句柄卡住退出

#### 场景:失效/重建不写库
- **当** 周期 rebuild 或订阅回调触发
- **那么** 仅进程内缓存被替换/清空；`mr_*` 与既有表无任何写、`mr_catalog_version` 不被 bump

## 修改需求

## 移除需求
