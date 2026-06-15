## ADDED Requirements

### 需求:MCP 查询入口为独立进程、不参与主流程调度、守 stdio 纪律

系统必须提供一个独立的 MCP server 进程（stdio transport，`@modelcontextprotocol/sdk`），作为情报的**查询与人工干预入口**。该进程**绝不参与主流程调度**：不嵌入 `runDailyWorkflow()`/告警/周报，不注册任何 cron/BullMQ 队列/单例锁，不与日报各阶段相互投递。**stdio 纪律**：stdout 是 JSON-RPC 专用通道，进程**禁止向 stdout 写任何非 JSON-RPC 内容**——所有日志/诊断/启动横幅一律走 stderr；须核查复用链路（dispatcher/selection/db 等）无 stdout 日志与 import-time 副作用。所有工具的**入参由 SDK 依 inputSchema(Zod) 自动校验**；查询工具须声明 `outputSchema` 并返回 `structuredContent`（+ 向后兼容的 content 文本），其输出 DTO 在 handler 内经 zod parse；mark_*/push_event_now 结果即 outcome、只返回 content 文本不声明 outputSchema。工具须声明 `annotations`（查询工具 `readOnlyHint:true`；mark_* `idempotentHint:true`；push_event_now `destructiveHint:true`）。**env / 连接（堵传递 import 崩）**：MCP 用专用宽松 env（只硬性 require `DATABASE_URL`、telegram/feishu/product_hunt token optional）+ import `src/db/schema.ts` 自建 db 连接。**查询链零全局-env 依赖**：get_today/search_*/source-report/mark_* 只 import schema.ts + 自建连接 + **MCP 自带 `getPushDate` 等价（读宽松 env 的 `PUSH_TIMEZONE`、default Asia/Shanghai、与主链 push_date 写入口径同源、避免时区漂移）**；**server.ts top-level 绝不 static import `dispatcher`/`push-date`/`top-n`(value)/`telegram`/`feishu` 等触达全局 env 的模块**（这些顶层 import `src/config/env.ts`，其 import 即 require TELEGRAM/PRODUCT_HUNT token——top-level 引入会使纯查询用户在 import 阶段崩溃，仅「不直接 import db/index.ts」不够）。**push_event_now 动态加载推送链**：在其 handler 内 `await import('../push/dispatcher.js')` + 动态 import sender 工厂，env/token 崩推迟到该工具被调用时、缺则 `isError`；纯查询不调它则永不加载、不崩。`DATABASE_URL` 缺失/畸形 → connect 前 `process.stderr` 报错 + `exit(1)`（不污染 stdout）。

#### 场景:MCP server 只注册查询/干预工具不注册调度
- **当** MCP server 进程启动
- **那么** 仅注册查询（get_today_ai_digest/search_*/get_source_quality_report）与人工干预（mark_*/push_event_now）工具并 `connect(stdio)`，不注册任何 cron/BullMQ/锁，不触发 runDailyWorkflow/告警/周报

#### 场景:stdout 不被非 JSON-RPC 内容污染
- **当** MCP server 运行（启动/查询/写/错误）
- **那么** 所有日志/诊断走 stderr，stdout 只承载 JSON-RPC 帧；客户端 list_tools 与工具调用能正常解析返回（无 stdout 污染致 parse error）

#### 场景:非法工具入参被 SDK 依 inputSchema 拒绝
- **当** 调用任一工具时传入不符合 inputSchema 的参数（类型错/超上限/缺必填）
- **那么** 请求被 SDK 依 inputSchema(Zod) 自动校验拒绝（handler 不重复 parse），不执行任何 DB 操作

#### 场景:纯查询只需 DATABASE_URL 启动
- **当** MCP 进程仅配置 `DATABASE_URL`（未配 telegram/feishu/product_hunt token）启动
- **那么** server 正常启动、查询工具可用（专用宽松 env 不 require 推送/采集 token、不复用会 import 崩的全局 env 单例）；push_event_now 用时才校验推送 token、缺则该 channel `isError`

### 需求:查询当日已推日报

`get_today_ai_digest` 必须以 `push_records`（`push_date = 今天（MCP env PUSH_TIMEZONE、default Asia/Shanghai、与主链同口径）`、`status='success'`）为准还原当日**已推**日报——按 `target_type` 分组 join `ai_news_events`（要闻段）与 `ai_products`（新品段），即查「已推送的事实」而非重跑 Top N 选择。channel 默认取**库中当日实际有 success 的 distinct channel**（不依赖进程 env 的 isFeishuEnabled 等，免漏已推 channel），可传 channel 过滤。event 原文 url 经 `representative_raw_item_id → raw_items.canonical_url`（缺则省略）；**product 链接须复用 product-digest 的同一 `canonical_domain→canonicalUrl` 严格映射（含 URL 校验、畸形降级 null），不得裸拼**，以忠实于实际已推内容。当日尚未推送则返回空 + 说明。

#### 场景:当日已推则返回要闻+新品两段
- **当** 当日有 `target_type='event'`/`'product'` 的 success push_records，调用 get_today_ai_digest
- **那么** 以 push_records 为准 join 还原要闻段（events）与新品段（products）返回；orphan（push_records success 但行已删）跳过、不报错

#### 场景:当日未推返回空并说明
- **当** 当日尚无 success push_records
- **那么** 返回空日报 + 文本说明「今日尚未推送」，不重跑选择

#### 场景:产品链接忠实于已推（畸形域降级一致）
- **当** 某已推产品 `canonical_domain` 为畸形值（实际已推消息因严格校验降级为无链接）
- **那么** get_today 同样按严格映射降级（不裸拼出 `https://畸形`），与实际已推内容一致

