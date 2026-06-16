## 修改需求

### 需求:每日产品发现推送

系统必须把当日新发现产品按程序选择后推送，并以 `push_records` 的 `UNIQUE(target_type, target_id, channel, push_date)` 保障幂等。产品推送记录的四元组必须为 `target_type='product'`、`target_id=product_id`、`channel`、`push_date`（**取 Asia/Shanghai，与事件日报 `push_date` 时区口径同源**——二者用同一时区计算「今天」，时区不同源会跨零点把一天算两天致跨天候选窗口失效），与事件日报（`target_type='event'`）各自独立命名空间、互不挤占。

**产品推送并入新闻日报消息（合并变更）**：产品发现**不再是独立 BullMQ 调度任务/独立消息**（原「每日产品发现独立调度链/队列/cron/独立单例锁」一并废止）。产品作为「新品段」并入新闻日报的**同一条**「AI Radar 每日情报」消息（与「要闻段」events 并列）。其内部仍是确定性顺序子流程「产品采集（由日报 `collectAllSources` 覆盖）→ **产品塌缩一次（channel-blind）** → **per-channel 选产品候选** → 并入日报消息」：产品塌缩调 `collapseUncollapsedProductRawItems`（import 自 `src/collectors/product-collapse.ts`，在 channel 展开之前**只跑一次**——产品塌缩单实例承载，绝不随 per-channel 并发重复），随后对每个 channel 调 `selectProductCandidates(channel, dbh, limit)`；塌缩与候选各自包 try/catch 永不向上抛（失败降级空段）。产品段在日报 `runDailyWorkflow()` 的单例锁（`acquireDigestLock(push_date)`）内执行，由该锁保 push_date 全局单例（不再需要独立 `product-digest:{channel}:{push_date}` 锁）。

**产品候选查询复用既有导出纯函数**：`selectProductCandidates(channel, dbh, limit=TOP_N)` 是导出纯函数（无 `now` 参数——跨天去重与时刻无关），日报直接 `import` 复用。**链接来源（回退链）**：候选查询的 SELECT MUST 含 `canonical_domain`、`github_repo`、`product_hunt_slug` 三键（`ai_products` 无 `url` 列），映射经导出纯函数 `resolveProductUrl` 按优先级回退产出 `canonicalUrl`：① `canonical_domain` → `https://<canonical_domain>`（沿用既有畸形校验：含 scheme/path/空白等畸形则落下一级）；② `github_repo`（归一 `owner/name`，恰两段非空）→ `https://github.com/<owner>/<name>`；③ `product_hunt_slug`（**含 `/` 或空白即判畸形、落 null**，否则直接拼）→ `https://www.producthunt.com/posts/<slug>`；三者皆空/畸形 → `canonicalUrl=null`。`resolveProductUrl` 产出的 `canonicalUrl` 仅供**渲染**，**不**参与 `daily-intel-pipeline` 的跨段去重对齐（后者用 `ai_products` 存储三键字段，见该 capability）。

**候选载体（供跨段去重对齐复用）**：`selectProductCandidates` 的 SELECT 已含 `canonical_domain`/`github_repo`/`product_hunt_slug` 三键（同时供 `resolveProductUrl` 与跨段对齐）；返回的每个产品候选 MUST **额外携带这三个存储键字段**（如在候选对象上附 `productMergeKeys: { canonicalDomain, githubRepo, productHuntSlug }` 可选字段；事件侧候选不填、保持共享候选类型可空）。`daily-intel-pipeline` 的跨段去重据此**从内存 `productsByChannel` 候选对象直接读三键**构建产品键集合，**无需回查 `ai_products`**（满足该 capability「复用 productsByChannel、不引入额外 DB 查询」约束）。三键仅作**确定性对齐键**，不改选品口径（条件/order/limit 一字不变）。回退链解决「纯 GitHub 仓库类产品（`canonical_domain` 空、仅 `github_repo`）在新品段丢官网链接」（生产实锤：`themartiano/luz`）。产品行渲染：中文译名（`name_zh ?? name`、回退英文）+ 中文简介要点行（`tagline_zh`，无则省略要点行）+ 官网链接（`canonicalUrl`，为 null 时降级纯标题，绝不渲染坏链接）。渲染层（`message.ts`）MUST NOT 改动——回退在选品层透明完成、渲染层只认 `canonicalUrl`。

