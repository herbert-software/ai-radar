## 新增需求

### 需求:P3 向量与知识库 Schema 可迁移

系统必须以 forward-only 迁移（追加新迁移序号、不重写既有迁移）落 P3 语义去重与知识库所需的 schema，且 `drizzle-kit migrate` 可重复执行幂等：

- `CREATE EXTENSION IF NOT EXISTS vector;`（pgvector 扩展，镜像已是 `pgvector/pgvector` 无需换镜像）；
- `ai_news_events` 新增 `embedding vector(1536)`（可空）列，承载事件 embedding（维度由所选默认模型 `text-embedding-3-small` 定，钉死 1536，换不同维度模型属新迁移）；
- `ai_news_events` 新增 `merged_into varchar(128)`（可空）列，承载语义合并 tombstone 指针（指向存活事件 `event_id`，见 semantic-dedup「确定性事件合并」与 dedup-and-normalization「tombstone 改投」）；
- 新建 `kb_documents` 表（本地表知识库，含 `embedding vector(1536)` 供未来检索，见 knowledge-base「本地表知识库存储」）；
- 新建 `kb_ingestion_records` 表（QA.md §8.7）并建 `UNIQUE(target_type, target_id, kb_provider)`（见 knowledge-base「知识库入库幂等」）。

向量能力本期仅及于 `ai_news_events` 与 `kb_documents`，不及于 `ai_products`（产品语义合并不在本期范围）。迁移禁止 drop 既有上线数据表重建。

#### 场景:P3 迁移启用 vector 扩展与向量列
- **当** 对已落 P2 schema 的数据库执行 P3 新增迁移
- **那么** 存在 `vector` 扩展、`ai_news_events` 含 `embedding vector(1536)` 与 `merged_into varchar(128)` 列，存在 `kb_documents` 与 `kb_ingestion_records` 表（后者含 `UNIQUE(target_type, target_id, kb_provider)`）

#### 场景:P3 迁移 forward-only 且幂等
- **当** 在已迁移数据库上再次执行 `drizzle-kit migrate`
- **那么** 既有迁移不被重写、新增迁移被跳过、表结构无变化、不报错

## 修改需求

### 需求:容器化基础设施可编排
系统必须提供一份 `docker-compose.yml`，通过单条 `docker compose up` 启动 PostgreSQL 与 Redis 两项基础设施。PostgreSQL 必须使用 `pgvector/pgvector` 镜像，以便引入向量检索时无需更换镜像；**P3 起按需启用 `vector` 扩展与向量列**（仅 `ai_news_events` / `kb_documents`，见「P3 向量与知识库 Schema 可迁移」需求），P3 之前的期次不建 vector 列。Redis 必须可被应用连通（供 BullMQ 使用）。

#### 场景:一键启动基础设施
- **当** 在仓库根目录执行 `docker compose up`
- **那么** PostgreSQL 与 Redis 容器均成功启动并进入健康状态

#### 场景:PostgreSQL 使用 pgvector 镜像且 P3 起启用向量能力
- **当** 检视 `docker-compose.yml` 的 postgres 服务镜像与 P3 migration
- **那么** 镜像为 `pgvector/pgvector`，且 P3 migration 含 `CREATE EXTENSION vector` 与 `ai_news_events.embedding` 向量列（P3 之前的 migration 不含 vector 列）

### 需求:数据库 Schema 可迁移

系统必须用 Drizzle 定义并通过 `drizzle-kit migrate` 落库核心表 `raw_items`、`ai_news_events`、`push_records`。三张表的列必须对齐 QA.md §8.1 / §8.2 / §8.6 的 DDL（不得只建主键与唯一约束的空壳表）。`drizzle-kit migrate` 必须可重复执行：已应用的迁移被跳过、命令成功返回、数据库结构无变化（迁移 journal 级幂等）。本期（P2）在 P1 三表基础上**解禁并新建 `ai_products` 表**（产品发现所需，见「ai_products 产品表可迁移」需求）。**P3 起新增 `kb_ingestion_records` 与 `kb_documents` 两张知识库表（见 knowledge-base capability），并为 `ai_news_events` 增 `embedding` 与 `merged_into` 列（见「P3 向量与知识库 Schema 可迁移」需求）**；仍禁止定义 `item_event_relations` / `item_product_relations` / `ai_tools` / `task_patterns`（事件-产品关系表 P3 改用 `ai_news_events.merged_into` tombstone 替代、不建关系表；工具/任务模式表留待 P5 顾问期提案再加）。

schema 必须包含以下列与约束（P1 已落库，P2 沿用、不得回退）：

