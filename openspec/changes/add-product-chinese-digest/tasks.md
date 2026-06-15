## 1. 前提复验（实现前钉死）

- [x] 1.1 复验 events 中文化模式（对称参照）：`src/agents/digest/{schema,index,persistence}.ts`——`summarizeEvent(input,{generateObjectFn?,maxAttempts?=3,logError?})` → `generateObject` + 独立 `safeParse` + 重试 + `DigestFailureError` 降级；persistence `UPDATE ai_news_events` set **仅含** summary_zh/headline_zh；schema `.max()` 与 prompt 共用常量、mojibake 检查（`src/agents/mojibake`）
- [x] 1.2 复验 schema 与输入源：`ai_products`（无中文列，有 name/canonical_domain/metadata/representative_raw_item_id）；`raw_items` 有 `content` 列（PH 存 `description||tagline`、Show HN content 常 NULL）；`ai_products.representative_raw_item_id → raw_items.id` 回指
- [x] 1.3 复验产品编排锚点：run-daily-workflow.ts 阶段 5.5（judge/digest 熔断后、早退前）`collapseProductsOnce`(channel-blind 一次) → per-channel `selectProductsForChannelSafe` → `productsByChannel`；`selectProductCandidates`(product-digest.ts:61) 映射 representativeTitle/summaryZh/headlineZh；`dailyTelegramProductBlock`(message.ts:497) 无要点行；飞书 `buildDailyFeishuCard` 产品段

## 2. 数据列（ai_products 加中文展示列）

- [x] 2.1 `src/db/schema.ts`：`aiProducts` 加 `nameZh: varchar('name_zh', { length: 255 })`（可空）+ `taglineZh: text('tagline_zh')`（可空）；不动既有列与唯一约束
- [x] 2.2 生成迁移：**必须 `drizzle-kit generate`**（禁手写裸 ALTER——否则 `meta/<idx>_snapshot.json` 漂移、后续 generate 重复 diff 这两列）；产出 `drizzle/0005_*.sql`（`ADD COLUMN name_zh varchar(255)` + `tagline_zh text`，均可空无默认、PG metadata-only 不锁表）+ 同步 `meta/0005_snapshot.json` + `_journal.json` 新 entry
- [x] 2.3 **部署防假绿（启动自检）**：启动或 `doctor` 自检 `ai_products.name_zh`/`tagline_zh` 列存在、缺则 fail-fast（明确报错）——**不依赖 `selectProductsForChannelSafe` 把「列不存在」静默 catch 成空新品段**（CI 连已迁移库永绿、生产漏迁移则空段 = 假绿）；部署流程钉死「迁移必先于读该列的代码发布」

## 3. 产品中文化 Agent（新 capability product-chinese-digest，对称 src/agents/digest）

- [x] 3.1 `src/agents/product-digest/schema.ts`：`productDigestOutputSchema = z.object({ name_zh, tagline_zh })`——`name_zh` 非空 + `.max(NAME_ZH_MAX = 120)`（中文译名短，列 varchar(255) 宽于 cap 仅作 DB 兜底）+ mojibake；`tagline_zh` 非空 + `.max(PRODUCT_TAGLINE_MAX = 100)` + mojibake；**`PRODUCT_TAGLINE_MAX`（定值 100）单一来源常量、schema `.max()` 与渲染截断（6.1/6.2）+ prompt 三处共用**（对称 events HEADLINE_MAX 既 schema cap 又渲染 cap，**禁 schema 与渲染用两个值**）；复用 `src/agents/mojibake` 检查
- [x] 3.2 `src/agents/product-digest/index.ts`：`summarizeProduct(input:{name:string; content?:string|null}, options?:{generateObjectFn?;maxAttempts?=3;logError?}): Promise<ProductDigestOutput>`——`buildModel()` + 产品语境 prompt（产中文译名 name_zh + 一句话中文简介 tagline_zh、只陈述事实/对开发者价值、不堆营销词、content 缺则仅凭 name）+ `generateObject` + 独立 `safeParse` + 有限重试；耗尽抛 `ProductDigestFailureError`（含 attempts/cause）；`generateObjectFn` 注入供 mock
- [x] 3.3 `src/agents/product-digest/persistence.ts`：`UPDATE ai_products SET name_zh=?, tagline_zh=? WHERE product_id=?`，`set` **仅含** name_zh/tagline_zh（禁碰 name/canonical_domain/metadata/merge/last_seen，禁 INSERT ON CONFLICT）；只在 Zod 校验通过后落库

