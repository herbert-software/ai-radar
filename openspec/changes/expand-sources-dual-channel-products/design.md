## 上下文

P1 已上线最小情报流：RSS+HN+GitHub 三源 → 硬去重塌缩 → Value Judge → 中文摘要 → Telegram 单通道（幂等四元组 + 单例锁）→ BullMQ 每日 cron。当前接缝有三处写死，是 P2 扩展的主要改造面（已勘代码）：

1. **采集器写死**：`CollectorSource` 是联合类型 `'rss'|'hacker_news'|'github'`，`collectAllSources`（`src/collectors/index.ts`）用三个固定 `Promise.allSettled` 分支——加源要改两处。
2. **RSS 丢来源**：`mapRssItem`（`src/collectors/rss.ts:90-98`）把所有 RSS 标成 `source='rss'`、`rawType='news'`，**丢弃 feed 来源**，无法区分发布厂商。
3. **推送写死单通道**：`dispatcher.ts` 把 `CHANNEL='telegram'` 写死，`MessageSender` 单实现，`message.ts` 只产 MarkdownV2。

外部源选型经实测调研定档（详见 proposal）：T1 大厂官方 RSS（OpenAI/DeepMind/HuggingFace，已实测 feed 有效）信号最高且零鉴权；Product Hunt 用 Developer Token 只读最省事；arXiv 限流严（1 req/3s）；飞书自定义机器人够用但有整点限流坑；Reddit 因条款风险移出关键路径。

## 目标 / 非目标

**目标：**
- 把采集器编排抽成**数组驱动的 registry**，新增写 `raw_items` 的源只注册不改编排。
- RSS 带 vendor provenance（写 `metadata`），区分大厂发布。
- 接入 arXiv（OAI-PMH + ≥3s 节流 + 429 退避，非实时）。
- 接入 Product Hunt + 新建 `ai_products` 表 + 硬规则合并（唯一约束）+ 每日产品推送。
- dispatcher 按 channel 参数化；新增飞书通道（JSON 卡片）；状态机不复制。
- 实时告警与周报作为**独立调度入口**，各自独立幂等口径。

**非目标：**
- 不接 Reddit；不做 Meta/Anthropic/Mistral 的 HTML 抓取（T2 次批）。
- 不做语义去重/事件合并/KB 入库（P3）；产品合并仅硬规则。
- 不做 MCP 查询入口（P4）。
- 不引入相互投递的多队列图；不动 P1 已绿的去重/Top N/降级熔断核心逻辑。

## 决策

### D1：采集器 registry —— 数组驱动而非每源一分支
collector registry 为 `Array<{ source, collect(opts) }>`，`collectAllSources` 改为 `Promise.allSettled(registry.map(c => c.collect()))`，`perSource` 由 source 字段聚合。`CollectorSource` 扩为含 `arxiv` 与 `product_hunt`。**理由**：消除「加一源改两处」，与 spec「registry 注册即接入新源」对齐。**替代方案**：保持三分支手加 arXiv——被否，每加源都改编排、违反开放封闭。**Product Hunt 也是 registry 内的普通 raw_items collector**（修正原设计「PH 绕过 raw_items 直写 ai_products」）：QA.md §8.1 `raw_type` 含 `product`、§和「输出统一写入 `raw_items`」要求所有采集源先落统一原始证据层。故 PH 采集落 `raw_items`（`source='product_hunt'`、`raw_type='product'`、PH 产品名入 `title` 满足 NOT NULL、PH 原始 payload 入 metadata），再由**确定性产品塌缩步骤**读 `raw_items(raw_type='product')` 写 `ai_products`（镜像 `raw_items → ai_news_events` 塌缩模式，塌缩 INSERT 必填 `ai_products.name` NOT NULL，取自 raw_item.title）。`item_product_relations`（raw_item↔product 关系表）留 P3；P2 以 `ai_products.representative_raw_item_id`（**独立 BIGINT 列**，回指 `raw_items.id`、与 `ai_news_events.representative_raw_item_id` 同类型）作过渡，不塞 metadata。

### D2：RSS vendor provenance —— 配置 feed→vendor 映射，落 metadata
`RSS_FEEDS` 由「URL 逗号列表」升级为「带 vendor 标记的 feed 配置」（`url|vendor` 分隔形式，env 解析为 `{url, vendor}[]`；选分隔而非 JSON 取其在 .env 中可读）。`mapRssItem` 增参 vendor，写入 `metadata.vendor` + `metadata.feed_url`。`source` 仍为 `rss`（来源类别不变）。**理由**：厂商身份是评分/展示的关键维度，而 `source` 列语义是「采集器类别」不宜混入厂商。**替代方案**：给每个大厂单独建 `source='openai'` 等——被否，会让 RSS collector 逻辑按源分叉，且破坏「RSS 是一类采集器」的抽象。

