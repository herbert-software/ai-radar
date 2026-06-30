# ai-radar 排期计划

> 拆分原则与各期范围的详细论证见本文件；权威需求见 [`QA.md`](./QA.md)，技术栈与不变量见 [`openspec/config.yaml`](./openspec/config.yaml)。

## 拆分原则

- **纵向切片**：第一个上线版本就打通"采集 → 去重 → 判断 → 摘要 → 推送"整条最小链路，每个环节取最简实现，而不是横向堆层（先做完所有 collector 再做去重再做推送 → 到最后才能跑）。
- **幂等从第 0 天就在**：`push_records` 唯一约束 + `ON CONFLICT` 是不可回退的地基，放进第一个可上线切片。
- **最难且最不确定的留到有数据之后**：embedding 阈值（0.88 / 0.82）、LLM 去重、提示词质量是靠真实数据调出来的，不是写出来的；先用便宜的硬去重跑起来积累数据，再上语义层。
- **顺数据沉淀的自然节奏**：工具选型顾问依赖前几期积累的结构化产品库，天然排在最后。

## 排期计划表

> 假设：单人 + VibeCoding 节奏；工期为**相对工作量区间**，日历日期为估算（以 Kickoff = 2026-06-16 周一起算），实际随源接入与调参迭代浮动。`P4` 与 `P3` 并行，不进关键路径。