## 4. 编排（channel-blind 中文化前置步骤）

- [x] 4.1 `src/pipeline/product-digest.ts` 新增 `digestPendingProducts(dbh, channels: Channel[]): Promise<void>`（pipeline 零件，**对称 collapseProductsOnce 永不向上抛**）：**候选 = 各 channel 正式推送候选的精确并集**（消除覆盖边缘、零「下次幂等补」依赖）——**直接复用 `selectProductCandidates`（对每个 channel 调用一次、取返回的 product_id）、在应用层 `Set<product_id>` 去重并集**（**非手写 SQL UNION/`NOT EXISTS(inArray)`**——复用既有查询路径而非重写谓词，杜绝谓词漂移〔AND-NONE 误写会漏「已推 tg 未推 feishu」〕、dedup 免费）；`channels` 为空 → Set 空 → 直接 return；对并集 product_id 中 **`name_zh IS NULL`** 且 **`name !== 占位常量`**（占位字面 `'(unnamed product)'` **与 product-collapse 单一来源共享常量**、防字面漂移；排除防零信息输入诱发 LLM 幻觉译名）的产品 **`LEFT JOIN raw_items ON representative_raw_item_id=raw_items.id`**（LEFT 非 INNER：representative_raw_item_id NULL/悬空的产品仍保留、content=NULL 仅凭 name 产中文）取 `content`，逐个 `summarizeProduct({name,content})` → persistence UPDATE
- [x] 4.1b **失败语义（编排契约，非内核同规格）**：单产品业务失败（`ProductDigestFailureError`）记 error/保持 NULL/继续下一个；整步永不向上抛（对称 collapseProductsOnce、保护新闻链）；但整步失败数/失败率异常须 `alert(...)` 单独告警（DB 断连等系统故障可观测、不静默黑洞）；**不进 events 熔断分母、不中止流水线**——与 events digest「非业务异常 rethrow + 降级率熔断」**不同规格**（仅 Agent 内核 summarizeProduct 与 summarizeEvent 同规格）
- [x] 4.2 `src/pipeline/run-daily-workflow.ts` 阶段 5.5：在 `collapseProductsOnce(dbh)` 之后、per-channel `selectProductsForChannelSafe` 之前，加 `await digestPendingProducts(dbh, channelSenders.map(c=>c.channel))`；**位置不变其余编排**（仍在熔断 throw 之后、早退之前、日报锁内）；中文化失败不进熔断分母、不中止

## 5. 选品映射（selectProductCandidates 读中文列）

- [x] 5.1 `src/pipeline/product-digest.ts` `selectProductCandidates`：SELECT 加 `nameZh: aiProducts.nameZh, taglineZh: aiProducts.taglineZh`；映射 `representativeTitle = r.nameZh ?? r.name`（中文优先回退英文）、`headlineZh = r.taglineZh ?? null`（承载产品要点；summaryZh 仍 null）；**选品条件/order/limit 一字不改**

## 6. 渲染（日报产品段中文译名 + 简介要点行）