**跨 feed guid 命名空间（修正）**：RSS `guid` 仅保证**单 feed 内**唯一（不少 feed 用裸序号/短 id），多大厂 feed 并存时 `UNIQUE(source='rss', source_item_id)` 会把不同 feed 的相同 guid 误判为同一条。故 RSS 的 `source_item_id` 必须**按 feed 命名空间化**：fallback 链改为 `sha256(feed_url ‖ '\0' ‖ guid)`（guid 缺失时仍走 `canonical_url` → 内容哈希，二者本就全局唯一不受影响）。vendor 缺失（用户自加的普通博客无 vendor 映射）时 `metadata.vendor` 取 `null`、不报错、不阻塞采集。

**RSS_FEEDS 破坏性格式**：旧纯 URL 列表（无 `|vendor`）在 env 解析时**快速失败并提示新格式**，禁止静默把 vendor 置空入库。

### D3：arXiv —— OAI-PMH + 串行节流器
新增 `src/collectors/arxiv.ts`，走 OAI-PMH（官方推荐增量）。实现一个**串行节流闸**（≥3s 间隔、单连接），429 走指数退避（复用 `withRetry`，baseDelay 调大）**且有重试上限**——超限则本轮该源放弃、记 error，由 `Promise.allSettled` 隔离（不无界 pending 拖长 job），且该放弃**不计入**「全部源采集返回 0」的系统级告警。**节流口径收口（修正）**：arXiv 限流是 arXiv 侧「所有访问机器合计 1 req/3s」，进程内节流闸只在**单实例采集**下成立。P2 明确**采集由单实例承载**（与 PH 竞态假设一致）：进程内串行闸即满足；spec 的限流口径相应收口为「单采集进程内 ≥3s 串行」+ 声明单实例假设，**不**承诺跨多 worker 全局节流。若未来多实例采集，再上 Redis 令牌桶（留为后续，不在 P2）。**理由**：避免「spec 写跨机器全局口径、实现只给单进程」的 design/spec 不一致。**替代方案**：用 arXiv query API——OAI-PMH 更适合「每天拉新」增量。

### D4：ai_products —— forward-only 迁移 + 三唯一键硬合并
新增表 `ai_products`，`product_id` 钉死 `VARCHAR(128) PRIMARY KEY DEFAULT gen_random_uuid()::text`（对齐 QA.md §8.3 的 `VARCHAR(128) PRIMARY KEY`，并与 `event_id` 同口径：surrogate、不内容派生、与 `push_records.target_id` 类型相容）。建 `UNIQUE(canonical_domain)` / `UNIQUE(github_repo)` / `UNIQUE(product_hunt_slug)` 三个独立唯一约束。塌缩在**事务内**：**对全部非空归一键各 `SELECT ... FOR UPDATE` 收集命中 `product_id` 集合后按 size 分流（0→INSERT / 1→UPDATE / >1→冲突，见下「多键命中多行」段），禁止按键优先级短路只查第一个命中键**（短路会漏掉其余键命中的孤儿行）。UPDATE 只累加 last_seen 类、`representative_raw_item_id` 回指，禁止覆盖 `product_id`；INSERT 必填 `name`（NOT NULL）。NULL 键不参与约束（Postgres `UNIQUE(col,NULL)` 放行多行）。权威算法以 product-discovery「ai_products 硬规则产品合并」与 tasks 7.3 为准。

**多键命中多行冲突（修正 — 原设计未定义）**：新条同时带 `domain=A/github_repo=B/slug=C`，而 A/B/C 在 DB 中分别命中三条**不同既有行** X/Y/Z（历史上各自独立建的）时，**禁止静默择一 upsert 留下孤儿行**。P2 采保守策略：**检测到多键命中多行 → 记录冲突 + 告警 + 不自动合并**（保留各行、人工/后续期处理），由确定性程序判定而非 LLM。事务内对各归一化键 `SELECT ... FOR UPDATE` 收集命中 `product_id` 集合：集合 size>1 即触发冲突分支。跨键传递合并（合并 X/Y/Z 为一行 + 迁移引用）涉及关系迁移，留 P3 与 `item_product_relations` 一并做。**理由**：产品合并必须由 DB 唯一约束 + 确定性程序保障、绝不交 LLM；保守告警可审计、不制造静默错并。

