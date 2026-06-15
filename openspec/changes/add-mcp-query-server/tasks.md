## 1. 前提复验（实现前钉死）

- [x] 1.1 复验既有导出：`selectTopN`(top-n.ts:190)、`selectProductCandidates`(product-digest.ts:61)、`dispatchDigest`(dispatcher.ts:139，**单段 `renderDigest`**、先 pending→发→success/failed、唯一键跳过)、`computePendingSet`(dispatcher.ts:100，**跨天 per-channel**)、`getPushDate`(push-date.ts:45)；**`loadCanonicalUrls`(run-daily-workflow.ts:190) 与 `resolveChannelSenders`(run-daily:637/alert-scan:246/weekly:479) 均为 pipeline 内私有非导出（resolveChannelSenders 三处入参异构、run-daily 多 sender 回退）→ 本期 MCP 内自带等价实现、不动 pipeline**
- [x] 1.2 复验 schema：**`ai_news_events` 无 `metadata` 列、无 `source` 列**（有 `main_entities` jsonb / `should_push` / `importance_score` numeric / `representative_raw_item_id` / `published_at`）；`ai_products` **有** `metadata` jsonb + name/canonical_domain；`push_records`(target_type/target_id/channel/push_date/status)；产品链接渲染口径=`canonical_domain` 经**严格 URL 校验**拼 https（畸形降级 null、非裸拼）
- [x] 1.3 `@modelcontextprotocol/sdk` **未装**；`npm view @modelcontextprotocol/sdk dist-tags` 确认并锁 **latest 稳定版（非 prerelease/alpha）**；确认 `McpServer`/`StdioServerTransport`/`registerTool(name,{description,inputSchema(zod raw shape),outputSchema?,annotations?},handler)`/`server.connect`/handler 返回 `{content,structuredContent?,isError?}` 形态（**声明 outputSchema 则必返 structuredContent**）；**复验 inputSchema 收 zod raw shape（`{k:z.x()}`）非 `z.object(...)`、handler 签名 `(args, extra)`**；确认 `src/db/index.ts` import 全局 `env`（require telegram/product_hunt token）→ MCP 不复用、改 import `schema.ts` 自建连接

## 2. 进程脚手架 + stdio 纪律

- [x] 2.1 `npm i @modelcontextprotocol/sdk`（锁 stable 版；zod 已有）
- [x] 2.2 `src/mcp/server.ts`：`McpServer`+`StdioServerTransport`+`connect`+优雅关闭（SIGINT/SIGTERM **及 stdin/transport close**、关闭 await 释放 db 池）；**MCP 专用宽松 env 解析（只硬 require `DATABASE_URL`、telegram/feishu/product_hunt token optional）+ import `src/db/schema.ts` 自建 `drizzle(new Pool({connectionString:process.env.DATABASE_URL}),{schema})`——绝不复用 `src/db/index.ts` 全局-env 单例（其 import 即 require telegram/product_hunt token、崩纯查询）**；**所有日志/诊断/横幅一律 stderr、禁 stdout 写任何非 JSON-RPC 内容**；**server.ts top-level 绝不 static import `dispatcher`/`push-date`/`top-n`(value)/`telegram`/`feishu`（均顶层 import 全局 env、会 import 期崩纯查询）；MCP 自带 `getPushDate` 等价（读宽松 env `PUSH_TIMEZONE`、default Asia/Shanghai、与主链同口径）供查询链；`DATABASE_URL` 缺失/畸形 → `process.stderr` 报错 + `process.exit(1)` 于 connect 之前**；优雅关闭 `shutdown()` 幂等（多触发源只 `pool.end()` 一次）；**不 import/注册任何 cron/BullMQ/worker/runDailyWorkflow**
- [x] 2.3 `package.json` 加 `"mcp": "tsx src/mcp/server.ts"`（本地调试用；客户端配置用 command:"tsx" 直连）
- [x] 2.4 `src/mcp/tools/` 目录：每 tool 导出 `{ name, description, inputSchema(zod), outputSchema?, annotations, handler }`，`server.ts` 统一 `registerTool`
- [x] 2.5 **核查 stdout 污染**：复用链路（dispatcher/selection/db/getPushDate 等）有无 stdout 日志（`console.log`）或 import-time 副作用（top-level 建连接/queue），有则改 stderr / 注入静默 logger / 规避 import
- [x] 2.6 **MCP 内自带** `loadCanonicalUrls` + **product `canonical_domain→canonicalUrl` 严格映射**（`new URL` 校验 host===裸域、畸形降级 null，口径同 product-digest.ts 内联）+ **`getPushDate` 等价（读宽松 env optional `PUSH_TIMEZONE`、default Asia/Shanghai、与主链同口径）** + `resolveChannelSenders` **解析逻辑** 等价小实现（**均零推送/采集 token 依赖、查询链 top-level 可用**），**不动 pipeline/product-digest/push-date 等文件**。`resolveChannelSenders` 调用的 sender 工厂（`createTelegramSender`/`createFeishuSender`，顶层 import 全局 env+grammy）**不自带、由 push_event_now handler 动态 import**（见 4.3）。（守非目标「不改主流程」；DRY 抽共享留后续提案）

