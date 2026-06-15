## 上下文

P0–P2 已落地流水线与数据。本变更要复用而非重写的既有导出/事实（强对账已核实）：
- 选择/候选：`selectTopN`（`src/selection/top-n.ts:190`）、`selectProductCandidates`（`src/pipeline/product-digest.ts:61`）、`computePendingSet`（`src/push/dispatcher.ts:100`，**跨天 per-channel**「任一 push_date 该 channel success 即排除」）。
- 推送：`dispatchDigest`（`src/push/dispatcher.ts:139`，`(topN, options, dbh)`、options 含 now/sender/targetType?/channel?、先 pending→发→success/failed、唯一键冲突跳过、渲染走**单段** `renderDigest`）；日报实际经 `dispatchDailyDigest`（双段）推，但 `push_records` 四元组 `(target_type∈{event,product},channel,push_date)` 一致，故以 push_records 还原已推内容口径成立。
- **DB 列（强对账修正，关键）**：`ai_news_events`（schema.ts:88）列含 event_id/representative_title/summary_zh/headline_zh/`main_entities`(jsonb)/published_at/source_count/importance_score(numeric)/`should_push`(bool)/`judge_claimed_at`/representative_raw_item_id——**无 `metadata` 列、无 `source` 列**。`metadata` jsonb 仅在 `raw_items`(:64) 与 `ai_products`(:199)。`ai_products` 有 name/canonical_domain/`metadata`。`push_records`：target_type/target_id/channel/push_date/status。
- `SelectedEvent`（top-n.ts:43）：eventId/representativeTitle/summaryZh/headlineZh/**canonicalUrl(selectTopN 恒 null)**/publishedAt/rankScore。event 原文 url 由 `loadCanonicalUrls`（`run-daily-workflow.ts:190`，经 `representative_raw_item_id → raw_items.canonical_url`，**非导出本地函数**）填实。
- `resolveChannelSenders`：run-daily:637 / alert-scan:246 / weekly:479 **各私有一份（非导出），函数体相同但入参是 3 个不同 options 类型，且 run-daily 那份多一条 `sender ?? createTelegramSender()` 回退**（alert/weekly 无）——抽共享非纯 DRY、会改 3 个 pipeline 类型契约（触碰非目标「不改主流程」）。
- 产品链接渲染口径：`product-digest`/`message` 用 `canonical_domain` 经**严格 URL 校验**（host 须等于裸域、无 path/凭据/空白，畸形降级 null）拼 `https://`，**非裸拼**。
- `getPushDate`（push-date.ts:45）；`isFeishuEnabled`（env.ts:397，需 webhook+secret）。`@modelcontextprotocol/sdk` **未装**；`src/` 无 `mcp/`。
- **MCP SDK（TS）**：`McpServer` + `StdioServerTransport`，`server.registerTool(name, { description, inputSchema(zod raw shape), outputSchema?, annotations? }, handler)`，`await server.connect(transport)`；SDK 按 inputSchema **自动校验入参**；handler 返回 `{ content:[{type:'text',text}], structuredContent?, isError? }`；**声明 outputSchema 则 handler 必须返回 structuredContent 且被校验**。

## 目标 / 非目标

**目标**：建一个与流水线并列的**独立 MCP 查询进程**（`src/mcp/`，stdio），暴露 7 工具（5 只读查询 + 2 标记 + push_event_now），全工具 Zod 校验，复用既有 db/selection/dispatcher 导出，**绝不参与主流程调度**、**绝不改主流程文件**（sender/url helper 在 MCP 内自带、不动 pipeline）。满足 ROADMAP P4 退出标准。
**非目标**：见 proposal（不做 P5 顾问、不改主流程、不新增 schema 列、不做 HTTP/鉴权/Web、不建 KB）。

## 决策

### D1：进程结构与 transport
- `src/mcp/server.ts`：`McpServer` + `StdioServerTransport` 入口，注册全部 tool、`await connect`、**MCP 自建 drizzle 连接（import `src/db/schema.ts` 自建、见 D8、绝不复用 `src/db/index.ts` 全局-env 单例）**、优雅关闭（监听 SIGINT/SIGTERM **及 stdin/transport close**——Claude Desktop 退出多为关管道；关闭时 await 释放自建 db 池）。**不 import/注册任何 cron/BullMQ/worker/runDailyWorkflow**。
- `src/mcp/tools/*.ts`：每 tool 导出 `{ name, description, inputSchema, outputSchema?, annotations, handler }`；`server.ts` 统一 `registerTool`。