- `ai_news_events.event_id` 必须为不透明 surrogate key，其值不得由内容（如 `canonical_url` 哈希）派生——以保证 P3 语义合并时事件身份稳定、历史引用（`push_records.target_id` 等）不需迁移。为与 `push_records.target_id`（`VARCHAR(128)`）保持类型一致以便 `target_id=event_id` 互引，`event_id` 必须保留 `VARCHAR(128)` 列类型，并设数据库默认值 `gen_random_uuid()::text`——使塌缩 `INSERT` 省略 `event_id` 时由数据库生成 UUID 文本，禁止由应用层用内容派生值填充。
- `ai_news_events` 必须新增 `dedup_key` 列并建 `UNIQUE(dedup_key)`，作为硬去重塌缩的冲突键（`INSERT ... ON CONFLICT (dedup_key) DO UPDATE`）。
- `ai_news_events` 必须新增 `representative_raw_item_id` 列，记录塌缩时第一条命中的 `raw_item` 主键。
- `ai_news_events` 必须新增 `published_at` 列（可空），承载代表 `raw_item` 的发布时间，供 Top N 排序 tiebreaker 使用——`ai_news_events` 此前无 `published_at` 列（仅 `first_seen_at` / `last_seen_at`），不补则排序字段不存在。
- `raw_items` 必须新增 `title_hash` 列，承载标题归一化哈希。
- `raw_items` 必须新增 `unprocessable` 标记列（`BOOLEAN NOT NULL DEFAULT false`），承载「既无可用 `canonical_url` 又归一后标题为空」的兜底状态——P0 `raw_items` 无任何状态列，不补则该兜底需求无落点。
- `raw_items` 必须含 `collapsed` 标记列（`BOOLEAN NOT NULL DEFAULT false`，P1 已落库，本期沿用并扩展语义）：对新闻类行表示「已塌缩进 `ai_news_events`」；P2 扩展为对 `raw_type='product'` 行表示「已塌缩进 `ai_products`」、对 `raw_type='paper'` 行表示「已沉淀/已路由」（入库即置 `true`）。dedup 类型路由与产品塌缩均依赖此列的 `collapsed=false` 过滤避免每轮无界重扫（见 dedup-and-normalization 与 product-discovery）——spec 显式声明此列存在，使据 spec 重建 schema 不漏列。
- `raw_items.canonical_url` 由 P0 的「建好但不生成其值」转为本期必须真正生成并写入（采集/规范化阶段填值）。
- `ai_news_events` 必须保留 P0 的 `importance_score` / `novelty_score` / `developer_relevance_score` / `hype_risk_score` / `should_push` / `summary_zh` / `first_seen_at` / `last_seen_at` / `source_count` 等列；`raw_items` 必须保留 `UNIQUE(source, source_item_id)`。

P2 必须为 `ai_news_events` 新增 `judge_claimed_at TIMESTAMPTZ`（可空）列：承载 Value Judge 评分前的原子 claim（日报链与实时告警高频链并发评分时，只有 `UPDATE ... SET judge_claimed_at WHERE *_score IS NULL AND (judge_claimed_at IS NULL OR judge_claimed_at < now() - interval 'T') RETURNING` claim 成功者送 LLM，防双评分覆写，见 daily-intel-pipeline「降级逐条容错」为权威定义）；含超时回收项（`OR judge_claimed_at < now()-T`，`T > L + W`）使 claim 后崩溃的事件可被后续运行重新 claim，该列与「僵尸 claim 回收」语义配套。

迁移对既有数据的处理：P2 必须以 forward-only 迁移（追加新迁移序号、不重写既有 0000–0003）落新增的 `ai_products` 表、`ai_news_events.judge_claimed_at` 列及任何新增列，禁止 drop 既有上线数据表重建。

`push_records` 必须保留 `UNIQUE(target_type, target_id, channel, push_date)` 唯一约束。本期推送链路扩展为多通道与多 `target_type`，系统必须实际写入推送记录（先 `pending`、成功 `success`、失败 `failed`）。`target_type` 与 `channel` 的取值必须由程序集中定义的枚举（如 Zod enum）统一收口，禁止在各推送路径散落字面量——避免某处误拼（如 `'alerts'`、`'Event'`）使幂等四元组静默分裂成两个命名空间、绕过去重而漏推/重推（DB 裸 `varchar` 不挡拼写错）。**本期权威全集必须显式声明**：`target_type` 枚举 = `{event, product, alert, weekly}`、`channel` 枚举 = `{telegram, feishu}`；新增 `target_type`/`channel` 必须先扩此枚举再使用。该全集相对 QA.md §8.6 注释集 `event/product/paper/repo` 是**双向有意偏离**，两个方向都须自洽说明：① **收口**：`paper`/`repo` 不在 P2（arXiv 论文仅采集沉淀、不推送，见 source-collectors 与 proposal 非目标），留后续期；② **扩张**：`alert`/`weekly` 是 P2 相对 QA §8.6 注释的有意新增（QA §8.6 注释未列，但本期实时告警与周报两种推送节奏各需独立幂等命名空间，见 realtime-alerts / weekly-report）。此偏离不与 QA.md 的 DDL 冲突，因为 §8.6 的 `-- event/product/paper/repo` 是 **SQL 行内注释、非 `CHECK` 约束**（QA.md DDL 中 `target_type VARCHAR(32)` 无 CHECK），枚举集可由实现期收口/扩张而不破坏 DDL；CLAUDE.md 以 QA.md 为最高权威，此处对其注释集的偏离已显式登记为有意决策。