迁移 forward-only（P1 已上线数据，禁止 drop 重建，区别于 P0→P1 的 drop 策略）。

### D5：dispatcher channel 参数化 —— 状态机抽离、渲染器按 channel 分叉
把 `dispatcher.ts` 的 `CHANNEL` 常量改为参数；`MessageSender` 保持接口，新增 `FeishuSender`；`message.ts` 抽出「选 Top N 的渲染数据」与「按 channel 渲染」两层，Telegram 出 MarkdownV2、飞书出 JSON 卡片。幂等四元组的 `channel` 由调用方传入。**理由**：`push_records.channel` 列与候选窗口「以该 channel success」P1 已预留，DB 层天生支持多通道；只需把应用层写死解开。**替代方案**：飞书写一套独立 dispatcher——被否，会复制状态机致漂移（spec 明令禁止）。

**多通道分发并发 + 单例锁（修正 — 决定原开放问题）**：日报向两通道**并发**分发（`Promise.allSettled`），单通道发送失败隔离、不拖垮另一通道。**单例锁粒度沿用 P1 的 `daily-digest:{push_date}`**（不按 channel 拆）——一次 `runDailyWorkflow` 内顺序/并发跑两通道仍是同一 job、同一锁即可防双实例；但 TTL 必须从 P1 的「采集+逐条 LLM」口径上调到覆盖「+两通道分发」最坏时长（并发分发使增量有界）。**新推送路径（product/alert/weekly）各自需独立单例锁**：P1 已确立「`push_records` 唯一约束挡不住两并发实例各读待发集合各发一条」，故 product/alert/weekly 三条独立调度路径必须各带单例锁（如 `product-digest:{channel}:{push_date}`、`weekly:{channel}:{iso_week}`、`alert:{channel}:{event_id}`）或 DB 原子 claim（`INSERT ... RETURNING` / `FOR UPDATE SKIP LOCKED`，只有 claim 到者调外部 API），不得只靠唯一约束。

### D6：实时告警与周报 —— 独立 target_type、独立四元组、独立调度
实时告警 `target_type='alert'`、周报 `target_type='weekly'`，与日报 `event` / 产品 `product` 在 `push_records` 互不挤占。**理由**：复用日报天级 `push_date` 会让「日报已推该事件」吞掉实时告警（漏告警）。实时告警由更高频轮询任务承载（采集后即时按阈值判定），周报由周级 cron 承载——均为独立 BullMQ 调度入口，不嵌入 `runDailyWorkflow`。

**四元组语义钉死（修正 — 原 spec 未定义 target_id/push_date）**：
- **alert**：`target_id=event_id`、`channel`、`push_date=告警触发当日（Asia/Shanghai）`。幂等为「**一事件一通道一生只告警一次**」：候选条件「该 event_id 从未以该 channel success 告警过」管跨天去重，`UNIQUE(alert,event_id,channel,push_date)` 兜底同日并发。`importance_score` 一经 Value Judge 评分即稳定（不重判已评分事件），故「跨天再次达阈值」结构上不会发生、**不设跨天再告警行为**（原设计的「跨天再告警」依赖事件重新评分，与「Value Judge 只判未评分」不变量冲突、scenario 不可达，已移除）。
- **判定时点 + 快速链路（关键）**：`importance_score` 评分前为 NULL，阈值判定必须在评分**之后**。但被动等日报链评分会让告警退化为「日报后才触发」失去实时性。故实时告警由**更高频的轻量工作流**承载：复用日报相同的确定性阶段（采集/塌缩 → 对未评分事件跑 Value Judge → 评分后判阈值），频率 env 可配（默认 15–30min）。同时满足「评分后判定」（不 `NULL>=85` 误判）与「实时性」（不等日报）。
- **并发评分原子 claim（防双评分）**：高频告警链路与日报链路可能并发对同一未评分事件评分，仅「只判未评分」不防双评分。送 LLM 前必须原子 claim（`UPDATE ... SET judge_claimed_at WHERE *_score IS NULL AND (judge_claimed_at IS NULL OR judge_claimed_at < now()-interval 'T') RETURNING` / `FOR UPDATE SKIP LOCKED`，超时回收阈值 `T > L + W`，权威定义见 daily-intel「降级逐条容错」），只有 claim 成功者评分——保证一事件只评一次、永不覆写。这是新增高频链路引入并发后的必要补丁（需 `ai_news_events` 加 `judge_claimed_at` 列）。
- **高频链路不套用全源 0 告警**：高频轮询全源 0 是常态，套用日报全失败告警会刷屏；高频链路空轮不告警。
- **告警渲染降级**：告警事件在高频链路评分后、可能尚无中文摘要（`headline_zh`/`summary_zh` 为 NULL）。告警消息渲染**复用 telegram-push 的 headline 回退链**（`headline_zh` → `summary_zh` 截断 → `representative_title` → 仅标题），不因摘要缺失报错或漏告警。
- **weekly**：`target_id=iso_week`（如 `2026-W24`）、`channel`、`push_date=该 ISO 周周一（Asia/Shanghai）`。「周」边界锚定 Asia/Shanghai 固定 weekday（周一），与日报 push_date 时区同源，防跨零点把一份周报算两周。
- **实时阈值绑定**：「重大发布」判定绑 `ai_news_events.importance_score`，默认 `>= 85`（严于日报候选 should_push 的 `importance >= 75` / Top N 下限闸 `>= 60`——实时门槛应更高防刷屏），阈值经 env 可配；判定纯程序阈值，禁止 LLM 决定是否告警。
- **独立锁释放语义**：product/alert/weekly 三独立单例锁均须 job 级短时持有 + 完成/崩溃可靠释放（带 TTL 或 `finally`）——锁键不含时间（如 `alert:{channel}:{event_id}`），无 TTL 且崩溃未释放会永久死锁该路径，故释放语义不可省（同 daily 单例锁要求）。

