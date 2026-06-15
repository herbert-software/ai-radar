## 为什么

P0–P2 已跑通「采集→去重→评分→摘要→双通道推送」并积累数据（现网 ai_news_events 2113 / ai_products 17 / push_records 全 success），但情报只能**被动收推送**，无法主动查询：想问「某产品之前推过没有」「最近一周 MCP 相关项目」「这个事件为何判高价值」都没有入口。

QA.md §14 与 config.yaml 都定义了查询入口=**MCP Server**（官方 TS SDK `@modelcontextprotocol/sdk`），且明确 **MCP 不参与主流程调度、只作查询与人工干预入口**。ROADMAP P4（与 P3 并行、依赖 P2 已有数据）退出标准：「从 Claude/Cursor 查到当日日报与历史」。本变更落地 P4。P4 还为 P5「AI 工具选型顾问」预留同一 MCP 进程的工具扩展位（本期不做顾问）。

## 变更内容

新建 `src/mcp/` MCP server（`@modelcontextprotocol/sdk`，stdio transport，新 npm script `mcp`），与流水线**并列的独立查询进程**，暴露以下工具（对齐 QA.md §14，P4 范围）：

1. **get_today_ai_digest**（只读）：查当日已推日报——以 `push_records`（`push_date=今天`、`status=success`）为准 join 还原 `target_type='event'` 要闻段 + `target_type='product'` 新品段（**查"已推的事实"，非重跑选择**），可按 channel 过滤。
2. **search_ai_events**（只读）：按关键词（标题/摘要）/ 时间窗（`published_at`）/ importance 阈值查 `ai_news_events`，分页（**`ai_news_events` 无 source 列、不按 source 过滤事件；源维度见 get_source_quality_report**）。
3. **search_ai_products**（只读）：按名称 / `canonical_domain` / 关键词查 `ai_products` 实体库。
4. **get_source_quality_report**（只读，QA §14 列）：各 source 的 `raw_items` 采集量 / 塌缩入事件数 / 被推送数 / 最近活跃时间（按**代表源** `representative_raw_item_id` 归因、多源塌缩仅计代表源；不用「入选 Top N 率」——selectTopN 不落库、无法从 DB 算）。
5. **mark_event_not_relevant**（写有限状态）：人工把某 `event_id` 置 `should_push=false` 使其退出后续候选（**`ai_news_events` 无 metadata 列，故不存审计 metadata；reason 仅记日志/返回、不入 DB**）；确定性 DB 写、不触 LLM；已评分事件不被 re-judge 覆盖（Value Judge 只处理未评分）、标记稳定；目标不存在→返回明确错误。
6. **mark_product_interesting**（写有限状态）：人工把某 `product_id` 写 `metadata.interesting`（`ai_products` **有** metadata jsonb、原子 merge），供后续查询/P5 顾问参考；目标不存在→返回明确错误。
7. **push_event_now**（人工干预推送）：人工触发立即推某 `event_id`——**复用既有 `dispatchDigest`**（单元素 Top N、`target_type='event'`、**单段要闻 `renderDigest`、非日报双段**、先 pending→发→success/failed、唯一键冲突即跳过），绝不另写漂移推送逻辑；目标不存在/未配推送 token→返回明确错误、不影响查询工具。

所有工具的输入参数**一律由 SDK 依 inputSchema(Zod) 自动校验**、查询工具输出 DTO 经 handler zod parse（查询工具声明 outputSchema + 返回 structuredContent）；查询工具只读 DB；`mark_event_not_relevant` 只写 `should_push`（events 无 metadata 列）、`mark_product_interesting` 写 `ai_products.metadata`（**均不新增 schema 列**）。

## 功能 (Capabilities)

### 新增功能
- `mcp-query`: MCP Server 查询与人工干预入口——暴露日报/事件/产品的只读查询工具 + 有限人工干预工具（mark/push_event_now），stdio transport，全工具 Zod 校验，**不参与主流程调度**。

### 修改功能
（无。`push_event_now` 复用既有 `telegram-push`/`feishu-push` dispatcher 与 `push_records` 幂等四元组，不改其需求；`mark_event_not_relevant` 写 `should_push=false` 是人工干预既有列、不改 `daily-intel-pipeline` 候选口径。）

## 影响

- **依赖**：新增 `@modelcontextprotocol/sdk`（官方 TS SDK，当前未装）。
- **代码**：新建 `src/mcp/`（server 入口 + 各 tool handler + Zod schema + 日志全走 stderr）；`package.json` 加 `"mcp": "tsx src/mcp/server.ts"` 脚本（脚本供本地调试；客户端配置用 `command:"tsx"` 直连、见配置）。**复用方式见 design D8（堵传递 import 崩）**：查询链 import `src/db/schema.ts`（纯表定义）自建连接、**绝不复用 `src/db/index.ts` 全局-env 单例**；push_event_now 在 handler 内**动态 import** `src/push/dispatcher.js`（复用 dispatchDigest）。push_event_now 的 sender（`resolveChannelSenders`）与 event url（`loadCanonicalUrls`）现为 pipeline 内私有非导出（resolveChannelSenders 三处入参异构、run-daily 多 sender 回退）；不抽共享（抵触「不改主流程」）、MCP 内自带等价小实现 + sender 工厂动态 import（DRY 抽共享留后续提案，见 design D6）。
- **数据**：无 schema 迁移；`mark_event_not_relevant` 只写 `ai_news_events.should_push`（events **无 metadata 列**）、`mark_product_interesting` 写 `ai_products.metadata`（jsonb 原子 merge，无新列）。
- **主流程**：零影响——MCP server 是独立进程，不嵌入 `runDailyWorkflow`/告警/周报、不与日报阶段相互投递；**sender/url helper 在 MCP 内自带、不动 pipeline 文件**。
- **配置**：MCP 连接由用户在 Claude Desktop/Cursor 的 `mcpServers` 配置以 stdio 启动（**`command:"tsx"` 直指 `src/mcp/server.ts`、非经 npm——避免 npm banner 污染 stdout**），经 `env` 传 DATABASE_URL 等（stdio 子进程环境由客户端注入、不保证继承 shell `.env`）；无新增必填 env。

## 非目标

- **不做 `recommend_ai_tools_for_task`**（P5 AI 工具选型顾问，依赖未建的 `ai_tools`/`task_patterns` 表 + RAG，留 P5；本期仅预留 MCP 进程扩展位）。
- 不参与日报/告警/周报主调度，不改其幂等/熔断/时效闸口径。
- 不引入新推送逻辑（`push_event_now` 复用既有 dispatcher 与 `push_records` 幂等四元组）。
- 不新增 schema 列：`mark_event_not_relevant` 只写既有 `should_push`（`ai_news_events` **无 metadata 列**）、`mark_product_interesting` 写既有 `ai_products.metadata` jsonb。
- 不复用 `src/db/index.ts` 全局-env 单例（避免 import 即 require 推送/采集 token 崩纯查询）：MCP 用专用宽松 env（只 require `DATABASE_URL`）+ import `schema.ts` 自建连接；不抽共享 pipeline helper（resolveChannelSenders/loadCanonicalUrls/product 映射 MCP 内自带）。
- 不做 streamable HTTP transport / 鉴权 / 多租户（本地单用户 stdio；HTTP 留后续按需）。
- 不做 Web 控制台（P6）。
- 不建知识库 / 语义检索（P3 KB、`long_term_value` 评分另立提案）。