### D2：get_today_ai_digest = 查「已推事实」（忠实于已推内容）
- 以 `push_records`（`push_date=getPushDate(now)`、`status='success'`）为准：`channel` 默认取 **库中当日实际有 success 的 distinct channel**（`SELECT DISTINCT channel ...`，**不依赖 isFeishuEnabled() 等进程 env**——get_today 是只读查询，不该因 MCP 进程未配 feishu env 漏掉飞书已推记录）；可传 channel 过滤。按 target_type join `ai_news_events`(要闻段)/`ai_products`(新品段) 还原。orphan（push_records success 但 event/product 行已不存在）跳过、不报错。
- **链接忠实于已推**：event url 经 `loadCanonicalUrls` 等价逻辑（`representative_raw_item_id → raw_items.canonical_url`，可空则省略 url）；**product 链接须复用 product-digest 的同一 `canonical_domain→canonicalUrl` 严格映射（含 URL 校验、畸形降级 null），不得裸拼 `https://`+domain**——否则 get_today 给出与实际已推（畸形域时无链接）不一致的链接，违背「查已推事实」。
- **不重跑 selectTopN**；当日无 success → 返回空 + 文本「今日尚未推送」。

### D3：search_ai_events / search_ai_products / get_source_quality_report（只读）
- **search_ai_events**：Zod `{ q?, since?, until?, minImportance?, limit(默认20,上限100), offset(默认0) }`；参数化 SQL（drizzle 占位符）`representative_title/summary_zh ILIKE` + `published_at` 窗 + `importance_score>=`，`ORDER BY published_at DESC NULLS LAST` 分页。**`ai_news_events` 无 source 列、不按 source 过滤事件**（源维度见 get_source_quality_report）。`q` 拼 `%q%` 前**转义 LIKE 元字符 `%`/`_`/`\`**（防用户字面 `%` 当通配符致全表扫描）。
- **search_ai_products**：Zod `{ q?, domain?, limit, offset }`；`name`/`canonical_domain ILIKE`（同 LIKE 转义）分页。
- **get_source_quality_report**：按 source 聚合 `raw_items` 采集量 + 塌缩入 `ai_news_events` 数 + **被推送数（`COUNT(DISTINCT push_records.target_id WHERE status='success')` 经 event 关联回 source）** + 最近活跃时间。**source 归因口径（钉死）**：event↔source 唯一路径是 `ai_news_events.representative_raw_item_id → raw_items.source`（raw_items 无 event_id、无 item_event_relations）；故「塌缩入数/被推送数」按**代表源**归因，**多源塌缩事件仅计代表源、非全部贡献源**（全源归因留 P3）。**不用「入选 Top N 率」**——selectTopN 不落库、无法从 DB 算，以「被推送数」替代（与 proposal 统一）。source 基数有界（采集器级），无需分页。

### D4：mark_* / push_event_now
- **mark_event_not_relevant(eventId, reason?)**：`ai_news_events` **无 metadata 列**，故**只置 `should_push=false`**（`UPDATE ... SET should_push=false WHERE event_id=?`）；`reason` 仅记 stderr 日志/返回信息、**不入 DB**（不新增列、不误用 main_entities）。其退出候选**稳定**：Value Judge「只处理 `*_score IS NULL`」（已评分事件不重判，见 daily-intel-pipeline），mark 时该 event 已评分 → `should_push=false` 不会被 re-judge 覆盖。命中 0 行（eventId 不存在）→ 返回 `isError:true` + 提示，不静默成功。
- **mark_product_interesting(productId, note?)**：`ai_products` **有 metadata 列**，`UPDATE ai_products SET metadata = COALESCE(metadata,'{}'::jsonb) || jsonb_build_object('interesting', jsonb_build_object('at',now,'note',note)) WHERE product_id=?`；幂等、不加列。命中 0 行→`isError:true`。
- **push_event_now(eventId, channel?)**：读 event（不存在→`isError:true`）→ 构造单元素 `SelectedEvent`（`canonicalUrl` 经 MCP 自带 loadCanonicalUrls 等价填、缺则无链接）→ **handler 内 `await import('../push/dispatcher.js')` + 动态 import sender 工厂（telegram/feishu）惰性加载推送链**（env `parseEnv` 崩/缺 token 在此 catch→`isError`，见 D8）→ 调 `dispatchDigest([event], { now, sender, channel, targetType:'event' }, mcpDb)`（**dbh 传 MCP 自建连接、单段 `renderDigest` 非日报双段**——人工即时推的预期形态）。复用其幂等（该 channel 已 success → 唯一键跳过）。各 channel 独立 try/catch（一个失败不拖另一个、按 channel 报对应缺失 env 名）、返回各 channel outcome；纯查询不调本工具则永不加载推送链。

### D5：MCP 输出/校验/错误契约（SDK 集成层）
- **输出结构（per-tool 二分）**：查询工具（get_today/search_*/get_source_quality_report）**声明 `outputSchema`（zod raw shape）+ handler 同时返回 `structuredContent: dto` 与向后兼容的 `content:[{type:'text',text:JSON.stringify(dto)}]`**（声明 outputSchema 则 SDK 强制校验 structuredContent）；mark_*/push_event_now 结果即一句 outcome，**只返回 `content` 文本、不声明 outputSchema**。
- **Zod 分层（避免重复/越界）**：入参校验=**SDK 依 inputSchema 自动完成**（handler 内不再 `parse(args)`）；出参校验=handler 内对 DB 行→DTO **自行 zod parse**（查询工具该 DTO 即 outputSchema/structuredContent 来源）。
- **annotations**：查询工具 `readOnlyHint:true`；mark_* `readOnlyHint:false, idempotentHint:true`（幂等覆盖、非破坏）；push_event_now `readOnlyHint:false, destructiveHint:true`（真发外部消息）+ `idempotentHint:true`（dispatcher 幂等）。
- **错误约定（isError vs throw）**：业务可恢复错误（缺 token / 目标 id 不存在）→ 返回 `{ isError:true, content:[{type:'text',text:人类可读 message（含缺失 env 名等可操作信息）}] }`，**不 throw**（不断连接，错误路径不需 structuredContent）；仅协议级/不可恢复异常才让其冒泡。**注：event 无代表源 url（canonicalUrl 缺）不算错误——照常推送/还原、渲染回退仅标题，非 isError（与 D2/D4「缺则无链接」一致）。**

### D6：sender / url helper —— MCP 内自带（守「不改主流程」非目标）
- **默认：在 `src/mcp/` 内自带** `loadCanonicalUrls`、product `canonical_domain→canonicalUrl` 严格映射（`new URL` 校验 host===裸域、畸形降级 null）、**`getPushDate` 等价（按 MCP 宽松 env 的 optional `PUSH_TIMEZONE`、default Asia/Shanghai——与主链 push_date 写入口径同源、避免时区漂移；纯 string env、零推送/采集 token 风险）**、`resolveChannelSenders` **解析逻辑** 的等价小实现，**不动 run-daily/alert-scan/weekly/product-digest/push-date 等文件**。其中 `resolveChannelSenders` 调用的 **sender 工厂**（`createTelegramSender`/`createFeishuSender`——`telegram.ts:12`/feishu 顶层 import 全局 env+grammy）**不自带、改为 push_event_now handler 内动态 import**（见 D8，避免污染查询链）；其余（loadCanonicalUrls/product 映射/getPushDate）零 env、查询链 top-level 自带。接受这些少量重复（局限新代码、零主流程触碰）。
- **event url 与 product 链接机制不同（勿互套）**：event 读 `raw_items.canonical_url`（采集期已规范化、不再现场校验）；product 是 `canonical_domain` 现拼 `https://` + 严格校验。
- 「抽共享 DRY」降级为**后续独立重构提案**，不混进本查询特性 PR。

