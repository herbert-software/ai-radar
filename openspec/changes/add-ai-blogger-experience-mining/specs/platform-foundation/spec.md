## 修改需求

### 需求:数据库 Schema 可迁移

系统必须用 Drizzle 定义并通过 `drizzle-kit migrate` 落库核心表 `raw_items`、`ai_news_events`、`push_records`。三张表的列必须对齐 QA.md §8.1 / §8.2 / §8.6 的 DDL（不得只建主键与唯一约束的空壳表）。`drizzle-kit migrate` 必须可重复执行：已应用的迁移被跳过、命令成功返回、数据库结构无变化（迁移 journal 级幂等）。本期（P2）在 P1 三表基础上**解禁并新建 `ai_products` 表**（产品发现所需，见「ai_products 产品表可迁移」需求）。**P3 起新增 `kb_ingestion_records` 与 `kb_documents` 两张知识库表（见 knowledge-base capability），并为 `ai_news_events` 增 `embedding` 与 `merged_into` 列（见「P3 向量与知识库 Schema 可迁移」需求）**；**本变更（AI 博主经验提炼）起新增 `ai_experiences` 表（经验卡片所需，见 blogger-experience-mining）**；仍禁止定义 `item_event_relations` / `item_product_relations` / `ai_tools` / `task_patterns`（事件-产品关系表 P3 改用 `ai_news_events.merged_into` tombstone 替代、不建关系表；工具/任务模式表留待 P5 顾问期提案再加）。

schema 必须包含以下列与约束（P1 已落库，P2 沿用、不得回退）：

- `ai_news_events.event_id` 必须为不透明 surrogate key，其值不得由内容（如 `canonical_url` 哈希）派生——以保证 P3 语义合并时事件身份稳定、历史引用（`push_records.target_id` 等）不需迁移。为与 `push_records.target_id`（`VARCHAR(128)`）保持类型一致以便 `target_id=event_id` 互引，`event_id` 必须保留 `VARCHAR(128)` 列类型，并设数据库默认值 `gen_random_uuid()::text`——使塌缩 `INSERT` 省略 `event_id` 时由数据库生成 UUID 文本，禁止由应用层用内容派生值填充。
- `ai_news_events` 必须新增 `dedup_key` 列并建 `UNIQUE(dedup_key)`，作为硬去重塌缩的冲突键（`INSERT ... ON CONFLICT (dedup_key) DO UPDATE`）。
- `ai_news_events` 必须新增 `representative_raw_item_id` 列，记录塌缩时第一条命中的 `raw_item` 主键。
- `ai_news_events` 必须新增 `published_at` 列（可空），承载代表 `raw_item` 的发布时间，供 Top N 排序 tiebreaker 使用——`ai_news_events` 此前无 `published_at` 列（仅 `first_seen_at` / `last_seen_at`），不补则排序字段不存在。
- `raw_items` 必须新增 `title_hash` 列，承载标题归一化哈希。
- `raw_items` 必须新增 `unprocessable` 标记列（`BOOLEAN NOT NULL DEFAULT false`），承载「既无可用 `canonical_url` 又归一后标题为空」的兜底状态——P0 `raw_items` 无任何状态列，不补则该兜底需求无落点。
- `raw_items` 必须含 `collapsed` 标记列（`BOOLEAN NOT NULL DEFAULT false`，P1 已落库，本期沿用并扩展语义）：对新闻类行表示「已塌缩进 `ai_news_events`」；P2 扩展为对 `raw_type='product'` 行表示「已塌缩进 `ai_products`」、对 `raw_type='paper'` 行表示「已沉淀/已路由」（入库即置 `true`）；本变更扩展为对 `raw_type='experience'` 行表示「已沉淀、由经验链消费」（入库即置 `true`）。dedup 类型路由与产品/经验塌缩均依赖此列的 `collapsed=false` 过滤避免每轮无界重扫（见 dedup-and-normalization、product-discovery 与 blogger-experience-mining）——spec 显式声明此列存在，使据 spec 重建 schema 不漏列。
- `raw_items.canonical_url` 由 P0 的「建好但不生成其值」转为本期必须真正生成并写入（采集/规范化阶段填值）。
- `ai_news_events` 必须保留 P0 的 `importance_score` / `novelty_score` / `developer_relevance_score` / `hype_risk_score` / `should_push` / `summary_zh` / `first_seen_at` / `last_seen_at` / `source_count` 等列；`raw_items` 必须保留 `UNIQUE(source, source_item_id)`。

P2 必须为 `ai_news_events` 新增 `judge_claimed_at TIMESTAMPTZ`（可空）列：承载 Value Judge 评分前的原子 claim（日报链与实时告警高频链并发评分时，只有 `UPDATE ... SET judge_claimed_at WHERE *_score IS NULL AND (judge_claimed_at IS NULL OR judge_claimed_at < now() - interval 'T') RETURNING` claim 成功者送 LLM，防双评分覆写，见 daily-intel-pipeline「降级逐条容错」为权威定义）；含超时回收项（`OR judge_claimed_at < now()-T`，`T > L + W`）使 claim 后崩溃的事件可被后续运行重新 claim，该列与「僵尸 claim 回收」语义配套。