**状态机复用**：alert/weekly/product 推送**复用 telegram-push/feishu-push 定义的同一套「待发→pending→原子送达→success/failed」状态机核心**（仅 target_type 与幂等键口径不同），禁止各写一套漂移的状态机。

### D7：里程碑式实现顺序（apply 可分段停）
tasks 按四里程碑组织，每段可独立交付与验证：
- **M1 扩源**：registry 重构 + RSS provenance + T1 大厂 feed + arXiv。
- **M2 双通道**：dispatcher 参数化 + 飞书 sender + 多通道分发编排。
- **M3 产品发现**：`ai_products` 迁移 + Product Hunt 采集 + 硬合并 + 每日产品推送。
- **M4 告警/周报**：实时告警路径 + 周报任务。
**理由**：P2 体量大（ROADMAP 估 3–4 周），分段让 apply 在自然节点停、每段补不变量测试。

## 风险 / 权衡

- **arXiv 429 收紧（2026-02 起）** → 单进程串行 ≥3s 节流 + 429 退避（有上限）+ 单连接 + 单实例采集假设；arXiv 单源失败经 allSettled 隔离不拖垮整批、不触发全失败告警。
- **Product Hunt 多键命中多行冲突** → 事务内 `FOR UPDATE` 收集命中 product_id 集合，size>1 即记冲突 + 告警 + 不静默择一（D4）；P2 单实例采集，并发竞态概率低、DB 唯一约束兜底。
- **飞书整点限流（11232）** → cron 默认避整点/半点（如 08:03）；飞书发送失败隔离、保留 failed 可重试。
- **多通道分发延长 job 时长** → 并发分发两通道（有界增量）+ 单例锁 TTL 上调到覆盖「采集+判断+摘要+两通道分发」最坏时长（D5）。
- **新推送路径（product/alert/weekly）幂等回退风险** → 各带独立单例锁/原子 claim（D5），不让唯一约束独扛并发双发。
- **RSS guid 跨 feed 碰撞** → source_item_id 按 `feed_url` 命名空间化（D2）。
- **RSS_FEEDS 破坏性 env 变更** → 旧纯 URL 格式启动即报错提示新格式（D2），不静默漏 vendor。
- **范围过大** → 用里程碑切分 + 每段独立测试缓解；若 apply 中发现仍过大，可按 M1/M2 与 M3/M4 拆成两个归档批次。

## 待解决问题

- 实时告警轮询间隔的具体取值（阈值已定 `importance_score >= 85` 可配，见 D6）——间隔 apply 时给保守默认（如 15–30 min），靠真实数据调。
- arXiv OAI-PMH 的 `from`/`set` 增量游标如何持久化（避免每次全量）——apply 时定，倾向记录上次 harvest 时间戳。