| 期 | 里程碑 | 工期 | 周次 | 估算日历 | 关键交付物 | 依赖 | 退出标准（可观测） |
|---|---|---|---|---|---|---|---|
| **P0** | 地基 / Walking skeleton | 1 周 | W1 | 06-16 ~ 06-22 | TS+Hono+Drizzle 脚手架、docker-compose(pg+redis)、核心表 migration、`.env.example`、CI、一次 Zod 校验的真实 LLM 调用 | — | `docker compose up` 起得来；migration 落表；健康检查通过；`generateObject` 跑通一次 |
| **P1** ✅ | 最小情报流（**首个真上线**） | 2–3 周 | W2 ~ W4 | 06-23 ~ 07-13 | RSS + HN/GitHub 三源、`raw_items` 入库、**硬去重**、Value Judge(Zod)、中文摘要、**Telegram 单通道 + 幂等**、BullMQ 每日任务 | P0 | **退出标准达成**（见下「P1 退出标准达成」）：每日定时推 Top N（BullMQ cron + `runDailyWorkflow`）；同一天同一条不重复（`push_records` 幂等 + 单例锁）；带 utm 的 URL 被归一为同一条（URL 归一 + `dedup_key` 塌缩） |
| **P2** ✅ | 扩源 + 双通道 + 产品发现 | 3–4 周 | W5 ~ W8 | 07-14 ~ 08-10 | 一线大厂官方 RSS（OpenAI/DeepMind/HuggingFace，T1）/Product Hunt/arXiv collector、飞书通道、`ai_products` 表 + **硬规则产品合并**、实时重大发布告警、周报。**Reddit 经鉴权/限流调研移出关键路径**（条款风险，详见 `expand-sources-dual-channel-products` 提案非目标）；Meta/Anthropic 无原生 RSS 的 HTML 抓取列 T2 次批（Mistral 经实测有原生 RSS，已随后续扩源接入，连同 Microsoft AI） | P1 | **退出标准达成**（见下「P2 退出标准达成」）：双通道均不重复推；每日产品发现推送；实时告警跑通；周报跑通 |
| **P3** ✅ | 语义去重 + 知识库 | 3–4 周 | W9 ~ W12 | 08-11 ~ 09-07 | pgvector embedding 去重 + LLM 二次判断、`ai_news_events` 事件合并、KB 入库（本地表 → Dify HTTP）、只入 `long_term_value≥70` | P2 + 真实数据积累 | **退出标准达成**（见下「P3 退出标准达成」，阈值实测复校列为持续运营动作）：中英文同一事件被识别为一条；KB 可检索 |
| **P4** ✅ | MCP 查询入口 | 1.5–2 周 | W9 ~ W11（与 P3 并行） | 08-11 ~ 08-24 | MCP server：`get_today_ai_digest` / `search_ai_events` / `search_ai_products` / `mark_*` / `push_event_now` | P2 | **退出标准达成**（见下「P4 退出标准达成」）：从 Claude/Cursor 查到当日日报与历史 |
| **P5** ✅ | **Model Radar — 编程订阅比价 + 选型（编程垂类，5a–5e 全部落地并归档）** | 5–7 周 | —（P0–P4 提前完成，按日历重定基线） | 06-25 ~ 08-09 | 见下「[P5 Model Radar 步骤拆解](#p5-model-radar-步骤拆解)」5a–5e：数据模型+provenance / 录入+保鲜回路 / 桶2数据+比价检索API / Web 比价页 / 垂类选型推荐器 | P2（产品·事件流）+ P4（MCP） | **退出标准达成**：比价页 10s 内答「谁含 GLM-4.6 / 谁支持 Claude Code / 同档谁最划算 / 谁最近变了」（5d-B）；推荐器答「重度 Claude Code + GLM-4.6 最便宜可用」+ 撞窗 + 月成本 + 依据（5e）；每条价/兼容/额度带 `source_url`+`last_checked`+`source_confidence`；陈旧项可被 ai-radar 变更流标「待复核」 |
| **P6** | 泛化选型顾问（原 P5：任意工具 / 任意任务） | 3–5 周 | — | Model Radar 之后 | `ai_tools` + `task_patterns` 表、规则召回、RAG、LLM 解释、`recommend_ai_tools_for_task`；把 Model Radar 验证过的「规则召回 → RAG → LLM 解释」推荐器从编程订阅垂类泛化到「做某事用哪个 AI 工具」 | P5 | 「内部知识库选 Dify/RAGFlow/FastGPT」给出首选/备选/不推荐/落地步骤 |
| **P7** | Web 控制台（内部人工干预面板，可选） | 按需 | — | — | 复用 P5 前端栈的人工干预面板 | P5 | — |

**关键路径**：P0 → P1 → P2 → P3 → **P5（Model Radar）✅**。P0–P5 已上线（含情报流 / 双通道 / 语义去重 / 知识库 / MCP / **Model Radar 比价页 + 选型推荐器**）；**P5 Model Radar 全部步骤（5a–5e）落地完毕**，下一里程碑 = **P6 泛化选型顾问**（Model Radar 超集，把验证过的「规则召回 → RAG → LLM 解释」从编程垂类泛化到「做某事用哪个 AI 工具」）。

> **进度（截至 2026-06-30）**：**P0–P4 关键路径全部落地**，外加 roadmap 外的「AI 博主经验挖掘」链（归档 `add-ai-blogger-experience-mining`）。**P5 Model Radar：5a / 5b / 5c / 5d-A / 5d-B / 5d-C / 5e 全部落地并归档**——5a 数据模型（`add-model-radar-data-model`）、5b 录入+保鲜回路+三档抓取变更检测（`add-model-radar-ingestion-freshness`，PR #45）、5c 比价/检索 API + 只读快照 + 桶2数据红线（`add-model-radar-compare-api`，PR #46）、5d-A 快照跨进程失效 Redis pub/sub + 服务进程周期 rebuild（`add-model-radar-snapshot-cross-process-invalidation`，PR #47）、5d-B Hono JSX SSR 比价 Web 页 + per-fact age 徽标（`add-model-radar-compare-web-page`，PR #48）、5d-C 桶2真价人工策展（`add-model-radar-bucket2-price-curation`，PR #49：经既有授权改价入口录 6 家 CNY 官方真月价，比价页转出真实最划算 = 讯飞 ¥19）、**5e 垂类选型推荐器 v1（规则 + 模板）+ MCP 单工具**（`add-model-radar-recommender`，PR #50：vetted money-path 召回 + `fitsWindow` 撞窗纯数值原语 + 四态有序 verdict + 模板解释层 + env-clean MCP `recommend_coding_subscription`；退出用例「重度 Claude Code + GLM-4.6」→ 首选 GLM Lite ¥49）；主规范现有 `model-radar-catalog`(5a) / `model-radar-ingestion`(5b+5c 红线) / `model-radar-compare-api`(5c+5d-A) / `model-radar-compare-web`(5d-B) / `model-radar-recommender`(5e) 五谱。**P5 Model Radar 全部步骤（5a–5e）落地完毕**（browser egress 生产启用 + 自动抓取已**拆出延后**为独立步骤、不在 P5 关键路径，见步骤表）；下一步 = **P6 泛化选型顾问**（Model Radar 超集，把「规则召回 → RAG → LLM 解释」从编程垂类泛化）或持续运营。未结持续运营动作：P3 语义阈值真实数据复校（见下「P3 退出标准达成」）；**5e v2**（RAG 证据 + LLM 解释，仅换可插拔解释层、召回不动）。

## P5 Model Radar 步骤拆解

> **背景**：Model Radar 原是独立产品构想（AI 编程订阅 / Coding Plan / Token 包的比价 + 选型）。经评估**并入本仓作同仓 bounded domain**，而非单开项目——它本质是 P5「AI 工具选型顾问」在**编程垂类**的具象化 + 项目首个 Web 前端，复用现有 PostgreSQL / Drizzle / BullMQ / MCP / 推送 / 部署。故提优先级，作 P0–P4 之后关键路径下一步。首版候选库（约 20 家，其中 8 厂商已逐字核对官方页，2026-06-24）随 5a 提案附库。**技术方案、已锁决策（抓取三档含 Playwright / Hono JSX SSR / 同容器托管 / 推荐器 v1 规则+模板）与 v1·v2 切分见 [`docs/model-radar-tech-plan.md`](./docs/model-radar-tech-plan.md)。**

### 定位与边界

- **是**：厂商 → 套餐 → 模型 → 工具/协议兼容矩阵 + 价格历史的**结构化关系目录** + 直观比价页 + 垂类选型推荐。
- **不是**：自动爬全网填目录的 Agent。目录靠**结构化录入 + 人工策展**；ai-radar 管线只供「变更信号 + 待复核标」，不负责填事实。
- **bounded domain**：自有 `mr_*` 表，**不复用、不污染** `ai_products` 与新闻管线 schema（后者是非结构化情报，Model Radar 是精确关系事实）。

### 不可违背（与 `config.yaml` 第一架构原则一致）

- 精确事实（价格 / 兼容 / 额度）由**结构化录入 + DB** 保障，**绝不交 LLM 判定**；LLM 只做解释与推荐措辞。
- 额度建成**带类型限额行** `mr_plan_limits{limit_type, value, window}`（如 `monthly_tokens` / `rolling_5h_requests` / `weekly_messages` / `none`），**不建单个 `quota INT`**——各家额度口径异构，建成整数从根上烂掉。
- **分桶隔离**：`category ∈ {IDE会员, Coding Plan, Token Plan, 企业席位}` 是 facet；归一化比较只在**同桶内**做，**检索/筛选横切所有桶**（最高频查询「Claude Code + GLM-5.2 最便宜」跨桶）。
- 每条事实挂 **provenance**：`source_url` / `last_checked` / `source_confidence ∈ {official_pricing, official_doc, official_community, media_report, needs_login_recheck}`。源会漂移（实测火山方舟 `activity/codingplan` 已跳成智谱 GLM 页），靠 `last_checked` + confidence 暴露而非静默入错。
- `included_models` **带版本**（GLM-5.2 ≠ GLM-4.7；模型阵容月级换代）。
- **保鲜回路先于 UI**：先有「录入 + last_checked + 变更流待复核」，再做漂亮比价页；否则第一张表两周后就在骗用户。

### 步骤（每步可单独立 `/opsx:propose`）

| 步 | 范围 | 工期 | 退出标准（可观测） |
|---|---|---|---|
| **5a** ✅ | 数据模型 + provenance：`mr_vendors` / `mr_plans` / `mr_models` / `mr_plan_models`（模型兼容矩阵）/ `mr_plan_clients`（工具+协议兼容）/ `mr_plan_limits`（带类型限额行）/ `mr_price_history`；category facet；provenance 三字段 | ~1 周 | migration 幂等落表 + 唯一约束 + 一家样例厂商完整录入读回；额度走限额行非单 INT |
| **5b** ✅ | 结构化录入 + 保鲜回路（**先于 UI**）：最小录入路径把已核 8 家入库（带 confidence）；`last_checked` / 陈旧度；接 ai-radar 事件流 → 对应 plan 打「待复核」（写状态不改事实） | ~1–1.5 周 | 8 家在库可查；变更流能把某厂商标待复核；源 URL 漂移类问题被 confidence/last_checked 暴露 |
| **5c** ✅ | 桶2（多模型 Coding Plan：百炼/千帆/腾讯/火山/讯飞）数据 + 比价/检索 API：model × tool × 协议 × 预算 横切筛选；同桶内排序（**同桶同币种**）；「同档家族」折叠**本期延后**（见下注 5c-③） | ~1 周 | **退出标准达成**（见下「5c 退出标准达成」）：API 按 model/tool 过滤返回合格 plan、同桶排序、返回带 provenance |
| **5d-A** ✅ | 快照跨进程失效（Redis pub/sub，仅通道不存 blob）+ 服务进程内周期 rebuild（链7 常驻安全网装配；驱动 stale 翻转 + 漏消息自愈 + flag/staleness 可见）| ~0.5 周 | **已落地归档**（PR #47）：改价/seed/flag 写经 pub/sub 跨进程失效；周期 rebuild 非 on-read、请求路径只读 |
| **5d-B** ✅ | Web 比价页（项目**首个真前端**，Hono JSX SSR + 前后端同栈复用 Zod schema）：筛选 chips + 可排序表 + 行展开看全字段与来源 + 陈旧(plan)/age(per-fact)徽标；「估算中等任务轮次」做成**带旋钮的区间**、视觉次于官方原始额度、挂 ⚠ 估算；per-fact `lastCheckedDate` 进哈希仍稳定 | ~1.5 周 | **已落地归档**（PR #48）：浏览器 10s 内答四问、每格可溯源；首个公开页 XSS/CSP 基线 + WCAG 2.2 AA |
| **5d-C** | **桶2真价人工策展执行（本变更，`add-model-radar-bucket2-price-curation`）**：经既有授权改价入口 `recordPriceChange` 把桶2 coding_plan 可核实**真月付(month-to-month)标准价**从 `needs_login_recheck` 占位转已核官方价（仅年/季付者留占位、不÷12 admit；促销/限时价不录）；经既有 5d-A 链自动流到只读快照/比价页，零新接线 | ~0.5 周 | **条件化（非保证）**：某 (coding_plan, currency) 同档可核到**可比 ≥2 同币种** → 比价页从「数据不足」转出真实最划算；不达 → 诚实留「数据不足」（不凑数） |
| **browser egress 生产启用**（延后，独立步骤）| browser-worker 生产 egress 部署封锁（封 RFC1918/link-local/metadata、启动自检 fail-closed，5c-④）+ 自动 Playwright 抓取——经 6/6 评审判定在 Docker Desktop 目标上**不可正向验证** + 结构上**重复 ingestion 既有需求**，已从 5d-C **剥离延后**到真开自动抓取那步（届时 **MODIFY** `model-radar-ingestion`「Playwright 沙箱锁定」补部署机制 + 正向勘验，即用即验）| 延后（不在本期）| 真开自动抓取时验：egress fail-closed 实跑勘验 + browser-worker 受控生产消费 |
| **5e** ✅ | 垂类选型推荐器 **v1（规则 + 模板，LLM/RAG 留 v2）**：规则硬筛召回（经 vetted `queryModelRadarSnapshot` money-path、含某模型/工具/预算、currency/budget 不喂 query 锁币种组）+ 撞窗判定（snapshot 层 `fitsWindow` 纯数值原语、按 limitType 分派、口径未知不假装）+ 四态有序 verdict（首选/备选/不推荐/待核）+ **可插拔模板解释层**（`ExplanationInput→Promise`、`evidence?` 槽留 v2 RAG+LLM、召回不动）；MCP 单工具 `recommend_coding_subscription`（env-clean 动态取快照、只读 fail-closed） | ~1–1.5 周 | **已落地归档**（PR #50）：「重度用 Claude Code + **GLM-4.6** 最便宜可用」→ 首选 GLM Lite ¥49 + 撞窗(现数据口径未知如实标「额度口径未知」) + 月成本 + per-fact 依据；从 Claude/Cursor 直接调用 |

> 桶2 之后按需补桶：Token/Credit Plan（GLM/MiniMax/MiMo/Step/Kimi，价格有区分但 credit 口径异构需归一化护栏）、IDE会员（Trae/Qoder/Comate/CodeBuddy/Raccoon，最异构）、企业席位。渠道/代理转售包列**第二阶段**单独表，不混入厂商官方榜。

> **5c 开工决策（`add-model-radar-compare-api`）**：
> - **5c-① 未知价格排序红线**：`priceStatus='known'` 当且仅当 `current_price`/`currency` 非 NULL **且** `source_confidence ∈ {official_pricing, official_doc}`（已核官方 provenance）。未核价不参与「最便宜」，同桶排在已知价之后并标待复核；录入侧 confidence↔price 绑定落进共享 `mrPlanWriteSchema`（`upsertPlan` 新建 + 改价委托两路都过）+ `recordPriceChange` confidence-must-be-official，使未核价无法冒充已核价。
> - **5c-② 同桶同币种比较，不做汇率换算（FX）**：排序仅在同一 `category` 且同一 `currency` 内有意义；混币（20 EUR vs 40 CNY）不当同单位比，按 (category, currency) 分组。
> - **5c-③ 「同档家族」折叠本期延后**：折叠需依赖已核价格+限额做同质判定，而本期桶2价格大多未核（NULL 占位），无可靠数据可依；显式延后到桶2价格核实后再做。
> - **5c-④ browser/prod gate**：真实 browser 定价页勘验 + browser-worker egress/netns 封锁（封 RFC1918/link-local/metadata、启动自检 fail-closed）是 **browser/prod 启用 gate**，**不阻塞 5c API 开发**；本期不启用 browser-worker 生产消费、不实际抓取任何源。源 `fetch_strategy` 按页面真实性质登记（JS 渲染=browser、文档页=http、登录墙/漂移=manual，不一律降 manual），http/browser 源域扩入 `MR_SOURCE_DOMAIN_ALLOWLIST`。
> - **5c-⑤ ETag=内容哈希**：5c 唯一公开 version/ETag 源 = 快照内容 canonical 哈希；`mr_catalog_version` 在 5c 不写不读不服务（留未来/内部）。服务表征 freshness **仅暴露离散 `stale`**（不暴露 raw 秒级 last_checked），随数据变更/staleness 阈值穿越失效。

### 5c 退出标准达成

`add-model-radar-compare-api` 提案已实现并归档（PR #46 合并）；退出标准由程序 + DB 保障并有测试覆盖（`src/mr` 全量 vitest 全绿、真实 pg）。经 5 轮对抗性 review（Codex + Code Reviewer + Reality Checker §1b + Ponytail）+ CodeRabbit 复审收敛。

| 退出标准 | 状态 | 实现与证据 |
|---|---|---|
| API 按 model/tool 过滤返回合格 plan | ✅ 已实现 | `src/mr/snapshot/query.ts` 确定性 AND 过滤（model `family:version`、tool/protocol clientId 精确匹配、currency/预算）；`GET /model-radar/plans`（`src/mr/api/model-radar.ts`）非法参数 400。覆盖测试 `query.test.ts` + `model-radar.test.ts`。 |
| 同桶排序（同桶同币种、未知价不参与最便宜） | ✅ 已实现 | 同 (category, currency) 内 known 价升序、未知价归 `sortScope.currency=null` 组不成 cheapest；`priceStatus='known'` 当且仅当 价/币非 NULL + `source_confidence ∈ {official_pricing, official_doc}`（5c-①）；不做 FX（5c-②）。 |
| 返回带 provenance + 陈旧/待复核 | ✅ 已实现 | 只读快照（`build.ts` 单事务 REPEATABLE READ 读 9 张 `mr_*`、fail-closed）每条断言事实带 `source_url`/`source_confidence`；离散 `stale` 聚合 plan+child+关联源 last_checked（NULL 仅 source 可达）、source/vendor flag 传导；内容哈希 ETag（5c-⑤）。 |
| 数据红线（未核价不冒充已核） | ✅ 已实现 | confidence↔price 绑定落共享 `mrPlanWriteSchema`（覆盖 `upsertPlan` 新建插入）+ `recordPriceChange` 官方断言；金额量级无关校验（负/NaN/Infinity/超 scale/JS 进制字面量全拒）；provenance `sourceUrl` 非空（读写两侧）。 |

> **持续运营动作（未结，非「写完即完成」）**：桶2 真实价格策展——本期 5 家（百炼/千帆/腾讯/火山/讯飞）结构性录入但 **0 已核价**（NULL + `needs_login_recheck` 占位），真实价由 **5d-C 桶2真价人工策展**（`add-model-radar-bucket2-price-curation`）经既有授权改价入口 `recordPriceChange` 人工录入——与 browser/egress 启用**正交、不以其为前置**（egress 勘验已拆出延后到真开自动抓取那步）。常驻周期 rebuild worker（链7）+ 跨进程 Redis pub/sub 失效**已随 5d-A 装配并归档**（PR #47；5c 当时仅交付可调 rebuild job body + CI 测，5d-A 接 live 消费者）。

### 5e 退出标准达成

`add-model-radar-recommender` 提案已实现并归档（PR #50 合并；主规范新增 `model-radar-recommender` 5 需求）。退出标准由纯函数推荐器 + DB 精确事实保障并有测试覆盖（`src/mr/recommend` / `src/mr/snapshot/limits` / `src/mcp/tools/recommend-coding` 全量 vitest 全绿）。经 **3 轮 propose review-loop + 2 轮 code review-loop**（Codex + Code Reviewer + Reality Checker §1b + MCP Builder 增援 + Ponytail）+ CodeRabbit 复审收敛。tech-plan 锁 **v1=规则+模板**，RAG 证据 + LLM 解释为 v2（仅换可插拔解释层、召回不动）。

| 退出标准 | 状态 | 实现与证据 |
| --- | --- | --- |
| 「重度 Claude Code + GLM-4.6 最便宜可用」给出排名 | ✅ 已实现 | 召回经 vetted `queryModelRadarSnapshot`（**不手搓 money-path**）；四态有序 verdict（`insufficient_data` > `not_recommended` > `primary`(eligible 最低) > `alternative`）；退出用例测 → 首选 GLM Lite ¥49、Pro ¥149 转 alternative。 |
| 是否撞窗 + 月成本 + 依据 | ✅ 已实现 | 撞窗经 snapshot 层纯数值原语 `fitsWindow`（6-arm 按 limitType 分派、空限额/口径未知→`unknown` 不假装、多限额取最紧）、标 **⚠ 估算**不进哈希；现数据桶2 全 `value:NULL` → 如实标「额度口径未知」；每条候选带 per-fact `source_url`/`lastCheckedDate`/`source_confidence`。 |
| 从 Claude/Cursor 直接调用 | ✅ 已实现 | MCP 单工具 `recommend_coding_subscription`（native ZodRawShape 入参 + `.describe()` 枚举、`structuredContent`+`readOnlyHint`）；**env-clean 动态取快照**（`build.ts` `import type` + `thresholdDays` 必填，仅 `DATABASE_URL` 的 MCP 进程现 build 不崩，`query-chain-env` 静态+剪裁-env 实跑双守卫）；只读、快照不可用 fail-closed（不编推荐）。 |

> **诚实红线（程序+DB 保障）**：价格/兼容/额度 = DB 精确事实、规则不离谱；撞窗 = ⚠ 估算、不进哈希；未核价/待核标 `insufficient_data` 不冤判「不推荐」（沿用比价页「数据不足」诚实）；不跨桶/跨币 FX（锁请求币种组、剔他币种已知价）；解释层 v1 无 LLM、`evidence?` 槽留 v2。
> **5e v2（未结，后续）**：把模板解释层换为 RAG 证据（接知识库 + 变更流）+ LLM 解释，召回/候选 schema 不动（`ExplanationInput→Promise` 接口已留缝）。

## P1 退出标准达成

`minimal-intel-pipeline` 提案已实现，三条可观测退出标准均由程序 + DB 保障并有不变量测试覆盖：

| 退出标准 | 状态 | 实现与证据 |
|---|---|---|
| 每日定时推 Top N | ✅ 已实现 | BullMQ 每日 cron 重复任务（`DAILY_DIGEST_CRON`，默认 08:00 Asia/Shanghai）触发 `runDailyWorkflow()`（`src/pipeline/`）；组合分排序 + importance 下限闸 + 确定性 tiebreaker 取 Top N。`npm run worker` 起常驻调度，`npm run smoke` 手动触发一次。 |
| 同一天同一条不重复 | ✅ 已实现 | event 粒度幂等：`UNIQUE(target_type, target_id, channel, push_date)` + 待发集合显式排除「今日已 success」+ Redis 全局单例锁（同 `push_date` 仅一实例）。覆盖测试：`src/push/__tests__/dispatch.integration.test.ts`（pushIdempotency / 单例锁，本地实跑 7 用例全绿）。 |
| 带 utm 的 URL 被归一为同一条 | ✅ 已实现 | URL 归一去 `utm/ref/gclid/fbclid/spm` + query 排序 + host 小写 + 去尾斜杠 → `canonical_url`；`dedup_key` 经 `ON CONFLICT` 塌缩为单一 `ai_news_events`。覆盖测试：`src/dedup/__tests__/normalize.test.ts` + `collapse.integration.test.ts`（dedup 不变量，本地实跑全绿）。 |

> 验证：本地 `docker compose up -d` + `npm run migrate`（两次重跑验证迁移幂等）后，全量 vitest **126 测试全绿**
> （含 pushIdempotency / dedup / URL 归一 / 降级熔断 10.4 / 单例锁五组不变量，连真实 pg+redis 实跑不 skip）。
> CI（`.github/workflows/ci.yml`）带 postgres(pgvector) + redis services，迁移幂等与上述不变量测试在 CI 路径内实跑。
> **真实 Telegram 送达**需真实 `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` + 外网，交付用户本地执行 `npm run smoke` 确认。

## P2 退出标准达成

`expand-sources-dual-channel-products` 提案已实现（M1 扩源 → M2 双通道 → M3 产品发现 → M4 告警/周报），四条可观测退出标准均由程序 + DB 保障并有不变量测试覆盖：

| 退出标准 | 状态 | 实现与证据 |
|---|---|---|
| 双通道均不重复推 | ✅ 已实现 | dispatcher channel 参数化（`src/push/dispatcher.ts` + `src/push/targets.ts` 枚举收口 `target_type={event,product,alert,weekly}` / `channel={telegram,feishu}`）；幂等四元组 `UNIQUE(target_type, target_id, channel, push_date)`，候选/待发按 channel 分别判定「从未以该 channel success」，同事件可分别进 telegram 与 feishu 候选、各自独立幂等。飞书 sender + 签名 + JSON 卡片渲染（`src/push/feishu.ts`），可选通道（两者全配才 enabled，纯 Telegram 部署照常启动）。覆盖测试：`src/push/__tests__/dispatch.integration.test.ts`（同事件不同 channel 各自独立幂等、telegram 已 success 不抑制 feishu 待发）、`src/push/__tests__/feishu.test.ts`（卡片渲染 / channel='feishu' 幂等 / 单通道失败隔离 / 纯 Telegram 启动）。 |
| 每日产品发现推送 | ✅ 已实现 | Product Hunt 采集先落 `raw_items`（`source=product_hunt`、`raw_type=product`，`src/collectors/product-hunt.ts`）→ 确定性硬合并塌缩进 `ai_products`（全部非空归一键 `FOR UPDATE` 收集命中、按 `canonical_domain`/`github_repo`/`product_hunt_slug` 唯一键 INSERT/UPDATE/冲突分流，全程无 LLM，`src/collectors/product-collapse.ts`）；独立 BullMQ 调度（`src/pipeline/product-digest.ts`，`target_type=product`、独立单例锁 `product-digest:{channel}:{push_date}`），候选「该 product_id 从未以该 channel success」跨天不重推 + 排除 `merge_conflict`。覆盖测试：`src/collectors/__tests__/product-collapse.integration.test.ts`（单行 product_id 不变 / 非空 name 兜底 / 多键多行冲突告警不静默择一 / NULL 键不放行 / 零 LLM）、`src/pipeline/__tests__/product-digest.integration.test.ts`（同天同通道不重推 / 跨天不再重推 / 冲突态排除 / 与事件日报 target_type 不挤占）、`src/db/__tests__/ai-products-migration.integration.test.ts`（落表 + 三唯一约束 + 迁移幂等 + 无向量列）。 |
| 实时告警跑通 | ✅ 已实现 | 高频独立调度（`src/pipeline/alert-queue.ts` + `alert-scan.ts`，默认每 20min，只采实时新闻源 `{rss,hacker_news,github}`）→ 塌缩 → 评分 → **评分后**判 `importance_score >= ALERT_IMPORTANCE_THRESHOLD`（默认 85，纯程序阈值）告警；四元组 `target_type=alert`、`target_id=event_id` 一生一次去重 + 独立单例锁 `alert:{channel}:{event_id}`；Value Judge 并发原子 claim（`judge_claimed_at` 列 + 回收阈值 `T > L + W`，`src/agents/value-judge/score-events.ts`）防日报链/告警链双评分。覆盖测试：`src/pipeline/__tests__/alert-scan.integration.test.ts`（评分后达阈值即告警 / 评分前不误判 / 日报已推同事件仍可 alert / 一生一次 / 同日并发 UNIQUE 兜底 / 低于阈值不触发 / 无摘要 headline 回退）、`src/agents/value-judge/__tests__/claim.integration.test.ts`（两链路并发只评一次 / claim 后崩溃经 T 重评 / 逼近 L+W 不误回收）。 |
| 周报跑通 | ✅ 已实现 | 周级独立调度（`src/pipeline/weekly-report.ts`，默认每周一 09:07）：程序规则从「被汇总窗口 `[上周一,本周一)`」选高价值事件/产品、复用已落库 `summary_zh`/`headline_zh` 零 LLM；四元组 `target_type=weekly`、`target_id=iso_week`、`push_date=该 ISO 周周一`，iso_week 与 push_date 同源锚定汇总窗口（防跨周边界抖动错配）+ 独立单例锁 `weekly:{channel}:{iso_week}`。覆盖测试：`src/pipeline/__tests__/weekly-report.test.ts`（同一 ISO 周内抖动触发不改变 target_id/push_date）、`src/pipeline/__tests__/weekly-report.integration.test.ts`（同周不重推 UNIQUE 兜底 / 周报与日报 target_type 不挤占）。 |

> **arXiv 增量采集（at-least-once）**：arXiv 仅在日报链采集（非实时，不入告警链），仅落 `raw_items` 作数据沉淀（`collapsed=true`、不进事件塌缩/日报/推送）。游标接线选**固定回溯窗口**方案（`src/collectors/arxiv-cursor.ts`：`load()` 返回 `now − 7d` 作 OAI-PMH `from`，`commit` no-op），**无漏窗 + crash-safe 由「固定窗口重叠 + `UNIQUE(source, source_item_id)` 幂等吸收重抓」共同保障**，无需新建表或持久化游标。`src/pipeline/run-daily-workflow.ts` 在采集阶段注入默认游标（调用方未自带 arxiv 选项时）。覆盖测试：`src/collectors/__tests__/collectors.test.ts`（回溯窗口下界 / commit no-op / 接入 harvest 首请求带 `from=窗口下界`，注入桩不触网）。
>
> **降级熔断扩展（M2）**：全失败告警分母改 registry 全部源、新闻类可处理条目分母（排除 `raw_type` product/paper）、分发失败不计入 judge/摘要熔断分母、仅日报链套用高频告警链不套用（`src/pipeline/circuit-breaker.ts`，覆盖测试 `src/pipeline/__tests__/circuit-breaker.test.ts`「仅 arXiv 返回 paper、新闻源全空 → 仍按新闻真空告警」）。

> 验证：本地 `docker compose up -d`（postgres pgvector + redis healthy）+ `npm run migrate` **连续两次重跑**验证迁移幂等（含 `ai_products` forward-only 0004 + `judge_claimed_at`；第二次无新 SQL，journal 维持 5 条已应用、结构无变化）后，全量 vitest **287 测试全绿、0 skip**（连真实 pg+redis 实跑不 skip）；`npx tsc --noEmit` 0 错、`npm run lint` 0 错。
> CI（`.github/workflows/ci.yml`）带 postgres(pgvector) + redis services，注入全部必填 env 占位（含 `PRODUCT_HUNT_TOKEN`），迁移幂等与上述不变量测试在 CI 路径内实跑。
> **真实鉴权/配额勘验**（PH Developer Token 拉一次 + 剩余复杂度点、arXiv OAI-PMH 拉一次确认 ≥3s 不被 429、飞书 webhook 发一条测试卡片）需真实凭据 + 外网、**无法在本环境复现**，交付用户本地用真实凭据执行（结果作 artifact 附 PR）；持续节流/退避逻辑已由单测（注入桩）覆盖。

## P3 退出标准达成

`add-semantic-dedup-and-store-hardening` + `add-cross-segment-dedup-and-hn-purify` 两提案已实现并归档；语义去重与本地表知识库均落地，迁移 `0006_p3_vector_kb` 接线（pgvector 扩展 + `ai_news_events.embedding vector(1536)` / `merged_into varchar(128)` 两列 + `kb_documents` / `kb_ingestion_records` 两表）。

| 退出标准 | 状态 | 实现与证据 |
|---|---|---|
| 中英文同一事件被识别为一条 | ✅ 已实现 | pgvector 向量召回 + 分层判定：`cosine_sim > SEMANTIC_DEDUP_HIGH` 直接合并（high-auto，不调 LLM）/ 灰区 `LLM < sim ≤ HIGH` 交 LLM 二次判断 / 否则不合并；合并经 `ai_news_events.merged_into` tombstone（替代事件-产品关系表）。模块：`src/dedup/{embedding,semantic-search,semantic-judge,semantic-merge,merge-events}.ts`；跨切片去重 + HN 提纯见 `add-cross-segment-dedup-and-hn-purify`。 |
| 阈值经真实数据调过 | 🟡 接线就位，复校待运营 | 阈值为 QA §9.2 起点默认（`SEMANTIC_DEDUP_HIGH=0.88` / `SEMANTIC_DEDUP_LLM=0.82`，env 可调，`src/config/env.ts` 注明「非实测调优」），分层判定全程可工作；**真实数据复校是持续运营动作、尚未做**，roadmap 已为其留迭代回合，不按「写完即完成」记。 |
| KB 可检索 | ✅ 已实现（本地表先行） | 只入 `long_term_value≥70` 精选（Zod 钉死 `int().min(0).max(100)` 防越界绕闸），幂等两表原子写入 `kb_documents` + `kb_ingestion_records`（`UNIQUE(target_type,target_id,kb_provider)`），`kb_provider='custom'` 本地表，含 `embedding vector(1536)` 列可作向量检索。Dify HTTP 作后续可替换黑盒消费、本期未接（符合 roadmap「本地表 → Dify HTTP」分步口径）。模块：`src/kb/{ingestion-agent,store,schema}.ts`。 |

> 迁移证据：`src/db/__tests__/p3-vector-kb-migration.integration.test.ts` 断言 `0006_p3_vector_kb` 启用 vector 扩展、`ai_news_events` 补 `embedding`/`merged_into` 两列、新建知识库两表及入库幂等唯一约束。

## P4 退出标准达成

`add-mcp-query-server` 提案已实现并归档。

| 退出标准 | 状态 | 实现与证据 |
|---|---|---|
| 从 Claude/Cursor 查到当日日报与历史 | ✅ 已实现 | 独立 MCP server 进程（stdio transport，`src/mcp/server.ts`），与流水线并列、**不参与日报调度**；暴露 7 工具（5 查询 + 2 标记 + `push_event_now`）：`get_today_ai_digest` / `search_ai_events` / `search_ai_products` / `mark_*` / `push_event_now`。客户端配置（Claude Desktop / Cursor，直接 `tsx` 跑 `src/mcp/server.ts` 防 stdout 污染）见 README「MCP 查询入口」。 |

> `recommend_ai_tools_for_task` 属 P5（工具选型顾问），本期不含——schema 仍禁建 `ai_tools` / `task_patterns`。

## 排序依据

- **P1 选 Telegram 单通道**：只为先打通最简推送链路验证整条管道；飞书 P2 补，二者可互换。
- **产品合并 P2 用硬规则先行**（`canonical_domain` / `github_repo` / `product_hunt_slug` 唯一键），昂贵的语义合并留到 P3 与事件去重共用 embedding 设施。
- **MCP（P4）排在有数据之后**：无积累的事件/产品则查询接口无内容；可与 P3 并行。
- **Model Radar（P5）提优先级**：地基（P0–P4）已稳，Model Radar 价值高、数据已核、schema 最结构化，且是项目首个 Web 前端的自然载体；先用编程垂类把「规则召回 → RAG → LLM 解释」推荐器跑通，再泛化。
- **泛化顾问（P6，原 P5）后置**：作为 Model Radar 的超集，最依赖前期沉淀的结构化产品库，宜在垂类验证后做。

## 横切关注点（每期都带，不单独排期）

每个 PR 都须满足，否则违反 `config.yaml` 不变量：

- Agent 输出一律 Zod 校验，失败重试/降级而非吞掉；
- 所有外部 API 调用带重试 + 错误日志；
- 推送一律"先写 `pending` → 调 API → 置 `success`/`failed`"，唯一键冲突即跳过；
- 每期补对应不变量测试（P1 起即有 `pushIdempotency` / `dedup` / URL 归一 三个 Vitest）。

## 风险与缓冲

- **VibeCoding 改变时间结构**：写代码更快，省下的时间转到验证与调参——去重阈值（P3）、提示词质量（P1/P5）是经验性的，排期已为其留迭代回合，不按"写完即完成"估。
- **外部源认证/限流**（Product Hunt、Reddit、PH 排名）是 P2 主要不确定性：建议 P0/P1 期间先各跑一次手动抓取确认配额与鉴权。
- **数据沉淀是日历时间输入**：P3 阈值调优与 P5 顾问都需 P1/P2 已运行数周积累真实数据，不宜在无数据阶段提前压上。

## 与 OpenSpec 的衔接

本仓库为 spec-driven。建议**逐期立提案**（`/opsx:propose`）：先做 P0 + P1，其余各期在前一期收尾时再提案，避免把仍会变动的后期细节过早写死。Model Radar（P5）按 **5a–5e 逐步立提案**，5a（数据模型 + provenance）先行，其余依赖它；每个提案须含「非目标」并对齐上方「不可违背」清单。
