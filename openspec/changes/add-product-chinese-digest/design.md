## 上下文

要闻段经 `chinese-digest-agent`（`src/agents/digest/`：`summarizeEvent` → `generateObject` + Zod 校验 + 重试 + `DigestFailureError` 降级；`persistence.ts` UPDATE `ai_news_events` 仅 summary_zh/headline_zh）产中文标题 + 简介；产品段无任何中文化——`ai_products` 无中文列，`selectProductCandidates`（product-digest.ts:61）映射 `representativeTitle=name`(英文)、`summaryZh/headlineZh=null`，日报 `dailyTelegramProductBlock`（message.ts:497）只渲染「序号 + 产品名 + 官网链接、无要点行」。

现有锚点（实现须对齐）：
- 产品编排在 run-daily-workflow.ts **阶段 5.5**（:466-490）：judge/digest 熔断 throw（:456）之后、早退之前，`collapseProductsOnce(dbh)`（channel-blind 一次）→ per-channel `selectProductsForChannelSafe` → `productsByChannel` Map → 早退（pushable 空 ∧ 所有 channel 产品候选空）→ `dispatchDailyDigest`。
- `selectProductCandidates`（product-digest.ts:61，函数声明行）per-channel 候选谓词：`metadata->'merge_conflict' IS NULL` ∧ `neverSuccessfullyPushed`（该 channel 从未 success，:68-80）+ `ORDER BY last_seen_at DESC NULLS LAST, product_id` + `LIMIT env.TOP_N`（默认 8）。
- 中文化输入源：`ai_products.name`（塌缩首建自 raw_item.title；终极兜底占位 `'(unnamed product)'`，见 product-collapse.ts）+ `raw_items.content`（PH 存 `description || tagline`——二选一；Show HN content 恒 null、退回 name），经 `ai_products.representative_raw_item_id → raw_items.id` 回指。
- events digest 失败契约（编排层，persistence.ts）：业务失败（`DigestFailureError`）降级（fallback/dropped），**非业务异常（DB 断连等）rethrow**；run-daily digest 阶段有降级率熔断（:456-464，超阈 `throw WorkflowAbortError`）。
- **周报新品段**：`weekly-report.ts` 的 `selectWeeklyProducts`（:304）是与 `selectProductCandidates` **独立**的 SQL，仅 SELECT name（英文）、映射 headlineZh=null，**不读中文列**——本提案改 selectProductCandidates 不影响它（见非目标）。
- migrations 走 `drizzle-kit generate`（`drizzle/` + `meta/_journal.json` + `meta/<idx>_snapshot.json`，下一号 0005；先例 0003 `ADD COLUMN headline_zh text` 同形）。

## 目标 / 非目标

**目标：**
- 日报产品获得中文译名 + 简介（落 `ai_products` 中文列），日报新品段 + MCP get_today 渲染中文（缺则回退英文名）。
- 中文化 Agent **内核** 与 events digest 同规格（结构化 JSON + Zod 校验 + 重试 + 降级信号 + 注入 mock）。
- 幂等缓存复用（已中文化产品不重复调 LLM）；失败回退英文名、不阻塞推送、不进 events 熔断分母。

**非目标：**
- 不改产品塌缩/硬规则合并/merge_conflict/`selectProductCandidates` 选品口径（仅补中文展示字段）。
- 不把确定性状态（should_push/推送幂等四元组/塌缩）交 LLM。
- 不批量回填历史存量产品中文、不批量补推旧产品（时效性）。
- **周报新品段本期不中文化**（已知缺口、非收益）：`selectWeeklyProducts` 是独立 SQL、不读中文列，本提案不改它 → 周报新品段实装后仍英文；如需对齐另立提案（对称改 selectWeeklyProducts 的 SELECT + 映射）。

## 决策