**产品中文化前置步骤（capability product-chinese-digest）**：`ai_products` 提供中文展示列 `name_zh`（varchar，可空）+ `tagline_zh`（text，可空），既有产品 NULL = 未中文化、渲染回退英文 `name`。产品进入候选前必须经一次 **channel-blind 中文化前置步骤**（产品塌缩之后、per-channel 候选之前、搭日报单例锁、不独立调度）：中文化候选 = **各 channel 正式推送候选的精确并集**——直接复用 `selectProductCandidates`（每 channel 调用取 product_id）+ 应用层 `Set` 去重并集（消除覆盖边缘、非手写 SQL UNION 防谓词漂移），对并集中 `name_zh IS NULL` 且 `name !== '(unnamed product)'` 占位名（与 product-collapse 单一来源共享、防零信息诱发幻觉译名）的产品 LLM 产 `name_zh`/`tagline_zh` 落库；该步骤**永不向上抛**（对称塌缩零件、失败回退英文、不拖垮新闻、不进 events 熔断分母、整步失败规模异常单独告警可观测）；幂等（已中文化跳过 LLM）。中文化**只产展示文本、绝不改**塌缩/硬规则合并/merge_conflict/`selectProductCandidates` 选品口径（选品条件/order/limit 一字不变，仅映射 `representativeTitle = name_zh ?? name`、产品要点 = `tagline_zh`、`summary_zh` 仍 null）。

**跨天不重推候选窗口（与 event 同口径，绝不可省、绝不退化）**：选择进入推送的产品候选必须满足「该 `product_id` **从未被任何 `push_date` 以该 channel `success` 推送过**」（**按 channel 分判**：同一产品可分别进 telegram/feishu 候选）；「同日不重复」由唯一约束兜底，「跨天一产品一生只推一次」由本候选窗口 + dispatcher 的 `computePendingSet`（任一 push_date 该 channel success 排除）双层兜底，**并入日报后此口径不变**（绝不因并入变成天天重推）。

**处于未解决合并冲突态的产品必须排除出推送候选**：被标记 `merge_conflict` 的 `product_id` 必须排除出推送候选，直到 P3 跨行合并解决。**产品候选查询必须在产品塌缩阶段完成之后执行**（日报顺序子流程内：产品塌缩一次 → per-channel 产品候选 → 并入消息），确保 `merge_conflict` 标记对候选可见。

推送流程必须**复用 telegram-push/feishu-push 定义的同一套「待发→`pending`→原子送达→`success`/`failed`」状态机机制**（仅 `target_type` 与候选/幂等口径不同），禁止另写漂移状态机；唯一键冲突即跳过。**单条日报消息同时承载 event 与 product 两类待发集合时，必须各按自己的 `target_type` 计算待发、写 `push_records`、置终态**（event 行写 `target_type='event'`、product 行写 `target_type='product'`），绝不把产品记入 event 命名空间；且须遵守 `daily-intel-pipeline` 定义的分段 includedIds（截断不误标）、**方案 A 两段独立事务终态（event 先固化、product 失败不回滚 event）**、段级失败隔离契约。选择哪些产品进入推送由程序规则决定，禁止由 LLM 决定最终推送名单。

#### 场景:同一天同一产品不重复推送
- **当** 某产品当日已以某 channel `success` 推送（在日报消息的新品段内）
- **那么** 同 `push_date` 同 channel 再选候选时被唯一约束/待发集合排除，不重复出现在该日报消息

