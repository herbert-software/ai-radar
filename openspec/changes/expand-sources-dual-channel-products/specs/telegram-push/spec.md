## 修改需求

### 需求:Telegram 单通道日报推送

系统必须提供推送 dispatcher，把每日 Top N 入选事件打包成一条日报消息推送到配置的通道。dispatcher 必须**按 channel 参数化**：渲染器按 channel 分叉（Telegram 用 MarkdownV2，飞书用 JSON 卡片，见 feishu-push），但「待发集合计算 → 先写 pending → 单条消息原子送达 → 整批 success/failed」的状态机对所有 channel 一致、由同一套程序逻辑承载，禁止为每个 channel 复制一份互相漂移的状态机。本需求描述 Telegram channel 的渲染细节；飞书 channel 的渲染见 feishu-push。

Telegram channel 每条事件的消息内容必须为「代表标题 + 一句话要点（`headline_zh`）+ 原文可点击链接」，**不再堆叠完整长摘要（`summary_zh`）**——长摘要仅落库不进消息。

代表标题渲染时必须做**渲染期长度截断**——因 `representative_title` 是无长度上限的源标题原文，不截断则一条超长标题即可使单条消息超限。截断规则：**必须在 MarkdownV2 转义之前**（转义后截断会切断 `\x` 转义序列、留孤立 `\` 致发送失败）、**按 Unicode code point**（非 UTF-16 code unit，防中文/emoji 截半）截断，使「截断后标题 + 省略号」的总 code point 数不超过单一常量 `TITLE_MAX`（如 120，含省略号）。

原文链接必须取事件代表 `raw_item` 的 `canonical_url`（已去追踪参数）。链接渲染为 MarkdownV2 内联链接 `[文本](url)`：链接文本用普通文本转义；**URL 必须用独立的 URL 转义规则（仅转义 `)` 与 `\`），禁止复用 18 字符文本转义器**——文本转义器会把 URL 内常见的 `.`/`-`/`_`/`=` 也加反斜杠从而破坏链接。`canonical_url` 缺失时**不渲染链接、仅标题 + 要点**（本期不引入"源 URL"中间级）。`headline_zh` 缺失（旧事件/降级）时按固定顺序回退：`summary_zh` 截断前 ~80 字 → `representative_title` → 仅标题无要点。以上回退均不报错、不阻塞整条日报。Telegram bot token 与目标 chat id 必须来自环境配置，缺失时按既有 env 校验快速失败。

每条 = 「标题（渲染期截至 `TITLE_MAX`）+ ≤80 字要点 + 链接」。标题与要点有长度上界，`canonical_url` 无硬上界（但去追踪参数后**典型较短**），故 `TOP_N`（默认 8）条**典型情形**远低于单条消息长度上限、一条装下；**极端情形**（超长 URL 或全保留字符标题致转义膨胀）仍可能超限，由保留的截断顺延逻辑 + `[push] 消息截断` 告警 + 「只把实际发出的事件标 `success`、被截断事件保持 `pending`」语义兜底处理。**不得宣称"绝不截断"——目标是消除典型情形的截断、极端仍走兜底。**

#### 场景:每日推送一条短要点+链接日报
- **当** 当日 Top N 选定、headline 与摘要就绪，推送任务执行
- **那么** Top N 事件被拼成一条 Telegram 消息发送，每条为「代表标题 + 一句话要点 + 原文可点击链接」，且默认 Top N 条不触发截断

#### 场景:渲染器按 channel 分叉而状态机统一
- **当** 同一份 Top N 分别经 Telegram 与飞书通道推送
- **那么** Telegram 渲染为 MarkdownV2、飞书渲染为 JSON 卡片，但二者走同一套「待发集合→pending→原子送达→success/failed」状态机逻辑

#### 场景:链接 URL 含特殊字符用独立规则转义
- **当** 某事件 canonical_url 含 `)`、字面 `\`、以及常见的 `.`/`-`/`_`/`=`
- **那么** URL 经独立 URL 转义函数处理：`)` 与 `\` 被转义、而 `.`/`-`/`_`/`=` **不被**加反斜杠（用文本转义器会破坏 URL）；消息发送成功且链接可点击

#### 场景:headline 缺失按固定顺序回退、链接缺失则无链接
- **当** 某事件无 `headline_zh`（旧事件/降级）或无可用 `canonical_url`
- **那么** headline 缺失按 `summary_zh 截断 → representative_title → 仅标题` 顺序回退；`canonical_url` 缺失则不渲染链接、仅标题+要点；均不报错、不阻塞整条日报

#### 场景:超长标题渲染期截断不撑爆消息
- **当** 某入选事件 `representative_title` 远超 `TITLE_MAX`
- **那么** 渲染期截断至 `TITLE_MAX`（加省略号），该条与其余 Top N 仍拼在一条消息内、不触发截断顺延

### 需求:推送幂等按 event 粒度

系统必须以 `push_records` 的 `UNIQUE(target_type, target_id, channel, push_date)` 保障同一天同一条事件在**同一通道**不重复推送。推送记录的主键四元组必须为 `target_type='event'`、`target_id=event_id`、`channel=分发通道`（如 `telegram` / `feishu`，由 dispatcher 参数化传入，禁止写死单一通道值）、`push_date`。`push_date` 必须以 Asia/Shanghai 时区计算「今天」，禁止用 UTC 或机器本地时区导致跨零点把一份日报算成两天。同一事件在不同 channel 上各自独立幂等（一通道已推不抑制另一通道）。

待发集合必须显式定义为「统一名单中该 channel 上 `status ∈ {无记录, pending, failed}` 的事件」（即统一名单排除该 channel **任一 push_date** 已 `success` 的——**per-channel 跨天**口径），从而 failed 与崩溃残留的僵尸 `pending` 自动纳入重试，该通道已成功的不再重发。待发集合的 success 排除必须**按 channel 限定**，禁止跨 channel 误排除（否则 Telegram 已推会错误抑制飞书待发）。

两层职责分工不同、叠加不矛盾，实现时不可因「看似重复」删掉其一：候选窗口（daily-intel-pipeline，**统一日报模型 Model B**）的「尚未投递给**所有已配置通道**」负责**统一名单的成员资格**（一份 channel-blind 名单；事件只要还差任一通道未 success 就留在名单，全部投递完毕才移出——保住 Top N 名额给仍需投递者）；本待发集合的「该 channel **任一 push_date** success 排除」负责**per-channel 跨天可靠投递**——该通道从未 success 过的才发，故某通道（如飞书）失败时该事件在该 channel 无 success → 跨天/跨次仍在该通道待发 → **可靠补发不丢**，已 success 的通道（如 telegram）被排除、绝不跨天重发。`failed` 的重试边界：同一 push_date 内由整 job 重试重新纳入待发集合；跨天则该 channel 因仍「从未 success」继续在后续 push_date 的待发集合里重试，直到该通道 success（届时被排除）或事件移出统一名单（所有通道都 success）。推送流程必须为：在事务内为待发集合中无记录者 `INSERT push_records(status='pending') ON CONFLICT DO NOTHING`；将整个待发集合拼成一条消息发送；单条消息原子送达——成功则该批全部置 `success`，失败则该批全部置 `failed` 并保留 `error_message` 供重试。禁止把已 `success` 的事件重新拼入消息。

#### 场景:当天重跑不重复推送
- **当** 当日日报已在某 channel 成功推送后，推送任务在同一 `push_date`、同一 channel 再次执行
- **那么** 待发集合排除该 channel 已 `success` 的事件后为空，不发送任何消息

#### 场景:同事件不同通道独立幂等
- **当** 某事件在 `channel='telegram'` 已 `success`，飞书通道当日尚无记录
- **那么** 该事件在 `channel='feishu'` 仍属待发集合并被推送，不因 Telegram 已 success 而被抑制

#### 场景:发送失败整批可重试
- **当** 待发集合拼成的消息调用推送 API 失败
- **那么** 该批 push_records 全部置 `failed` 并保留错误信息，下次执行时这些 failed 事件被重新纳入该 channel 待发集合重试

#### 场景:僵尸 pending 被重试
- **当** 上次执行插入 `pending` 后进程崩溃、未实际发送
- **那么** 下次执行时该 `pending` 事件因仍属待发集合而被重新发送，不会永久卡死

### 需求:日报任务全局单例

系统必须保证某一 `push_date` 的日报推送任务全局只有一个实例在执行（如 Redis `SETNX daily-digest:{date}` 或 BullMQ job id 去重）。`push_records` 唯一约束无法阻止两个并发实例都读到同批待发记录并各自发送一条消息，故必须由单例锁兜住此并发。锁粒度按 `push_date`（不按 channel 拆）：一次 `runDailyWorkflow` 内向**所有已配置通道并发分发**仍是同一 job、同一锁即可防双实例。单例锁必须带 TTL 或在 `finally` 中可靠释放——若用无 TTL 的 `SETNX` 且进程崩溃未释放，则当日永远拿不到锁，「僵尸 `pending` 下次重试」需求将无法满足（两需求直接冲突）。锁的存活语义必须保证：正常完成或崩溃后，同一 `push_date` 仍可被后续运行重新获取以完成重试。

TTL 取值必须显著大于 `runDailyWorkflow` 的最坏执行时长，且该最坏时长**必须计入多通道分发**（采集多源 + 逐条 LLM 判断 + 逐条摘要 + **向 Telegram 与飞书并发分发**，量大时可达数分钟至十几分钟）——多通道相比 P1 单通道延长了 job，TTL 须相应上调；或改用可续租/看门狗式锁。禁止设一个可能短于任务时长的固定小 TTL。**产品发现 / 实时告警 / 周报等独立推送路径不共用本锁**，各自按其能力规范持有独立单例锁（见 product-discovery / realtime-alerts / weekly-report）。

#### 场景:并发触发只发一份
- **当** 两个 worker 因重复投递或手动触发撞上定时而同时执行同一天的日报任务
- **那么** 仅一个实例获得锁并发送，另一个被单例锁挡下，用户每通道只收到一份日报

#### 场景:崩溃后同日仍可重新获取锁
- **当** 持锁实例在推送中途崩溃未显式释放锁
- **那么** 锁因 TTL 到期（或其他释放机制）而可被同日后续运行重新获取，僵尸 `pending` 得以重试，不形成死锁