### D1 数据列：ai_products 加 name_zh + tagline_zh（nullable，drizzle generate，无破坏迁移）
`ai_products` 加两列：`nameZh: varchar('name_zh', { length: 255 })`（中文译名，对称英文 `name` 长度）+ `taglineZh: text('tagline_zh')`（中文简介，长度由 schema 上限挡）。均 **nullable**：既有产品 NULL = 未中文化 → 渲染回退英文 `name`/无要点。**迁移必须经 `drizzle-kit generate` 产出 `0005_*.sql` + 同步 `meta/0005_snapshot.json` + `_journal.json` 新 entry（禁**手写** ALTER——否则 snapshot 漂移、后续 generate 重复 diff 这两列；注：generate 自动产出的 bare `ALTER TABLE ADD COLUMN`〔如先例 0003〕本身是合规产物、不属「手写」）**。nullable 无默认 ADD COLUMN 在 PG 是 metadata-only、不锁表重写。**不动** name/canonical_domain/metadata/merge 列与既有 3 个 UNIQUE 约束（新列与唯一约束正交）。

### D2 中文化 Agent 内核：新建 src/agents/product-digest/（对称 chinese-digest）
新建目录 `src/agents/product-digest/`，三文件对称 `src/agents/digest/`：
- **schema.ts**：`productDigestOutputSchema = z.object({ name_zh, tagline_zh })`——`name_zh` 非空 + `.max(NAME_ZH_MAX = 120)`（中文译名通常短；列 varchar(255) 宽于 cap、仅作 DB 兜底）+ mojibake 检查（复用 `src/agents/mojibake`）；`tagline_zh` 非空 + `.max(PRODUCT_TAGLINE_MAX = 100)` + mojibake。**`PRODUCT_TAGLINE_MAX`（定值 100）是单一来源常量、schema `.max()` 与渲染截断（D5）+ prompt 三处共用**（一句话产品简介、适配 Telegram 单条；对称 events `HEADLINE_MAX` 既是 schema cap 又是渲染 cap 的不变量，**不得 schema 与渲染用两个值**）。
- **index.ts**：`summarizeProduct(input:{ name:string; content?:string|null }, options?:{ generateObjectFn?; maxAttempts?=3; logError? }): Promise<ProductDigestOutput>`——`buildModel()` + 产品语境 prompt（产中文译名 name_zh + 一句话中文简介 tagline_zh、只陈述事实/对开发者价值、不堆营销词、content 缺则仅凭 name）+ `generateObject` + 独立 `safeParse` + 有限重试；耗尽抛 `ProductDigestFailureError`（对称 DigestFailureError，含 attempts/cause）。`generateObjectFn` 注入供 mock。
- **persistence.ts**：`UPDATE ai_products SET name_zh=?, tagline_zh=? WHERE product_id=?`，`set` **仅含** name_zh/tagline_zh（禁碰 name/canonical_domain/metadata/merge_conflict/last_seen，禁 `INSERT ... ON CONFLICT`）；只在 Zod 校验通过后落库（两列同一次原子 UPDATE，不存在「name_zh 填而 tagline_zh NULL」半截态）。

### D3 编排零件：digestPendingProducts —— per-channel 候选并集驱动（消除覆盖边缘）
run-daily 阶段 5.5 在 `collapseProductsOnce(dbh)` **之后**、per-channel `selectProductsForChannelSafe` **之前**，加 `await digestPendingProducts(dbh, channelSenders.map(c=>c.channel))`（channel-blind 一次、搭日报锁、不独立调度）。新增于 product-digest.ts（pipeline 零件，**对称 collapseProductsOnce「永不向上抛、产品失败不拖垮新闻」**）：
- **候选 = 各 channel 正式推送候选的精确并集**（消除「channel-blind 单窗 + LIMIT」的覆盖边缘）：**直接复用 `selectProductCandidates`（对每个 channel 调用一次、取其返回的 product_id）**、在**应用层用 `Set<product_id>` 去重并集**（**非手写 SQL UNION**——复用既有查询路径而非重写谓词，杜绝两处谓词漂移〔SA/DBO 指出的重复谓词风险〕、dedup 免费、channels 空则 Set 空）；这样中文化集 ⊇ 各 channel 正式候选（top-N），**精确覆盖本批将推产品、零边缘、不依赖「下次幂等补」**。
- 对并集 product_id 中 **`name_zh IS NULL`**（幂等：已中文化跳过）**且 `name !== 占位常量`**（排除塌缩兜底占位名——零信息输入会诱发 LLM 幻觉译名、反比回退英文更糟；占位字面 `'(unnamed product)'` 须与 product-collapse **单一来源共享常量**、防字面漂移）的产品，**`LEFT JOIN raw_items ON representative_raw_item_id=raw_items.id`**（LEFT 非 INNER：representative_raw_item_id 为 NULL/悬空的产品仍保留、content=NULL 仅凭 name 产中文；INNER 会静默挤出致其永英文）取 `content`，逐个 `summarizeProduct({name,content})` → persistence UPDATE。
- `channels` 为空（无 enabled channel）→ 并集空 → **直接 return、不下发查询、不中文化**。
- **失败语义**（见 D7）：单产品业务失败（`ProductDigestFailureError`）记 error/告警、保持 name_zh NULL、继续下一个；整步永不向上抛（对称 collapseProductsOnce）；但整步内若失败数异常须单独告警（系统级故障可观测，见 D7）。