#### 场景:跨天一产品一生只推一次（并入日报后不退化）
- **当** 某产品因持续上榜、`last_seen` 天天刷新而连日进入候选池
- **那么** 候选查询按「该 `product_id` 从未以该 channel `success`」排除已推过的产品，仅首次出现在某日日报新品段，绝不天天重推

#### 场景:merge_conflict 产品排除出日报新品段
- **当** 某产品被标记 `merge_conflict`
- **那么** 产品候选查询（在产品塌缩之后执行）排除它，不进入日报新品段，直到跨行合并解决

#### 场景:产品作为日报新品段而非独立消息推送
- **当** 日报触发并存在当日新产品候选
- **那么** 产品以「新品段」并入同一条「AI Radar 每日情报」消息（与要闻段并列），不再产生独立的产品推送消息；产品行各按 `target_type='product'` 写 `push_records`

#### 场景:产品行链接来源回退链与降级
- **当** 渲染产品行
- **那么** 用候选查询经 `resolveProductUrl` 映射的 `canonicalUrl`，按优先级回退：`canonical_domain`（`https://<domain>`）→ `github_repo`（`https://github.com/<owner>/<name>`）→ `product_hunt_slug`（`https://www.producthunt.com/posts/<slug>`）；三者皆空/畸形则 `canonicalUrl=null`、降级为纯产品名，绝不渲染坏链接；产品段不调任何 LLM

#### 场景:纯 GitHub 仓库产品回退到 github 链接
- **当** 某产品 `canonical_domain` 为空但 `github_repo='owner/repo'`（如 Show HN 直链 github 的产品）
- **那么** `resolveProductUrl` 回退产出 `canonicalUrl='https://github.com/owner/repo'`，新品段渲染出官网链接（不再因 `canonical_domain` 空而丢链接）

#### 场景:独立 product-digest 调度链已移除
- **当** worker 启动注册调度链
- **那么** 不再注册独立 `product-digest` 队列/cron/单例锁；产品推送只经日报链承载

#### 场景:产品段失败不拖垮新闻段
- **当** 产品塌缩或产品候选查询失败
- **那么** 塌缩/候选各自捕获异常、记错误/告警、该日报新品段降级为空，新闻「要闻段」仍正常推送（产品段不进新闻摘要熔断分母、不拖垮整条日报）

#### 场景:产品塌缩只跑一次不随 channel 重复
- **当** 日报对多个 channel 各取产品候选
- **那么** 产品塌缩 `collapseUncollapsedProductRawItems` 在 channel 展开之前只调一次（channel-blind），各 channel 仅各调 `selectProductCandidates(channel)`；绝不每 channel 重复塌缩（避免违反产品塌缩单实例假设）

#### 场景:产品候选携带中文译名与简介
- **当** 已中文化（name_zh/tagline_zh 非 NULL）的产品进入某 channel 候选
- **那么** 候选映射标题为中文译名、要点为中文简介；未中文化（NULL）则回退英文 `name`、无要点

#### 场景:中文化前置不改选品口径
- **当** 执行产品中文化前置步骤
- **那么** 不改变 merge_conflict 排除 / 跨天从未 success 窗口 / order / limit 选品规则，仅补中文展示字段；中文化失败的产品仍按原规则入选（回退英文名）

#### 场景:中文化候选精确覆盖各 channel 推送候选
- **当** 某产品在 channel A 已 success 推过、在 channel B 从未 success（仍将进 B 推送候选）
- **那么** 该产品在中文化候选的各 channel 并集内、被中文化（不因 channel-blind 单窗 LIMIT 漏覆盖某 channel 第 N 名）

#### 场景:塌缩占位名产品不中文化
- **当** 某产品 `name` 为塌缩兜底占位 `(unnamed product)`
- **那么** 不进中文化候选（零信息输入会诱发 LLM 幻觉译名）、保持占位英文、渲染回退