### D7：stdio 进程纪律（stdio MCP 头号坑）
- **stdout 禁污染**：stdio server 的 stdout 是 JSON-RPC 专用通道——**禁止任何 `console.log`/库 stdout 输出/启动横幅落 stdout**，所有日志/诊断一律 stderr（`console.error`/`process.stderr`）。**须核查复用链路**（dispatcher/selection/db/getPushDate 等）有无 import-time 或运行时 stdout 日志，有则改 stderr 或注入静默 logger；并核查 `src/db`/`src/push` 有无 import-time 副作用（top-level 建连接/queue）污染或拖慢启动。
- **SDK 版本**：`tasks` 执行时 `npm view @modelcontextprotocol/sdk dist-tags` 确认并锁 **latest 稳定版（非 prerelease/alpha）**；若 latest 跨大版本则现场复验 registerTool/outputSchema/annotations 形态。
- 生命周期见 D1（SIGINT/SIGTERM + stdin/transport close + 关 db 池）。

### D8：不参与调度 + 专用宽松 env + 自建连接 + 查询链零全局-env / push 链动态加载（守纯查询只需 DATABASE_URL）
**传递 import 陷阱（必须堵死）**：`src/config/env.ts:387 export const env = parseEnv(process.env)` import 即校验，TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID（:189-194）/PRODUCT_HUNT_TOKEN（:262-264）均 required。而 `dispatcher.ts:29` 顶层 import `db/index.ts`（→env）、`:32` import `push-date.ts`（`push-date.ts:14` import env）、`top-n.ts:33/35` import db/index+env、`telegram.ts:12` import env——**任何 MCP 模块在 top-level `static import` 这些，import 期即跑 `parseEnv` 崩纯查询**。仅「不直接 import db/index.ts」不够（实测：`import dispatcher.ts`/`import push-date.ts` 在仅 DATABASE_URL 时即 THROW）。