- [x] 6.1 `src/push/message.ts` `dailyTelegramProductBlock`：产品名用 `representativeTitle`（已 name_zh??name）套 TITLE_MAX 截断；**新增要点行**——`headlineZh`(=tagline_zh) 存在则渲染一行（套 **`PRODUCT_TAGLINE_MAX`** code-point 截断 + escapeMarkdownV2，**非 events HEADLINE_MAX**——产品简介专属上限、与 3.1 schema cap 同一常量，避免 schema 允许 N 字却渲染截短的静默丢字）、不存在则省略（回退现状纯标题）
- [x] 6.2 飞书日报产品段（`buildDailyFeishuCard` 产品部分）：有 tagline_zh 加简介行（**同 `PRODUCT_TAGLINE_MAX` 截断、与 Telegram 口径一致**）、无则纯标题；双判据预算（实际序列化长度 + elements 数）口径不变

## 7. MCP（get_today 产品段中文字段）

- [x] 7.1 `src/mcp/tools/get-today.ts`：产品段 SELECT 加 `nameZh/taglineZh`；产品 DTO（digestItemSchema 产品项）`title = nameZh ?? name`、增 `tagline`（= taglineZh，可空）；outputSchema 同步；忠实呈现已推、缺则回退英文名/空简介

## 8. 测试（注入 mock，不真发生产、不真调 LLM）

- [x] 8.1 `src/agents/product-digest/__tests__/`：summarizeProduct 注入 generateObjectFn mock——成功（产 {name_zh,tagline_zh}）、校验不过（空/超长/mojibake）重试降级抛 ProductDigestFailureError；persistence UPDATE 仅写中文列（不碰塌缩列）
- [x] 8.2 `digestPendingProducts` 集成（连真库）：候选 = 各 channel 候选**精确并集**（merge_conflict 排除 / name_zh IS NULL / **UNION 覆盖各 channel per-channel top-N**——构造「已推 tg 未推 feishu」产品验证被覆盖）；**占位名 `(unnamed product)` 不入候选**；`channels` 空直接 return；**已 name_zh 跳过 LLM（幂等）**；注入 summarizeProduct mock 不真调 LLM
- [x] 8.3 `selectProductCandidates` 集成：中文化产品映射中文译名 + 要点；未中文化回退英文名 + 无要点；选品条件不变
- [x] 8.4 渲染单测：`dailyTelegramProductBlock` 有 tagline_zh 渲要点行 / 无则纯标题；飞书产品段同；中文名截断/转义正确
- [x] 8.5 MCP get_today 集成：产品段返回中文译名 + 简介；未中文化回退英文名/空简介（结构化形态正确）
- [x] 8.6 编排集成（run-daily 阶段 5.5）：中文化在塌缩后候选前；中文化失败不中止流水线、不进熔断分母、要闻段不受影响、产品回退英文照常推
- [x] 8.7 失败语义：单产品业务失败（ProductDigestFailureError）保持 NULL 继续、整步不抛；**系统级异常（DB 断连，非 ProductDigestFailureError）整步仍不抛但触发告警**（业务失败 vs 系统故障可观测区分）
- [x] 8.8 部署假绿守卫：`ai_products.name_zh` 列缺失时启动/doctor 自检 fail-fast（**不被 selectProductsForChannelSafe 静默吞成空新品段**）

## 9. 自验

- [x] 9.1 `npm run lint` 0 + `npx tsc --noEmit` 0 + `npx vitest run` 全绿（585 passed | 7 skipped / 50 文件）✓；迁移经 `drizzle-kit generate` 产出并在本地库应用成功（0005、无 snapshot 漂移）✓；新品段渲染中文（要点行）经测试覆盖 ✓；**部署不变量：迁移先于代码发布 + 启动自检 name_zh 列存在（assertProductZhColumns，worker-main 启动期，防生产漏迁移空段假绿）✓**

## 10. 提交与规范归档

- [ ] 10.1 提交代码（schema + 迁移 + src/agents/product-digest + pipeline + message + mcp + 测试）；含 src 实现 → **走 PR**
- [ ] 10.2 PR 合并后：`/opsx:sync` 将 4 个增量规范并入主规范（新增 product-chinese-digest；修改 product-discovery/daily-intel-pipeline/mcp-query）
- [ ] 10.3 PR 合并后：`/opsx:archive` 归档本变更（纯文档直推 main）
