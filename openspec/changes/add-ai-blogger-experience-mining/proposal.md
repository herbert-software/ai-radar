## 为什么

大量 AI 工具的**真实使用经验与选型心得**散落在 AI 博主的博文和视频里（"用 Cursor 还是 Cline"、"内部知识库 Dify/RAGFlow/FastGPT 怎么选"、"某 Agent 框架踩过哪些坑"）。这正是 QA.md §15「AI 工具选型顾问」明确指出"不能只靠 RAG"所缺的那层证据——纯靠官方文档与新闻无法回答"实际用起来哪个更合适"。当前流水线只采新闻/产品/论文/仓库，没有"实践经验"这条进料，P5 顾问将无米下锅。

本变更新增一条**每日 AI 博主实战经验提炼**进料：每天从策划的一批 AI 博主（博客/Substack/有字幕的 YouTube）找到合适内容，提炼成结构化"经验卡片"，精选沉淀进知识库作为顾问的实战证据语料。

## 变更内容

- 新增一批**策划的 AI 博主 feed**（博客/Substack 自带全文 + YouTube 频道 RSS），复用现有 RSS 采集管道接入，**用独立 `BLOGGER_FEEDS` env**（同 `URL|vendor` 格式，零破坏既有 `RSS_FEEDS`）。经验类条目以**两个确定性硬字段**标记：`source='blogger'` + **新 `raw_type='experience'`**（不复用 `raw_type='post'`——`post` 已被 Hacker News 占用且被现有塌缩当新闻类纳入 `ai_news_events`）。
- 经验类条目**入库即置 `collapsed=true`**（沉淀，镜像 arXiv 论文），天然被新闻/告警塌缩入口的 `collapsed=false` 过滤排除在外；并在塌缩类型路由显式排除 `raw_type='experience'`（双保险）——故经验内容**绝不进** `ai_news_events`、绝不进要闻段、绝不进告警链。
- **YouTube 字幕优先取正文**：YouTube 频道 RSS 只给标题+简介，真正经验在视频里——对**有字幕**的视频拉取 transcript 作 `content`；**不跑 ASR**（无字幕视频如 B 站中文生态本期仅做发现、不取正文）。拉取 transcript 是采集阶段的逐条异步增强（须改 `collectRss` 结构、非零改动），失败隔离退化为仅标题+简介。
- 新增**经验提炼 Agent**：区别于新闻摘要，对经验类条目输出结构化 JSON（场景 / 涉及工具 / 具体做法或技巧 / 适用条件 + `long_term_value`；**不含来源链接**——来源 URL 取自确定性 `canonical_source_url`，非 LLM 输出），Zod 校验（`long_term_value: int 0..100`），失败重试或降级，对齐"Agent 输出一律结构化校验"不变量；提炼前对超长 transcript/博文按 `EXPERIENCE_TEXT_MAX_CHARS` 截断（镜像 `EMBEDDING_TEXT_MAX_CHARS`）。
- 新增轻量实体表 `ai_experiences`（系统级事实/状态以 DB 为准），承载提炼后的经验卡片。**主键 `varchar(128)` 不透明 surrogate**（`gen_random_uuid()::text`，与 `event_id`/`product_id` 同口径，使 `push_records.target_id` 互引类型相容）；**去重唯一键用 `canonical_source_url`**（经验行的规范化来源 URL，跨 feed 同一视频/同 watch URL 自然收敛——比 `raw_item_id` 更稳，因同视频经不同 feed 会得不同 `source_item_id`）；`representative_raw_item_id` 作 provenance（裸 bigint、对齐既有零 FK 惯例）。
- **价值闸门复用**：经验卡片同样走"价值判断"口径（Agent 打 `long_term_value`、程序判闸门），只把 `long_term_value >= 70` 的精选入知识库（严守 QA.md §13.1「知识库不是垃圾桶」）。入 KB **复用 `storeKbDocument` 原语 + `kb_ingestion_records` 幂等**，但**候选选择须新写**（既有 KB 候选编排绑死 `ai_news_events`，见修改功能 knowledge-base），候选 = `ai_experiences.long_term_value>=70`、`target_type='experience'`，复用同一个 `KB_ADMISSION_FLOOR` 常量（不造第二个 70）、不再调 KB Agent 重算评分。
- 新增**每日「实践锦囊」digest 段**：**内联进 `runDailyWorkflow`、搭日报单例锁 `daily-digest:{push_date}` 便车执行**（镜像产品段现状——product 段已从独立调度退化为日报内联段），不新增 queue/cron/独立锁。复用 Push Dispatcher channel 参数化 + 幂等四元组（`target_type='experience'`、`target_id=经验卡片主键`）。时效性：候选带 `published_at` 窗口谓词（对齐既有日报 recency 机制）+ "该卡片从未以该 channel success" 跨天不重推，**禁止上线后批量回推**旧经验。提炼/塌缩为 channel-blind 动作，每批只跑一次再按 channel 展开候选。