- **专用宽松 env + 自建连接**：MCP 专用轻量 env 解析——只硬性 require `DATABASE_URL`（**保留其形态校验：非空 + 合法连接串**，与主应用同口径；telegram/feishu/product_hunt token 设 optional）+ import `src/db/schema.ts`（纯表定义、零 env）自建 `drizzle(new Pool({ connectionString }), { schema })`。
- **查询链 + mark_* 零全局-env 依赖**：get_today/search_*/get_source_quality_report/mark_* 只 import `schema.ts` + 自建连接 + **MCP 自带 `getPushDate` 等价**（读 MCP 宽松 env 的 `PUSH_TIMEZONE`、default Asia/Shanghai、与主链同口径、**不 import `push-date.ts`/全局 env**）；**server.ts top-level 只 static import 查询/mark handler 与 schema.ts，绝不 static import dispatcher/push-date/top-n(value)/telegram/feishu 等触达全局 env 的模块**（push_event_now 的 handler 模块顶部亦不 static import dispatcher——dispatcher 在其 handler 内动态 import；server.ts 注册该 handler 函数本身不触发推送链加载）。→ **纯查询只需 DATABASE_URL**。
- **push_event_now 的 env 依赖范围（澄清）**：handler 内 `await import('../push/dispatcher.js')` 会触发 `dispatcher`→`db/index.ts`/`push-date.ts` 的全局 `parseEnv`——它校验的是**全部** required env（不止 telegram，含 REDIS_URL/LLM_API_KEY/LLM_MODEL/PRODUCT_HUNT_TOKEN 等）；缺**任一**→动态 import reject→`try/catch` 兜成 `isError`（含缺失变量名）。即 **push_event_now 要工作需配齐与 worker 同的全部 required env，纯查询则只需 DATABASE_URL**。
- **push_event_now 动态加载推送链**：在其 **handler 内**用 `await import('../push/dispatcher.js')`（连同 sender 工厂 `await import('../push/telegram.js')`/`feishu.js`）惰性加载——env `parseEnv` 崩推迟到 **push 首次调用时**（用户调 push 必然要配推送 token），缺 token / 动态 import throw 时 **catch → 返回 `isError`**（含缺失 env 名、按 channel 报对应变量）；**纯查询不调 push 则永不加载推送链、不崩**。dispatchDigest 第三参 `dbh` 传 MCP 自建连接（避免用其 defaultDb 全局单例）。
- **启动 fail-fast**：`DATABASE_URL` 缺失/畸形 → `process.stderr.write` 明确消息（变量名 + 提示配在 mcpServers.env）后 `process.exit(1)`，**在 connect(transport) 之前、绝不经 stdout**。
- **运行期错误归 isError 不冒泡**：DB 连接/查询失败、查询工具出参 DTO zod parse 失败（脏行）→ 跳过该行或返回 `isError`+stderr 日志，**不让未捕获异常冒泡断 JSON-RPC 连接**。
- 查询只读 SQL（代码+review 保证）；不持有 cron/queue/lock；优雅关闭 `shutdown()` **幂等**（SIGINT/SIGTERM/stdin/transport close 任一汇聚、只 `pool.end()` 一次）。