## 3. 查询工具（只读、声明 outputSchema+返回 structuredContent、annotations.readOnlyHint:true）

- [x] 3.1 `get_today_ai_digest`：以 `push_records`(`push_date=getPushDate(now)`、`status='success'`) 还原已推日报，**channel 默认取库中当日实际 success 的 distinct channel（不依赖 isFeishuEnabled 等进程 env）**、可传 channel 过滤；event url via `representative_raw_item_id→raw_items.canonical_url`（缺省略）；**product 链接复用 product-digest 严格映射（畸形降级 null）、不裸拼**；orphan 跳过；当日无 success → 空 + 文本「今日尚未推送」；**不重跑 selectTopN**
- [x] 3.2 `search_ai_events`：Zod `{ q?, since?, until?, minImportance?, limit(默认20,上限100), offset(默认0) }`；参数化 SQL `representative_title/summary_zh ILIKE` + `published_at` 窗 + `importance_score>=`，published_at DESC 分页；**q 拼 %q% 前转义 LIKE 元字符 `%`/`_`/`\``**；**无 source 过滤**（ai_news_events 无 source 列）
- [x] 3.3 `search_ai_products`：Zod `{ q?, domain?, limit, offset }`；`name`/`canonical_domain ILIKE`（同 LIKE 转义）分页
- [x] 3.4 `get_source_quality_report`：按 source 聚合 `raw_items` 采集量 + 塌缩入 `ai_news_events` 数 + **被推送数（`COUNT(DISTINCT push_records.target_id WHERE status='success')` 经 event 关联回 source）** + 最近活跃时间（**source 归因经 `representative_raw_item_id→raw_items.source`、多源塌缩仅计代表源**；不用「入选 Top N 率」——selectTopN 不落库不可算；source 基数有界、无需分页）

## 4. 人工干预工具（annotations + isError 错误约定）

- [x] 4.1 `mark_event_not_relevant(eventId, reason?)`：`UPDATE ai_news_events SET should_push=false WHERE event_id=?`（**events 无 metadata 列、reason 仅记日志/返回、不入 DB**）；命中 0 行→`isError:true`；幂等；`idempotentHint:true`。稳定性：Value Judge 只处理未评分、已评分 should_push 不被 re-judge 覆盖
- [x] 4.2 `mark_product_interesting(productId, note?)`：`UPDATE ai_products SET metadata = COALESCE(metadata,'{}'::jsonb) || jsonb_build_object('interesting', jsonb_build_object('at',now,'note',note)) WHERE product_id=?`；命中 0 行→`isError:true`；幂等；`idempotentHint:true`
- [x] 4.3 `push_event_now(eventId, channel?)`：读 event（不存在→`isError:true`）→ 构造单元素 `SelectedEvent`（`canonicalUrl` 经 MCP 内 loadCanonicalUrls 等价填、缺则无链接）→ **handler 内 `await import('../push/dispatcher.js')` + 动态 import sender 工厂（telegram/feishu）惰性加载推送链**（env parseEnv 崩/缺 token 在此 catch→`isError`，含缺失 env 名、按 channel 报）→ 调 `dispatchDigest([event], { now, sender, channel, targetType:'event' }, mcpDb)`（**dbh 传 MCP 自建连接、单段 renderDigest 非日报双段**）；复用幂等（已 success→唯一键跳过）；**各 channel 独立 try/catch 隔离**（一个失败不拖另一个）；纯查询不调本工具则永不加载推送链；**动态 import specifier 用 `.js` 扩展（NodeNext、禁 `.ts`）、`try { const { dispatchDigest } = await import('../push/dispatcher.js'); … } catch` 包整段（import + 调用，env parse 崩与模块解析失败统一兜 `isError`）**；首次调用含动态 import 冷启动（dispatcher 默认池建立 + grammy 加载）、非查询 500ms 预算对象、dispatcher 默认池随进程退出回收（shutdown 不显式关、本地 stdio 可接受）；`destructiveHint:true`

