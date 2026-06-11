## ADDED Requirements

### 需求:Telegram 单通道日报推送

系统必须提供 Telegram 推送 dispatcher（基于 grammY），把每日 Top N 入选事件打包成一条日报消息推送到配置的 channel/chat。消息内容必须基于事件的代表标题与中文摘要。Telegram bot token 与目标 chat id 必须来自环境配置，缺失时按既有 env 校验快速失败。

#### 场景:每日推送一条打包日报
- **当** 当日 Top N 选定且摘要就绪，推送任务执行
- **那么** Top N 事件被拼成一条 Telegram 消息发送到目标 chat

### 需求:推送幂等按 event 粒度

系统必须以 `push_records` 的 `UNIQUE(target_type, target_id, channel, push_date)` 保障同一天同一条事件不重复推送。推送记录的主键四元组必须为 `target_type='event'`、`target_id=event_id`、`channel='telegram'`、`push_date`。`push_date` 必须以 Asia/Shanghai 时区计算「今天」，禁止用 UTC 或机器本地时区导致跨零点把一份日报算成两天。

待发集合必须显式定义为「今日 Top N 中 `status ∈ {无记录, pending, failed}` 的事件」（即今日 Top N 排除今日已 `success` 的），从而 failed 与崩溃残留的僵尸 `pending` 自动纳入重试，已成功的不再重发。

两层「排除 success」分工不同、叠加不矛盾，实现时不可因「看似重复」删掉其一：候选窗口（daily-intel-pipeline）的「从未被任何 push_date success」负责**跨天/跨次不重推**（一条事件一生只成功推一次）；本待发集合的「今日 success 排除」负责**同一 push_date 内**待发集合混有 failed/pending 与 success 时不重发已成功条目（同日 BullMQ 整 job 重试的兜底）。`failed` 的重试边界：同一 push_date 内由整 job 重试重新纳入待发集合；跨天则该 push_date 的 failed 行被留存但不再发，事件靠候选窗口（仍「从未 success」）以**新的 push_date** 重新入选获得新一次推送机会。推送流程必须为：在事务内为待发集合中无记录者 `INSERT push_records(status='pending') ON CONFLICT DO NOTHING`；将整个待发集合拼成一条消息发送；单条消息原子送达——成功则该批全部置 `success`，失败则该批全部置 `failed` 并保留 `error_message` 供重试。禁止把已 `success` 的事件重新拼入消息。

#### 场景:当天重跑不重复推送
- **当** 当日日报已成功推送后，推送任务在同一 `push_date` 再次执行
- **那么** 待发集合排除已 `success` 的事件后为空，不发送任何消息

#### 场景:发送失败整批可重试
- **当** 待发集合拼成的消息调用 Telegram API 失败
- **那么** 该批 push_records 全部置 `failed` 并保留错误信息，下次执行时这些 failed 事件被重新纳入待发集合重试

#### 场景:僵尸 pending 被重试
- **当** 上次执行插入 `pending` 后进程崩溃、未实际发送
- **那么** 下次执行时该 `pending` 事件因仍属待发集合而被重新发送，不会永久卡死

### 需求:日报任务全局单例

系统必须保证某一 `push_date` 的日报推送任务全局只有一个实例在执行（如 Redis `SETNX daily-digest:{date}` 或 BullMQ job id 去重）。`push_records` 唯一约束无法阻止两个并发实例都读到同批待发记录并各自发送一条消息，故必须由单例锁兜住此并发。单例锁必须带 TTL 或在 `finally` 中可靠释放——若用无 TTL 的 `SETNX` 且进程崩溃未释放，则当日永远拿不到锁，「僵尸 `pending` 下次重试」需求将无法满足（两需求直接冲突）。锁的存活语义必须保证：正常完成或崩溃后，同一 `push_date` 仍可被后续运行重新获取以完成重试。

TTL 取值必须显著大于 `runDailyWorkflow` 的最坏执行时长（采集三源 + 逐条 LLM 判断 + 逐条摘要，量大时可达数分钟至十几分钟），或改用可续租/看门狗式锁——否则 TTL 提前到期会让第二个并发实例拿到锁而双发，破坏单例性。禁止设一个可能短于任务时长的固定小 TTL。

#### 场景:并发触发只发一份
- **当** 两个 worker 因重复投递或手动触发撞上定时而同时执行同一天的日报任务
- **那么** 仅一个实例获得锁并发送，另一个被单例锁挡下，用户只收到一份日报

#### 场景:崩溃后同日仍可重新获取锁
- **当** 持锁实例在推送中途崩溃未显式释放锁
- **那么** 锁因 TTL 到期（或其他释放机制）而可被同日后续运行重新获取，僵尸 `pending` 得以重试，不形成死锁