**本变更（AI 博主经验提炼）新增 `ai_experiences` 表**（forward-only，承载经验卡片）：主键 `id VARCHAR(128) PRIMARY KEY DEFAULT gen_random_uuid()::text`（不透明 surrogate，与 `event_id`/`product_id` 同口径，使 `push_records.target_id = ai_experiences.id` 互引类型相容）；`canonical_source_url TEXT NOT NULL` 并建 `UNIQUE(canonical_source_url)`（去重塌缩冲突键）；`representative_raw_item_id BIGINT NOT NULL`（provenance 回指 `raw_items.id`，**裸 bigint 无外键**，对齐既有 `ai_news_events.representative_raw_item_id`/`ai_products.representative_raw_item_id` 的零 FK 惯例）；结构化经验字段 `scenario TEXT` / `tools JSONB` / `techniques TEXT` / `applicability TEXT`；`long_term_value INTEGER NOT NULL`（0..100，由提炼 Agent 产出并 Zod 约束，兼作 KB 准入闸与实践锦囊排序键，不另设 importance_score）；`headline_zh TEXT` / `summary_zh TEXT`（推送展示）；`published_at TIMESTAMPTZ`（recency 窗口，取自 raw_items）；`created_at TIMESTAMPTZ`。**不含向量列、不建二级索引**（对齐基线惯例——全库零 secondary index，数据量小排序顺序扫足够，未来慢了再单独 forward-only 迁移加索引；UNIQUE(canonical_source_url) 自带索引已够去重 ON CONFLICT）。

迁移对既有数据的处理：P2 必须以 forward-only 迁移（追加新迁移序号、不重写既有 0000–0003）落新增的 `ai_products` 表、`ai_news_events.judge_claimed_at` 列及任何新增列；本变更的 `ai_experiences` 表同样以 forward-only 追加迁移落库，禁止 drop 既有上线数据表重建。迁移幂等口径为「经 `drizzle-kit migrate`（drizzle journal 跳过已应用项）可重跑」，**非** SQL 文件自身可重入。

`push_records` 必须保留 `UNIQUE(target_type, target_id, channel, push_date)` 唯一约束。本期推送链路扩展为多通道与多 `target_type`，系统必须实际写入推送记录（先 `pending`、成功 `success`、失败 `failed`）。`target_type` 与 `channel` 的取值必须由程序集中定义的枚举（如 Zod enum）统一收口，禁止在各推送路径散落字面量——避免某处误拼（如 `'alerts'`、`'Event'`）使幂等四元组静默分裂成两个命名空间、绕过去重而漏推/重推（DB 裸 `varchar` 不挡拼写错）。**权威全集必须显式声明**：`target_type` 枚举 = `{event, product, alert, weekly, experience}`、`channel` 枚举 = `{telegram, feishu}`；新增 `target_type`/`channel` 必须先扩此枚举再使用（该枚举 push 与 KB 入库共用，一处改两处生效）。该全集相对 QA.md §8.6 注释集 `event/product/paper/repo` 是**双向有意偏离**，两个方向都须自洽说明：① **收口**：`paper`/`repo` 不在范围（arXiv 论文仅采集沉淀、不推送，见 source-collectors 与 proposal 非目标），留后续期；② **扩张**：`alert`/`weekly`（P2 相对 QA §8.6 注释新增，实时告警与周报各需独立幂等命名空间，见 realtime-alerts / weekly-report）与 `experience`（本变更新增，AI 博主经验的实践锦囊推送需独立幂等命名空间，见 blogger-experience-mining）。此偏离不与 QA.md 的 DDL 冲突，因为 §8.6 的 `-- event/product/paper/repo` 是 **SQL 行内注释、非 `CHECK` 约束**（QA.md DDL 中 `target_type VARCHAR(32)` 无 CHECK），枚举集可由实现期收口/扩张而不破坏 DDL；CLAUDE.md 以 QA.md 为最高权威，此处对其注释集的偏离已显式登记为有意决策。

#### 场景:迁移落核心表与本期新增列
- **当** 对一个空数据库执行 `drizzle-kit migrate`
- **那么** 数据库中存在 `raw_items`、`ai_news_events`、`push_records` 三张表，且 `ai_news_events` 含 `dedup_key`（UNIQUE）、`representative_raw_item_id`、`published_at`、`judge_claimed_at`，`raw_items` 含 `title_hash`、`unprocessable`、`collapsed`

#### 场景:event_id 为不依赖内容的 surrogate key 且与 target_id 类型一致
- **当** 检视 `ai_news_events.event_id` 的列类型与默认值
- **那么** 其列类型为 `VARCHAR(128)`（与 `push_records.target_id` 一致）、默认值为 `gen_random_uuid()::text`，不由 `canonical_url` 等内容哈希派生

#### 场景:ai_experiences 主键与 target_id 类型相容、去重唯一键就位
- **当** 检视 `ai_experiences` 表结构
- **那么** 其主键 `id` 列类型为 `VARCHAR(128)`、默认值 `gen_random_uuid()::text`（与 `push_records.target_id` 一致，供 `target_id=id` 互引），且存在 `UNIQUE(canonical_source_url)` 约束、`representative_raw_item_id` 为裸 `BIGINT`（无外键），无向量列与二级索引

#### 场景:dedup_key 唯一约束就位
- **当** 检视 `ai_news_events` 表结构
- **那么** 存在 `UNIQUE(dedup_key)` 约束，可作为塌缩 `ON CONFLICT` 的冲突目标

#### 场景:迁移可重跑且幂等
- **当** 在已迁移的数据库上再次执行 `drizzle-kit migrate`
- **那么** 已应用的迁移被跳过、命令成功返回、表结构无变化、不报错

#### 场景:推送幂等唯一约束就位
- **当** 检视 `push_records` 表结构
- **那么** 存在 `UNIQUE(target_type, target_id, channel, push_date)` 约束

#### 场景:P3 起解禁知识库表 经验表新增 关系/顾问表仍禁止
- **当** 检视累计迁移（P2 + P3 + 本变更）
- **那么** 存在 `ai_products` / `kb_documents` / `kb_ingestion_records` / `ai_experiences` 表，`ai_news_events` 含 `embedding` / `merged_into` 列，且不含 `item_event_relations` / `item_product_relations` / `ai_tools` / `task_patterns` 四张表
