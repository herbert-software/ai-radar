## 新增需求

### 需求:Product Hunt 确定性产品采集

系统必须提供一个确定性的 Product Hunt 采集器，以程序（而非 Agent 自由决定）拉取每日上榜产品。采集结果必须**先以统一结构写入 `raw_items`**（`source='product_hunt'`、`raw_type='product'`，PH 原始 payload 入 `metadata`），与其它采集源一致进入统一原始证据层（对齐 QA.md「输出统一写入 `raw_items`」与 `raw_type` 含 `product`），**禁止绕过 `raw_items` 直写 `ai_products`**；产品塌缩进 `ai_products` 是下游确定性步骤（见「ai_products 硬规则产品合并」）。采集必须使用只读 Developer Token 认证（无需交互式 OAuth flow），禁止把 token 写死在代码中、必须来自环境配置，缺失时按既有 env 校验快速失败。采集器必须遵守 Product Hunt 限流（GraphQL 约 6250 复杂度点/15min、REST 约 450 请求/15min）：必须读取响应的 `X-Rate-Limit-Remaining` / `X-Rate-Limit-Reset` 头并在余量耗尽时退避，禁止无视限流头持续打满。所有外部调用必须带重试与错误日志，失败禁止静默吞掉；但**采集中途的鉴权类错误（HTTP 401/403，如 token 被撤销/过期）不进入退避重试**（重试不可恢复的鉴权错误只浪费预算），直接按单源失败记 error、由 allSettled 隔离。

PH 产品名必须写入 `raw_items.title`（满足 QA.md §8.1 `title TEXT NOT NULL`），并作为下游 `ai_products.name` 的来源；PH 产品名罕见缺失时以确定性兜底值（`product_hunt_slug` 或 `canonical_domain`）填充 title，绝不留空致 `raw_items` 入库失败。

#### 场景:每日拉取上榜产品先入 raw_items
- **当** 产品发现任务触发采集
- **那么** Product Hunt 采集器用 Developer Token 拉取当日上榜产品，以统一结构（`source='product_hunt'`、`raw_type='product'`，产品名写入 `title`，含 slug、原文 URL、描述、上榜时间）写入 `raw_items`，不绕过原始证据层

#### 场景:PH 产品名缺失时 title 兜底非空
- **当** 某 PH 产品缺产品名
- **那么** `raw_items.title` 以 `product_hunt_slug`（或 `canonical_domain`）兜底填充，不留空、`raw_items` 入库不因 `title NOT NULL` 失败

#### 场景:限流余量耗尽时退避而非打满
- **当** 某次响应的 `X-Rate-Limit-Remaining` 降至 0 / 接近 0
- **那么** 采集器依 `X-Rate-Limit-Reset` 退避到下个重置窗口再继续，禁止无视限流头持续请求

#### 场景:token 缺失时启动即报错
- **当** 缺少 Product Hunt token 并尝试运行产品发现
- **那么** 系统以明确错误信息快速失败，禁止匿名静默继续

### 需求:ai_products 硬规则产品合并

系统必须把 `raw_items(raw_type='product')` 的产品条目塌缩进 `ai_products` 表，**仅以程序与数据库唯一约束做硬规则合并，绝不交给 LLM 判断**。合并键必须为 `canonical_domain`、`github_repo`、`product_hunt_slug` 三者的唯一约束。塌缩必须在**事务内**按以下确定性步骤（**不得按优先级短路只查第一个命中键** —— 短路会漏掉其余键命中的孤儿行）：

1. 对该条产品的**全部非空归一化键**各做一次 `SELECT ... FOR UPDATE`，收集命中的既有 `product_id` 集合。为防两并发塌缩按不同键顺序对不同行加锁互相死锁，`FOR UPDATE` 必须按**确定性全序**（如命中 `product_id` 升序）加锁；P2 产品塌缩亦明确由**单实例**承载（与 arXiv 单实例采集假设一致），并发概率低、DB 唯一约束兜底。
2. 据命中集合 size 分流：**size=0 → INSERT 新行**；**size=1 → UPDATE 该行**（只更新 last_seen 类可累加字段、记 `representative_raw_item_id` 回指，禁止覆盖产品身份主键 `product_id`）；**size>1 → 多键命中多行冲突分支**（见下）。
3. **INSERT 必须填充 `ai_products.name`（NOT NULL）**，取自该 `raw_item` 的 `title`（即 PH 产品名）；缺失时以确定性兜底值（`product_hunt_slug` 或 `canonical_domain`）填充，**绝不留空致 INSERT 因 NOT NULL 约束失败**。
4. 产品塌缩**只读未塌缩过的 product 行**（`raw_type='product' AND collapsed=false`），塌缩成功（INSERT/UPDATE/标 merge_conflict 任一终态）后将该 raw_item 置 `collapsed=true`，使其不被每轮无界重读重塌（复用 `collapsed` 列，对 product 行语义为「已塌缩进 ai_products」，见 dedup-and-normalization）。塌缩对 raw_item 幂等：重读已塌缩行无副作用，但通过 `collapsed=false` 过滤避免线性增长的重扫。