#### 场景:迁移落核心表与本期新增列
- **当** 对一个空数据库执行 `drizzle-kit migrate`
- **那么** 数据库中存在 `raw_items`、`ai_news_events`、`push_records` 三张表，且 `ai_news_events` 含 `dedup_key`（UNIQUE）、`representative_raw_item_id`、`published_at`、`judge_claimed_at`，`raw_items` 含 `title_hash`、`unprocessable`、`collapsed`

#### 场景:event_id 为不依赖内容的 surrogate key 且与 target_id 类型一致
- **当** 检视 `ai_news_events.event_id` 的列类型与默认值
- **那么** 其列类型为 `VARCHAR(128)`（与 `push_records.target_id` 一致）、默认值为 `gen_random_uuid()::text`，不由 `canonical_url` 等内容哈希派生

#### 场景:dedup_key 唯一约束就位
- **当** 检视 `ai_news_events` 表结构
- **那么** 存在 `UNIQUE(dedup_key)` 约束，可作为塌缩 `ON CONFLICT` 的冲突目标

#### 场景:迁移可重跑且幂等
- **当** 在已迁移的数据库上再次执行 `drizzle-kit migrate`
- **那么** 已应用的迁移被跳过、命令成功返回、表结构无变化、不报错

#### 场景:推送幂等唯一约束就位
- **当** 检视 `push_records` 表结构
- **那么** 存在 `UNIQUE(target_type, target_id, channel, push_date)` 约束

#### 场景:P3 起解禁知识库表 关系/顾问表仍禁止
- **当** 检视累计迁移（P2 + P3）
- **那么** 存在 `ai_products` / `kb_documents` / `kb_ingestion_records` 表，`ai_news_events` 含 `embedding` / `merged_into` 列，且不含 `item_event_relations` / `item_product_relations` / `ai_tools` / `task_patterns` 四张表

### 需求:ai_products 产品表可迁移

系统必须以 forward-only 迁移落 `ai_products` 表（QA.md §8.3），承载产品发现的确定性硬规则合并。表必须含：

- `product_id` 不透明 surrogate key（与 `event_id` 同口径，`VARCHAR(128)` + `gen_random_uuid()::text` 默认值，不由内容派生）；
- `name VARCHAR(255) NOT NULL`（QA.md §8.3 的唯一 NOT NULL 业务列，必须显式声明并在塌缩 INSERT 时填充，见 product-discovery「ai_products 硬规则产品合并」——漏填会使塌缩 INSERT 因 NOT NULL 约束直接失败）；
- 硬规则合并所需的唯一约束：`UNIQUE(canonical_domain)`、`UNIQUE(github_repo)`、`UNIQUE(product_hunt_slug)`（三者各自唯一，作为 `ON CONFLICT` 冲突目标）；
- last_seen 类可累加字段 `first_seen_at` / `last_seen_at` / `last_pushed_at`（可空）——**本期必建**（不属可延后的纯富化列）：硬合并塌缩的 `UPDATE` 分支累加/更新这些列，缺列则 UPDATE 无目标列、塌缩跑不通；
- `metadata JSONB`（QA.md §8.3 含此列）——**本期必建**：多键命中多行冲突态以 `metadata.merge_conflict` 标记落点（见 product-discovery「ai_products 硬规则产品合并」），缺列则冲突状态无持久落点、推送排除规则失去依据；
- `representative_raw_item_id BIGINT`（**独立列**，回指 `raw_items.id`、类型与 `ai_news_events.representative_raw_item_id` 一致）。**此列为 P2 新增过渡列，QA.md §8.3 DDL 未列**，用于在不建 `item_product_relations`（P3）的前提下保留 raw_item↔product 回指，P3 引入关系表后可迁移——spec 此处标注其为有意偏离 QA §8.3、非 DDL 不一致。

迁移必须 forward-only（追加新迁移序号、不重写既有迁移）且 `drizzle-kit migrate` 可重复执行幂等。`ai_products` 本身不建 vector 列（产品语义合并不在本期范围，仍用硬规则合并）；P3 的向量能力仅作用于 `ai_news_events` / `kb_documents`（见「P3 向量与知识库 Schema 可迁移」需求），不及于 `ai_products`。

#### 场景:迁移落 ai_products 表与合并唯一约束
- **当** 对已落 P1 schema 的数据库执行 P2 新增迁移
- **那么** 存在 `ai_products` 表，含 `product_id` surrogate key 及 `UNIQUE(canonical_domain)` / `UNIQUE(github_repo)` / `UNIQUE(product_hunt_slug)` 约束，可作为塌缩 `ON CONFLICT` 冲突目标

#### 场景:ai_products 迁移 forward-only 且幂等
- **当** 在已迁移数据库上再次执行 `drizzle-kit migrate`
- **那么** 既有迁移不被重写、新增迁移被跳过、表结构无变化、不报错

#### 场景:ai_products 不含向量列
- **当** 检视 `ai_products` 的迁移
- **那么** 不包含任何作用于 `ai_products` 的 vector 列（P3 向量能力仅及于 `ai_news_events` / `kb_documents`）