### D4 选品映射：selectProductCandidates 读中文列 + 回退映射
`selectProductCandidates` 的 SELECT 加 `nameZh: aiProducts.nameZh, taglineZh: aiProducts.taglineZh`；映射改：`representativeTitle = r.nameZh ?? r.name`（中文译名优先、回退英文）、`headlineZh = r.taglineZh ?? null`（**复用 `SelectedEvent.headlineZh` 承载产品要点行**——在 product 语境 headlineZh 语义 = 产品简介；`summaryZh` 仍 null。此为 SelectedEvent 字段的语境复用，须在代码注释钉死语义映射）。**选品条件（merge_conflict 排除 + 跨天从未 success + order + limit）一字不改**；`target_id=product_id`（product-digest.ts:126，非 title）→ representativeTitle 改中文不污染推送幂等四元组。

### D5 渲染：日报产品段渲染要点行 + 回退（截断用 PRODUCT_TAGLINE_MAX）
`dailyTelegramProductBlock`（message.ts:497）改：产品名用 `representativeTitle`（已 name_zh ?? name）套 TITLE_MAX 截断；**新增要点行**——`headlineZh`（= tagline_zh）存在则渲染一行，**套 `PRODUCT_TAGLINE_MAX` code-point 截断**（**非 events 的 HEADLINE_MAX**——产品简介专属上限，与 D2 schema cap 同一常量，避免「schema 允许 N 字却渲染截到 80」的静默丢字）+ escapeMarkdownV2；不存在则省略（回退现状纯标题）。飞书日报产品段（`buildDailyFeishuCard` 产品部分）同步：有 tagline_zh 加简介行（**同 `PRODUCT_TAGLINE_MAX` 截断**、与 Telegram 口径一致）、无则纯标题；双判据预算（实际序列化长度 + elements 数）不变。

### D6 MCP：get_today 产品段加中文字段（近似语义标注）
`src/mcp/tools/get-today.ts` 产品段 SELECT 加 `nameZh/taglineZh`；产品 DTO（digestItemSchema 产品项）`title = nameZh ?? name`、增 `tagline`（= taglineZh，可空）；outputSchema 同步；缺则回退英文名/空简介。**近似语义（须在 spec/注释标注）**：get_today 以 `push_records`(success) 还原已推事实但 join `ai_products` **当前值**（push_records 不存渲染文本快照）——产品以英文推送后若 later 被中文化，get_today 会显示中文（与当时推的英文不完全一致）。这是既有「join 当前值还原」的固有近似（events 同理），**非本提案引入的新缺陷**；实务中产品在 dispatch 前已中文化（阶段 5.5），多数情况推时即中文、不一致仅限「失败回退英文推 + 另 channel 次日补中文」的边缘。