## 5. 校验 / 输出 / 错误契约

- [x] 5.1 入参=**SDK 依 inputSchema 自动校验**（handler 不重复 parse）；查询工具出参 DTO 经 handler zod parse + 声明 outputSchema/返回 structuredContent（+ 兼容 content 文本）；查询参数带默认 + 上限；全程参数化查询防注入
- [x] 5.2 错误约定：业务可恢复错误（缺 token / 目标 id 不存在）→ 返回 `{ isError:true, content:[文本含可操作信息/缺失 env 名] }`、**不 throw 断连**；仅协议级异常冒泡。**event 无代表源 url（canonicalUrl 缺）非错误——照推无链接/还原仅标题，不返 isError**

## 6. 测试（连真库查询 / 注入桩；写工具钉 channels + sender mock，不真发生产）

- [x] 6.1 查询 tool 集成：get_today（当日已推/未推/orphan/**产品畸形域降级链接一致**）、search_ai_events（关键词+窗+分页+limit 钳制+**LIKE 元字符转义**）、search_ai_products、get_source_quality_report；**outputSchema/structuredContent 形态正确**
- [x] 6.2 mark_* 集成：mark_event 验 `should_push=false`（无 metadata 写）、mark_product 验 `metadata.interesting`；**目标 id 不存在→`isError:true`**；重复幂等（mark-product.ts 的 `jsonb_build_object` 参数补 `::text` 类型标注修复 PG 42P18 后，mark_event/mark_product 全绿）
- [x] 6.3 `push_event_now` 单测/集成：注入 sender mock + 钉 channels（**防误发生产、遵守 test-no-prod-sends**）；验未推→success（**单段 renderDigest**）、已推→幂等跳过、复用 `dispatchDigest`、未配 token→`isError`、**多 channel 一个失败隔离其余照常**
- [x] 6.4 Zod 入参非法被 SDK 拒；错误走 `isError` 非 throw（连接不断）；**DB 连接/查询失败 + 查询出参 DTO zod parse 失败（脏行）→ 跳过该行或 `isError`、不冒泡断连**；**仅 `DATABASE_URL`（无推送/采集 token）下查询链可启动（push_event_now 动态 import 不在 top-level）**

## 7. 自验

- [x] 7.1 `npm run lint` 0 + `npx tsc --noEmit` 0 + `npx vitest run` 全绿（533 passed | 7 skipped / 48 文件）✓；**关键验收（N2）：仅设 `DATABASE_URL`（不配 telegram/product_hunt token）import 查询链不崩**已由 `query-chain-env.test.ts` 子进程裁剪 env 自动覆盖 ✓；**MCP inspector / Claude Desktop 真实 stdio 实连一次（无 stdout 污染、list_tools 正常、查当日日报通）+ ROADMAP P4 退出标准——交付用户本地验**（同 6.3 真发推送：测试用 mock、真连交用户）

## 8. 文档

- [x] 8.1 README 加 Claude Desktop / Cursor 的 `mcpServers` 配置示例（**`command:"tsx"` 直指 `src/mcp/server.ts`（非 npm，避免 banner 污染 stdout）、`cwd`、`env` 传 `DATABASE_URL`（必填、缺则启动崩）；**push_event_now 需配齐与 worker 同的全部 required env（含 REDIS_URL/LLM_API_KEY/LLM_MODEL/PRODUCT_HUNT_TOKEN/TELEGRAM_*——复用 dispatchDigest 动态 import 触发全局 parseEnv，见 design D8）、纯查询只需 DATABASE_URL**，说明 dotenv/cwd 依赖）+ 7 工具 description 表（每条讲清**何时用 + 关键约束**：get_today=查已推非重选、search_ai_events 无 source 维度（走 get_source_quality_report）、push_event_now 会真发推送）

## 9. 提交与规范归档

- [x] 9.1 提交代码（`src/mcp/` + package.json + 测试 + 文档）；含 src 实现 → **走 PR**（PR #15：feat/mcp-query-server）
- [ ] 9.2 PR 合并后：`/opsx:sync` 将 `mcp-query` 增量规范并入主规范（新建 `openspec/specs/mcp-query/spec.md`）
- [ ] 9.3 PR 合并后：`/opsx:archive` 归档本变更（纯文档直推 main）