### 需求:查询历史事件与产品

`search_ai_events`/`search_ai_products` 必须按确定性参数只读查询，参数 Zod 校验（带默认值 + 上限防滥用），用参数化查询（占位符，禁字符串拼 SQL）防注入，且 `q` 拼 `%q%` 前**转义 LIKE 元字符（`%`/`_`/`\`）**防全表扫描。`search_ai_events` 支持关键词（标题/摘要 ILIKE）/ 时间窗（`published_at`）/ importance 阈值 / 分页（**`ai_news_events` 无 `source` 列、不按 source 过滤事件**，源维度见 get_source_quality_report）；`search_ai_products` 支持名称/`canonical_domain`/分页。

#### 场景:按关键词与时间窗查事件
- **当** 调用 search_ai_events 带关键词 + published_at 时间窗 + 分页
- **那么** 返回匹配事件（ILIKE + 窗 + 分页，published_at 降序）

#### 场景:按域名查产品
- **当** 调用 search_ai_products 带 canonical_domain 或名称关键词
- **那么** 返回匹配的 ai_products 行（分页）

#### 场景:limit 上限与 LIKE 元字符防滥用
- **当** 传入超上限 limit 或含 `%`/`_` 的关键词
- **那么** Zod 钳制/拒绝超限；`q` 的 LIKE 元字符被转义按字面匹配；查询用参数化占位符防注入

### 需求:源质量报告

`get_source_quality_report` 必须只读聚合各 source 的 `raw_items` 采集量、塌缩入 `ai_news_events` 数、被推送数（`COUNT(DISTINCT push_records.target_id WHERE status='success'`，经 event 关联回 source）、最近活跃时间。**source 归因口径**：event↔source 唯一路径为 `representative_raw_item_id → raw_items.source`（raw_items 无 event_id、无 item_event_relations）；故「塌缩入数/被推送数」按**代表源**归因、**多源塌缩事件仅计代表源**（全源归因留后续）；不用「入选 Top N 率」（selectTopN 不落库、不可从 DB 算）。

#### 场景:报告各源质量统计
- **当** 调用 get_source_quality_report
- **那么** 返回各 source 的采集量/塌缩数/被推送数/最近活跃时间（只读）

### 需求:人工标记干预

`mark_event_not_relevant` 必须把指定 `event_id` 置 `should_push=false` 使其退出后续推送候选（**`ai_news_events` 无 metadata 列，故只置 should_push、不写审计 metadata、不新增列**；其稳定性由「Value Judge 只处理未评分事件、已评分不重判」保证，should_push=false 不被 re-judge 覆盖）。`mark_product_interesting` 必须在指定 `product_id` 的 `metadata`（`ai_products` 有该 jsonb 列）原子 merge 写 `interesting`（含时间/备注）。二者均为确定性 DB 写、零 LLM、幂等；**目标 id 不存在（命中 0 行）须返回 `isError:true` + 提示、不静默成功**。

#### 场景:标记事件不相关使其退出候选
- **当** 对存在的 event_id 调用 mark_event_not_relevant
- **那么** 该事件 `should_push=false`，后续日报候选（要求 should_push=true）不再选中；已评分故不被 re-judge 改回

#### 场景:标记产品有趣写入 metadata
- **当** 对存在的 product_id 调用 mark_product_interesting
- **那么** 该产品 `ai_products.metadata.interesting` 已原子 merge 写入，不新增列、不触 LLM

#### 场景:标记目标不存在返回错误
- **当** 对不存在的 event_id/product_id 调用 mark_*（命中 0 行）
- **那么** 返回 `isError:true` + 提示，不静默成功

#### 场景:重复标记幂等
- **当** 对同一存在目标重复调用 mark_*
- **那么** 结果一致（should_push=false / metadata 覆盖），不报错、不产生重复副作用

### 需求:人工即时推送复用既有幂等状态机

`push_event_now` 必须复用既有 `dispatchDigest`（`target_type='event'`、**单段要闻 `renderDigest`、非日报双段**、先 `pending`→发→`success`/`failed`、唯一键冲突即跳过），**绝不另写漂移推送状态机**；对目标 channel（默认所有已配置）即时推指定 `event_id`，各 channel 独立隔离（一个失败不拖另一个）。该 channel 已 success 推过则幂等跳过。event 不存在/未配推送 token 须返回 `isError:true`、不影响查询工具。

#### 场景:即时推送未推过的事件
- **当** 对尚未 success 的 event_id 调用 push_event_now
- **那么** 经 dispatchDigest 先写 pending→送达→置 success（单段要闻 digest），返回该 channel outcome

#### 场景:对已推事件幂等跳过
- **当** 对该 channel 已 success 的 event_id 调用 push_event_now
- **那么** 唯一键冲突即跳过、不重复推送，返回幂等结果

#### 场景:复用 dispatcher 不另写状态机
- **当** 实现 push_event_now
- **那么** 直接调用既有 `dispatchDigest`（单元素 Top N、target_type='event'、单段渲染），不另写一套推送/幂等逻辑

#### 场景:事件不存在或缺 required env 返回错误
- **当** event_id 不存在、或 push_event_now 动态 import 推送链时缺**任一** required env（不止 telegram/feishu token，含 REDIS_URL/LLM/PRODUCT_HUNT 等——dispatcher 触发全局 parseEnv，见 daily-intel-pipeline 等既有 env 必填口径）
- **那么** 返回 `isError:true` + 可操作提示（含缺失 env 名），不抛断连接、不影响查询工具；多 channel 时一个失败隔离、其余照常