`canonical_domain` 必须由 URL 规范化纯函数从产品官网 URL 提取（去追踪参数、host 小写、去 www 前缀口径一致），`github_repo` 必须归一为 `owner/name` 形式，`product_hunt_slug` 取 PH 原生 slug。三键任一缺失时不得用该键参与合并（禁止用 NULL 键产生 `UNIQUE(col, NULL)` 放行多行的静默失效）。

塌缩 INSERT/UPDATE 除 `name`、三合并键、`representative_raw_item_id` 外，QA.md §8.3 的其余富化列（`vendor`/`official_url`/`category`/`description`/`open_source`/`mcp_supported`/`score` 等）**P2 可留空**，富化留 P5 顾问期——本期产品发现只做「发现 + 硬合并 + 推送」，不做产品富集。

**多键命中多行冲突必须显式处置、禁止静默择一**：当一条新产品同时带多个稳定键、而这些键在 DB 中分别命中**不同的既有行**（如 `canonical_domain` 命中行 X、`github_repo` 命中行 Y）时，系统必须在事务内对各归一化键 `SELECT ... FOR UPDATE` 收集命中的 `product_id` 集合；集合含 >1 个不同 `product_id` 即为合并冲突，必须**记录冲突 + 告警 + 不自动择一 upsert**（保留各行待后续期处理），**禁止只按优先级更新一行而留下其余应属同一产品的孤儿行**。冲突状态必须有持久落点（在涉及的各 `ai_products` 行的 `metadata` 标记 `merge_conflict` + 冲突对方 product_id 集合），使「同一冲突不重复告警」可判（已标记 `merge_conflict` 的同组冲突再次命中时只更新不重复告警，避免每轮采集重复刷告警）。跨行传递合并（合并 X/Y 为一行并迁移引用）涉及关系表迁移，留 P3 与 `item_product_relations` 一并做。`raw_item↔product` 关系本期不建 `item_product_relations`（P3），仅以 `ai_products.representative_raw_item_id` 回指过渡。

#### 场景:首次塌缩 INSERT 填充非空 name
- **当** 某产品在 `ai_products` 中无任一稳定键命中、需 INSERT 新行
- **那么** INSERT 填充 `name`（取自 raw_item 的 title / PH 产品名，缺失则兜底 slug 或 domain），不留空、不因 `name NOT NULL` 约束失败

#### 场景:同一产品经稳定键命中时塌缩为单行
- **当** 同一产品在两次采集中返回相同 `product_hunt_slug`（或相同 `canonical_domain` / `github_repo`）
- **那么** 第二次塌缩在事务内查到命中行并 `UPDATE`，`ai_products` 中该产品仅一行，`product_id` 不被覆盖

#### 场景:多键命中多行时记冲突告警不静默择一且不重复刷
- **当** 一条新产品的 `canonical_domain` 命中既有行 X、`github_repo` 命中另一既有行 Y（两行历史上独立创建）
- **那么** 系统检测到命中 product_id 集合 size>1，在各行 `metadata` 标记 `merge_conflict` 并告警、不自动择一 upsert、不留孤儿行；该冲突组下轮再命中时只更新不重复告警（不调用 LLM 判断）

#### 场景:合并键全部由程序与 DB 决定
- **当** 判定两条产品记录是否为同一产品
- **那么** 判定完全依据 `canonical_domain` / `github_repo` / `product_hunt_slug` 唯一约束与 URL 规范化纯函数，禁止调用 LLM 做合并判断