## 风险 / 权衡

- **[stdout 污染]（stdio 头号坑）** → D7：日志全 stderr + 核查复用链路 stdout 输出 + import 副作用。自验须 MCP inspector/Claude 实连一次确认 list_tools 正常（无污染）。
- **[mark_event 无审计 metadata]** → ai_news_events 无 metadata 列；只 should_push=false（reason 仅日志/返回不入 DB）。要 DB 审计须加列（违反非目标），本期不做。should_push=false 退出候选稳定（已评分不重判）。
- **[sender/url helper 重复]** → D6 选 MCP 内自带（守不改主流程），接受少量重复；抽共享留后续提案。
- **[查询只读靠纪律]** → 无 DB 只读角色，靠代码 + review；本地单用户 stdio 可接受。
- **[LIKE 元字符]** → q 转义 `%`/`_`/`\` 防全表扫描（非注入，注入由占位符挡）。
- **[get_source_quality_report 口径]** → 入选率口径已在 D3 钉死（避免 spec MUST 悬空）。

## 迁移计划

含代码、无 schema 迁移：
1. `npm i @modelcontextprotocol/sdk`（锁 latest 稳定版；zod 已有）。
2. `src/mcp/server.ts`：McpServer + StdioServerTransport + 注册 7 tool + connect + 优雅关闭；**MCP 专用宽松 env（只 require DATABASE_URL）+ import `src/db/schema.ts` 自建 drizzle 连接（不复用 db/index.ts 的全局-env 单例）**；**日志全 stderr**。
3. `src/mcp/tools/*.ts`：7 tool（inputSchema + 查询工具 outputSchema + annotations + handler）；MCP 内自带 resolveChannelSenders/loadCanonicalUrls/product 严格映射 等价实现。
4. `package.json` 加 `"mcp"` script + dep。
5. 测试：查询 tool 连真库（today 已推/未推、search +LIKE 转义+分页上限、source-report）；mark_event 验 should_push=false + 不存在→isError、mark_product 验 metadata + 不存在→isError；push_event_now 注入 sender mock + 钉 channels（**不真发生产**）验未推→success/已推→幂等跳过/单段 renderDigest/未配 token→isError/部分 channel 失败隔离；Zod 入参非法被拒；outputSchema/structuredContent 形态。
6. 文档：README 给 Claude Desktop/Cursor `mcpServers` JSON（`command:"tsx"` 直指 server.ts 非 npm、`cwd`、`env` 传 DATABASE_URL 等；说明 dotenv 与 cwd 依赖）+ 7 工具 description（每条讲清何时用 + 关键约束：get_today=查已推非重选、search 无 source 维度、push_event_now 真发推送）。
7. 自验 tsc/lint/vitest + MCP inspector/Claude 实连确认无 stdout 污染、list_tools/查一次当日日报通。

**回滚**：删 `src/mcp/` + package.json script/dep；无 schema 迁移、无主流程改动，纯增量可逆。

## 待解决问题

- 无阻塞性待解决项（source-quality 入选率口径、sender/url helper 去留、mark_event 无 metadata 处理、outputSchema 契约、stdout 纪律均已在 D2–D8 钉死）。
- SDK 具体版本与 registerTool/outputSchema/annotations 形态以 tasks 执行时 `npm view` 实测为准（D7）。
