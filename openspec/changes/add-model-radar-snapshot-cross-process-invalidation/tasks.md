## 1. env + pub/sub 模块

- [x] 1.1 `src/config/env.ts` 加 `MR_SNAPSHOT_REBUILD_INTERVAL_MS`（`z.coerce.number().int().positive().default(300000)`）；注释注明刻意用 `_MS`/setInterval（非 `MR_*_CRON`+`_CRON_TZ`——那是 BullMQ repeatable job 约定，D2 否决 BullMQ 链）+ 与既有 `MR_SNAPSHOT_TTL_MS`（5b scrape 文件 TTL，无关）区分
- [x] 1.2 新增 `src/mr/snapshot/invalidation.ts`：channel 常量（`mr:snapshot:invalidate`）+ 两个**形态相反**的连接（D4）：
  - `publishSnapshotInvalidation()`：**短连接「连/发/拆」**（仿 `health/redis.ts` pingRedis：`new Redis(env.REDIS_URL, { enableOfflineQueue:false, maxRetriesPerRequest:1, retryStrategy:()=>null, lazyConnect:true, connectTimeout: 1000, commandTimeout: 1000 })` + 挂 'error' handler + **显式 `await client.connect()` 再 `client.publish()` 序列**（勿依赖 lazy 自连——`enableOfflineQueue:false` 下直接 `publish()` 即便 Redis 在线也会立即 reject「Stream isn't writeable」、丢 happy-path）+ `catch` reject + `finally` `disconnect()`）；每写阻塞上界 = `connectTimeout`(界握手)+`commandTimeout`(界 half-open 命令，仿 `alert-lock.ts`/`push-lock.ts`) ≤~2s；at-most-once、失败仅 `console.error` 不抛、**不留常驻 socket**（否则吊住 seed 等刻意不调 `process.exit` 的一次性进程的事件循环）
  - `createSnapshotInvalidationSubscriber(onInvalidate)`：**长连接保持自动重连**（`new Redis(env.REDIS_URL, { maxRetriesPerRequest: null })`——同仓 BullMQ 长连约定，**承重项**：默认 20 会在冷启动 Redis 宕的窄窗 flush 掉首个未成功的 SUBSCRIBE→永不重订阅；**禁** `retryStrategy:()=>null`/`lazyConnect`/`enableOfflineQueue:false`）；ioredis 断线重连后**自动重放 SUBSCRIBE**（内部订阅集，仅重放成功订阅过的 channel，**无需手写 ready handler**），挂 'error' handler；返回带 `quit()` 的句柄

## 2. 服务进程接线（src/index.ts）

- [x] 2.1 启动时建 subscriber：`createSnapshotInvalidationSubscriber(() => invalidateModelRadarSnapshot())`；订阅错误仅记日志不崩
- [x] 2.2 启动时建周期 rebuild 定时器：`setInterval(() => rebuildModelRadarSnapshot(undefined, new Date()).catch(记日志), MR_SNAPSHOT_REBUILD_INTERVAL_MS)`——**用非 publish 的 cache fn `rebuildModelRadarSnapshot`、不是会 publish 的 `runSnapshotRebuild`**（避免每 tick 自 publish 自激，见 D2 承重不变量）；`undefined` = 默认 db（`index.ts` 今无 db 句柄，**不引用不存在的 `db`**）；`.unref()` 不阻塞退出；rebuild 失败 fail-closed 保留旧快照、不崩
- [x] 2.3 优雅关闭（既有 SIGINT/SIGTERM）追加：`clearInterval` + subscriber `quit()`（**包 `.catch()`**，Redis 挂时 quit reject 不成 unhandledRejection；best-effort——被 `process.exit(0)` 截断亦无害，只读 subscriber 无未刷状态；定时器已 `.unref()` 不阻塞退出）

## 3. 写方触发点追加 publish（提交后、不在事务内）