### D7 失败语义分层 / 部署不变量 / 时效 / 熔断
- **失败语义分层（区分内核与编排，破「同规格」误导）**：**Agent 内核**（summarizeProduct）与 events `summarizeEvent` 同规格（Zod/重试/`ProductDigestFailureError` 降级信号）；**编排零件**（digestPendingProducts）对称 `collapseProductsOnce`（永不向上抛、产品失败不拖垮新闻、不进熔断）——**非** events `digestEvent` 的「非业务异常 rethrow + 降级率熔断」模型。两者**编排契约不同规格**，spec 须分层讲清，不得让实现者照抄 events rethrow。
- **系统异常可观测**：digestPendingProducts「永不抛」会吞掉 DB 断连等系统异常（保护新闻链不被拖垮）——代价是系统级故障可能静默。故整步须**对失败数/失败率异常单独告警**（`alert(...)`，不进 events 熔断分母、不中止流水线，但不留「全产品中文化失败却完全无声」的黑洞）。
- **部署不变量（防迁移假绿）**：name_zh/tagline_zh 列**必须先于读取它们的代码部署**（迁移先行）。否则代码 `SELECT nameZh` 命中不存在列 → selectProductCandidates 抛 → selectProductsForChannelSafe catch 吞成空段 → 新品段静默全空（CI 连已迁移库永远绿、生产漏迁移则空段——典型假绿）。缓解：① 部署流程钉「先迁移后发布」；② 启动/`doctor` 自检 name_zh 列存在、缺则 fail-fast（而非靠 selectProductsForChannelSafe 静默吞）。
- **时效（既有债务标注）**：产品段推送候选（既有 `selectProductCandidates`）用「跨天从未 success」、**无 published_at/last_seen 时效闸**，与 events（commit 15573c8 改用 published_at 闸）**不对称**——老产品若从未推过仍可被推。本提案 D4「选品口径一字不改」→ **不引入、不恶化**此既有债务（中文化集 = 推送候选并集、不多拉老产品）；修此既有债务留后续提案。
- **熔断隔离**：events digest 熔断（降级率超阈中止，run-daily:456）是 events/judge 独立分母；阶段 5.5 在熔断 throw 之后执行、拿不到熔断累加变量 + digestPendingProducts 永不抛 → 产品中文化失败**结构性不进熔断分母、不中止流水线**。

### D8 中文化输入来源
输入 `content` 经 `ai_products.representative_raw_item_id → raw_items.content`（PH = `description || tagline` 二选一；Show HN content 恒 null）。content 为 null 时 `summarizeProduct` 仅凭 name 产中文（prompt 容许无正文）；name 为占位 `(unnamed product)` 的产品已在 D3 候选排除、不中文化。

## 风险 / 权衡

- **覆盖边缘已消除**：D3 改为「per-channel 候选并集驱动中文化」后，中文化集 = 各 channel 正式推送候选的精确并集，**不再有「channel-blind OR 单窗 + LIMIT TOP_N 漏覆盖 per-channel 第 N 名」的边缘**，也不依赖「下个 push_date 幂等补」（该自愈对「已推 channel」本不成立——已 success 不重推、英文不可逆）。代价：digestPendingProducts 内对每 channel 跑一次候选 product_id 查询（纯读、产品量十余个、可忽略）。
- **周报新品段不受益（已知缺口）**：`selectWeeklyProducts` 独立 SQL 不读中文列，本提案不改它 → 周报新品段仍英文。这是有意聚焦日报、明确列为非目标的已知缺口（非「自然受益」）；对齐周报另立提案。
- **时效既有债务**：产品段沿用既有「跨天从未 success」无时效闸口径（见 D7），与 events 不对称、本提案不修（不引入/不恶化）。
- **迁移假绿**：见 D7 部署不变量——靠「先迁移后发布」+ 启动自检防护，不靠 CI（CI 库已迁移、测不出生产漏迁移）。
- **MCP 近似**：get_today 中文字段反映查询时当前值、非推送快照（见 D6），既有 join-current 近似、非新缺陷。
- **LLM 成本**：每入选产品一次（幂等缓存后稳态每产品首次）；产品量远小于 events，成本可忽略；复用 events 重试/降级、不新增基础设施。
- **content 质量**：Show HN content 恒 null、仅凭英文标题产中文，质量依赖标题信息量；可接受（标题描述性强），不为此抓正文。