## 功能 (Capabilities)

### 新增功能
- `blogger-experience-mining`: AI 博主经验提炼能力——经验类内容的 YouTube 字幕取正文、经验提炼 Agent（结构化 JSON + Zod，`long_term_value` 0..100）、`ai_experiences` 实体表与确定性去重（`canonical_source_url` 唯一键）、经验卡片的 KB 沉淀（自建候选 + 复用 `storeKbDocument`/幂等/`KB_ADMISSION_FLOOR`）与每日「实践锦囊」推送段（内联日报、`target_type='experience'`、`published_at` 时效窗口）。

### 修改功能
- `source-collectors`: 新增**策划 AI 博主 feed 接入**（独立 `BLOGGER_FEEDS` + 新 `source='blogger'`，须扩 `CollectorSource` 联合类型与 registry，并显式声明 blogger 不归实时/产品采集子集）+ **经验类硬字段标记**（`source='blogger'` + `raw_type='experience'`，入库即 `collapsed=true`）+ **YouTube 有字幕取 transcript** 的逐条异步采集增强（改 `collectRss` 结构、失败隔离）。
- `dedup-and-normalization`: 塌缩类型路由的排除集从 `{product, paper}` 扩为 `{product, paper, experience}`（查询层 `raw_type IS DISTINCT FROM 'experience'`），并把 `experience` 行的 `collapsed` 语义定义为「入库即沉淀、由经验链消费」——使经验类不被新闻/告警事件塌缩消费。
- `platform-foundation`: `target_type` 权威枚举全集从 `{event, product, alert, weekly}` 扩为含 `experience`；迁移新建 `ai_experiences` 表（forward-only）。
- `knowledge-base`: 知识库准入闸的**候选域**从"仅已推送成功的 `ai_news_events` 事件"扩展为**额外纳入经验来源**——候选含 `ai_experiences.long_term_value>=70` 的经验卡片（`target_type='experience'`），复用 `≥70` 闸与入库幂等。

## 影响

- **数据模型**：新增 forward-only 迁移建 `ai_experiences` 表（`varchar(128)` surrogate PK、`canonical_source_url` 唯一键、`representative_raw_item_id` 裸 bigint NOT NULL、结构化字段、`long_term_value int`、`headline_zh`/`summary_zh`、`published_at`、`created_at`；无向量列、无二级索引——对齐基线惯例）。不动既有表。
- **采集**：新增 `BLOGGER_FEEDS` env、`EXPERIENCE_TEXT_MAX_CHARS` 截断 env；`CollectorSource` 加 `'blogger'`；新增 YouTube transcript 拉取（可能引入一个轻量 transcript 依赖或直接拉 timedtext，带重试 + 错误日志）；改 `collectRss` 支持逐条异步增强。
- **塌缩**：`collapse.ts` 类型路由排除集加 `experience`（一处覆盖日报 + 告警两条链）。
- **Agent**：新增经验提炼 Agent（`generateObject` + Zod，含 `long_term_value` 0..100 边界）。
- **推送**：Push Dispatcher 新增 `target_type='experience'`（扩 `targetTypeEnum` + `TARGET_TYPE` 常量，push 与 KB 入库共用此枚举）；实践锦囊段内联日报、复用幂等四元组与日报单例锁，不新增通道/调度。
- **知识库**：新增经验候选选择编排（复用 `storeKbDocument`/`kb_ingestion_records`/`KB_ADMISSION_FLOOR`）。
- **不影响**：既有新闻/产品/告警/周报链路的 target_type 互不挤占；去重/幂等/URL 归一/价值闸门仍由程序 + DB 保障。

## 非目标

- **不做 ASR/Whisper 转写**：无字幕视频（B 站等中文视频生态）本期仅做发现、不取正文；等字幕覆盖被证明不足再另起提案（ponytail 延后项）。
- **不做全 Agent 自治流**：找源、是否采、去重、推送幂等、价值闸门仍由程序 + DB 保障，Agent 只负责经验提炼这一步语义判断。
- **不新增推送通道**：复用既有 Telegram/飞书 dispatcher；实践锦囊段不独立调度。
- **不改既有去重/幂等/URL 归一不变量**；不把经验类内容混入新闻 event 的日报段（独立 `target_type`、独立实体表、塌缩显式排除）。
- **不做经验内容的语义/向量去重设施**（本期 `canonical_source_url` 硬键去重足够）：跨 feed 同一视频由 URL 收敛；不同 URL 的同义转载留待后续复用 P3 embedding 设施，本期不建。
- **不为经验链单独建熔断/告警**：本期经验提炼批失败仅记错误日志（低量级），失败规模可观测留待后续（Open Question）。