#### 场景:缺失合并键不以 NULL 参与唯一约束
- **当** 某产品缺少 `github_repo`
- **那么** 该键不参与合并（不产生 `UNIQUE(github_repo, NULL)` 放行多行），仅用其余可用稳定键，源内幂等不失效

### 需求:每日产品发现推送

系统必须把当日新发现产品按程序选择后推送，并以 `push_records` 的 `UNIQUE(target_type, target_id, channel, push_date)` 保障幂等。产品推送记录的四元组必须为 `target_type='product'`、`target_id=product_id`、`channel`、`push_date`（**取 Asia/Shanghai，与事件日报 `push_date` 时区口径同源**——二者用同一时区计算「今天」，时区不同源会跨零点把一天算两天致跨天候选窗口失效；这是**时区口径同源、非同一 workflow**），与事件日报（`target_type='event'`）各自独立，互不挤占。

**产品发现是独立调度任务（对齐 daily-intel-pipeline，绝不可省）**：产品发现**不塞进 `runDailyWorkflow()` 的日报顺序链**，而是一个与日报并列的独立 BullMQ 调度任务（见 daily-intel-pipeline「每日定时单队列顺序编排」）。其**内部**是一条顺序子流程「采集 PH → 产品塌缩 → 选名单 → 推送」，但该子流程整体独立于日报链运行。

**跨天不重推候选窗口（与 event 同口径，绝不可省）**：选择进入推送的产品候选必须满足「该 `product_id` **从未被任何 `push_date` 以该 channel `success` 推送过**」——否则一个产品因 PH 持续上榜、`last_seen` 天天刷新，会每天以新 `push_date` 重新入选、`UNIQUE` 四元组每天不冲突 → **天天重推同一产品**（这正是 P1 为 event 显式防住的缺陷，product 必须同样防）。「同日 `push_date` 不重复」由唯一约束兜底，「跨天一产品一生只推一次」由本候选窗口兜底，两层叠加不可删其一。

**处于未解决合并冲突态的产品必须排除出推送候选**：被标记 `merge_conflict`（多键命中多行、同一真实产品散为多个 `product_id`）的产品，其多个 `product_id` 会各自满足「从未 success」而被各推一次，违反「一产品一生一次」。故标记 `merge_conflict` 的 `product_id` 必须排除出推送候选，直到 P3 跨行合并解决（宁可暂不推该产品，也不重复推）。**推送候选查询必须在产品塌缩阶段完成之后执行**（在产品发现独立任务的顺序子流程内：采集→塌缩→选名单→推送），确保 `merge_conflict` 标记对推送候选可见——否则推送先于塌缩读候选会漏掉刚产生的冲突标记、把冲突产品各推一次。

推送流程必须**复用 telegram-push/feishu-push 定义的同一套「待发→`pending`→原子送达→`success`/`failed`」状态机核心**（仅 `target_type` 与候选/幂等口径不同），禁止另写一套漂移的状态机；唯一键冲突即跳过。产品推送任务必须带**独立单例锁**（如 `product-digest:{channel}:{push_date}`）或 DB 原子 claim，防两并发实例各读待发集合各发一条（P1 已确立唯一约束挡不住此并发）；该锁须 job 级短时持有 + 完成/崩溃可靠释放（带 TTL 或 `finally`）。选择哪些产品进入推送由程序规则决定，禁止由 LLM 决定最终推送名单。

#### 场景:同一天同一产品不重复推送
- **当** 当日产品推送已 success 后，产品推送任务在同一 `push_date`、同一 channel 再次执行
- **那么** 该产品因 `UNIQUE(target_type='product', target_id, channel, push_date)` 冲突被跳过，不重复推送

#### 场景:已推过的产品跨天不再重推
- **当** 某产品曾在任一 `push_date` 以该 channel `success` 推送，之后仍持续在 PH 上榜（`last_seen` 刷新）
- **那么** 该产品不再进入产品推送候选，不会因新 `push_date` 被跨天重复推送

#### 场景:冲突态产品排除出推送候选
- **当** 某真实产品因多键命中多行被标记 `merge_conflict`、散为多个 `product_id`
- **那么** 这些 `product_id` 被排除出产品推送候选，不会因各自「从未 success」而把同一产品重复推多次

#### 场景:产品推送与事件日报互不挤占
- **当** 同一天既推事件日报又推产品发现
- **那么** 二者因 `target_type` 不同（`event` vs `product`）各自独立幂等，互不影响彼此的待发集合与去重