- [x] 3.1 `src/mr/snapshot/rebuild.ts`（`runSnapshotRebuild`）**成功/失败均无条件**追加 `publishSnapshotInvalidation()`（它本就在最外层 `db.transaction` 提交后被 `recordPriceChange`(`:226`)/`upsert`(`:376`)/seed(`:29`) 调；commit 已发生→peer 必须被通知，不论本进程 rebuild ok/fail；publish 自吞错不影响 outcome）
- [x] 3.2 **严禁**把 publish 加进 `setReviewFlag`（`flag.ts`）或任何接收 `TxLike` 的函数：`_recordPriceChangeTx`(`record-price-change.ts:203`) 在事务内调 `setReviewFlag`，事务内 publish→subscriber 立即失效→server 从未提交状态 build→脏快照回灌。flag/staleness 日级 cron 写**不 publish**、可见性走周期 rebuild（req-2）。seed/策展经 `runSnapshotRebuild` 已随 3.1 自动带 publish，无需再补
- [x] 3.3 随本变更更新 `src/mr/snapshot/rebuild.ts:14-20` 过时注释（仍描述被 D2 否决的「常驻 worker 链7 四件套 `createMrSnapshotRebuildQueue…` + `MR_SNAPSHOT_REBUILD_ENABLED` 开关」5d 装配方案）→ 改述 setInterval 周期 rebuild + pub/sub

## 4. 测试

- [x] 4.1 invalidation 单测（注入桩，不触真 Redis）：subscriber 收到消息 → onInvalidate 被调（→ 服务进程下次读 build-from-DB）；publish 失败（Redis 桩抛错）→ 不抛、仅记日志、不阻塞调用方
- [x] 4.2 周期 rebuild 单测：直接调 rebuild body 注入推进的 now → 跨 staleness 阈值时 `stale` 翻转 + version 变；不跨阈值 + 无 DB 变 → version 稳定。**并验 flag/staleness 可见性**：先写 `mr_review_flag`、不 publish，再调周期 rebuild body → 重建快照 `reviewStatus.pending` 反映该写（证「不走 publish 的 flag 写经周期 rebuild 可见」req-2 场景）
- [x] 4.3 Redis-down 自愈：publish 桩抛错下，写仍成功 + 周期 rebuild 仍重建（不依赖 Redis）
- [x] 4.4 只读不变量：周期 rebuild / 订阅回调路径不写 `mr_*`、不 bump `mr_catalog_version`（grep/断言）
- [x] 4.5 生命周期：优雅关闭清 interval + quit subscriber（句柄不泄漏；fake timer / spy 断言 `clearInterval` + `quit` 被调 + quit reject 被 catch）
- [x] 4.6 **自激守卫**（F7 防回归）：断言服务进程周期 rebuild 路径调 `rebuildModelRadarSnapshot`、**不**触发 `publishSnapshotInvalidation`（spy publish 调用数=0）；防将来「统一两 rebuild 函数 / 下沉 publish 进 cache 层」致每 tick 自 publish thrash
- [x] 4.7 **publisher 不吊进程**（B1）：spy `disconnect()` 在 publish 后被调（断言短连接 `connect→publish→disconnect` 序列、无常驻句柄）
- [x] 4.8 **提交后才 publish**（B3）：改价经 `recordPriceChange`（含 history-conflict 走 `_recordPriceChangeTx`+事务内 `setReviewFlag`）时，publish 只在最外层提交后发出一次、**不在事务回调内**（spy publish 相对 commit 的时序 / 断言 publish 不在 tx 回调内被调）
- [x] 4.9 **subscriber 保持自动重连守卫**（M1 防回归，与 4.6/4.7 对称）：断言 subscriber 连接配置**不含** `retryStrategy:()=>null`/`lazyConnect`（即保留 ioredis 自动重连）；防将来「为一致性把 publisher 短连接配置抄给 subscriber」无声重新破坏 M1

## 5. 验证

- [x] 5.1 `openspec-cn validate add-model-radar-snapshot-cross-process-invalidation --strict`
- [x] 5.2 `npx vitest run src/mr/snapshot`（含新 invalidation 测试）— 40 unit passed（含 4.1/4.3/4.5/4.6/4.7/4.9 新守卫）；3 集成（4.2/4.4/4.8）经实现方对 `ai-radar-postgres-1` 容器实跑 62 passed（编排者本地 shell 暂连不上 DB，非测试失败）
- [x] 5.3 `npx tsc --noEmit` + `npm run lint`（均 0 错）
- [x] 5.4 跨进程真 Redis 手测无法在此环境复现 → 按本任务约定以**注入桩单测覆盖**（4.1 subscriber 收消息→invalidate、4.7 publisher 连/发/拆不吊进程、4.3 Redis-down 写仍成功）+ 本说明
