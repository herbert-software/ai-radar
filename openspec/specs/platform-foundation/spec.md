# platform-foundation 规范

## 目的
待定 - 由归档变更 bootstrap-walking-skeleton 创建。归档后请更新目的。
## 需求
### 需求:容器化基础设施可编排
系统必须提供一份 `docker-compose.yml`，通过单条 `docker compose up` 启动 PostgreSQL 与 Redis 两项基础设施。PostgreSQL 必须使用 `pgvector/pgvector` 镜像，以便后续期次引入向量检索时无需更换镜像；但本期禁止建立任何 vector 列、禁止启用 `vector` 扩展逻辑。Redis 必须可被应用连通（供后续 BullMQ 使用）。

#### 场景:一键启动基础设施
- **当** 在仓库根目录执行 `docker compose up`
- **那么** PostgreSQL 与 Redis 容器均成功启动并进入健康状态

#### 场景:PostgreSQL 使用 pgvector 镜像但不启用向量能力
- **当** 检视 `docker-compose.yml` 的 postgres 服务镜像与本期 migration
- **那么** 镜像为 `pgvector/pgvector`，且 migration 中不包含任何 vector 列或 `CREATE EXTENSION vector` 语句

### 需求:数据库 Schema 可迁移

系统必须用 Drizzle 定义并通过 `drizzle-kit migrate` 落库核心表 `raw_items`、`ai_news_events`、`push_records`。三张表的列必须对齐 QA.md §8.1 / §8.2 / §8.6 的 DDL（不得只建主键与唯一约束的空壳表）。`drizzle-kit migrate` 必须可重复执行：已应用的迁移被跳过、命令成功返回、数据库结构无变化（迁移 journal 级幂等）。本期（P1）仍禁止定义 `item_event_relations` / `item_product_relations` / `ai_products` / `kb_ingestion_records` / `ai_tools` / `task_patterns` 这六张表（P1 用 1:1 模型，关系表留待 P3 语义合并时提案再加）。

本期相对 P0 的 schema 演进必须包含：

- `ai_news_events.event_id` 必须为不透明 surrogate key，其值不得由内容（如 `canonical_url` 哈希）派生——以保证 P3 语义合并时事件身份稳定、历史引用（`push_records.target_id` 等）不需迁移。为与 `push_records.target_id`（`VARCHAR(128)`）保持类型一致以便 `target_id=event_id` 互引，`event_id` 必须保留 `VARCHAR(128)` 列类型，并设数据库默认值 `gen_random_uuid()::text`——使塌缩 `INSERT` 省略 `event_id` 时由数据库生成 UUID 文本，禁止由应用层用内容派生值填充。
- `ai_news_events` 必须新增 `dedup_key` 列并建 `UNIQUE(dedup_key)`，作为硬去重塌缩的冲突键（`INSERT ... ON CONFLICT (dedup_key) DO UPDATE`）。
- `ai_news_events` 必须新增 `representative_raw_item_id` 列，记录塌缩时第一条命中的 `raw_item` 主键。
- `ai_news_events` 必须新增 `published_at` 列（可空），承载代表 `raw_item` 的发布时间，供 Top N 排序 tiebreaker 使用——`ai_news_events` 此前无 `published_at` 列（仅 `first_seen_at` / `last_seen_at`），不补则排序字段不存在。
- `raw_items` 必须新增 `title_hash` 列，承载标题归一化哈希。
- `raw_items` 必须新增 `unprocessable` 标记列（`BOOLEAN NOT NULL DEFAULT false`），承载「既无可用 `canonical_url` 又归一后标题为空」的兜底状态——P0 `raw_items` 无任何状态列，不补则该兜底需求无落点。
- `raw_items.canonical_url` 由 P0 的「建好但不生成其值」转为本期必须真正生成并写入（采集/规范化阶段填值）。
- `ai_news_events` 必须保留 P0 的 `importance_score` / `novelty_score` / `developer_relevance_score` / `hype_risk_score` / `should_push` / `summary_zh` / `first_seen_at` / `last_seen_at` / `source_count` 等列；`raw_items` 必须保留 `UNIQUE(source, source_item_id)`。

迁移对既有数据的处理：因 P0 库内仅含 seed 数据，本期迁移必须采取 drop 并按新定义重建（而非对既有 `seed-<id>` 行顺序 ALTER），以免遗留不符 surrogate 约定的脏 `event_id` 行。

`push_records` 必须保留 `UNIQUE(target_type, target_id, channel, push_date)` 唯一约束。与 P0 不同，本期推送链路上线，系统必须实际写入推送记录（先 `pending`、成功 `success`、失败 `failed`），不再禁止写入。

#### 场景:迁移落核心表与本期新增列
- **当** 对一个空数据库执行 `drizzle-kit migrate`
- **那么** 数据库中存在 `raw_items`、`ai_news_events`、`push_records` 三张表，且 `ai_news_events` 含 `dedup_key`（UNIQUE）、`representative_raw_item_id`、`published_at`，`raw_items` 含 `title_hash`、`unprocessable`

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

### 需求:健康检查端点
系统必须提供 Hono 应用并暴露 `GET /health` 端点，返回数据库与 Redis 的连通状态。当任一依赖不可达时，端点必须以可观测的方式反映该依赖为不健康（非静默成功）。

#### 场景:依赖健康时返回 ok
- **当** PostgreSQL 与 Redis 均可达，客户端请求 `GET /health`
- **那么** 响应体反映 `db` 与 `redis` 均为连通状态

#### 场景:依赖不可达时如实反映
- **当** Redis 不可达，客户端请求 `GET /health`
- **那么** 响应明确反映 `redis` 为不健康，而非返回全部正常

### 需求:环境配置校验
系统必须提供 `.env.example` 列出运行所需环境变量（`DATABASE_URL`、`REDIS_URL`、LLM provider API key、model 名）。应用启动时必须校验关键环境变量存在，缺失时以可观测的方式快速失败（启动即报错），禁止静默使用空值或默认值继续运行。

#### 场景:缺关键变量时启动即报错
- **当** 缺少 `DATABASE_URL` 等关键环境变量并尝试启动应用
- **那么** 应用以明确错误信息退出，而非静默启动或用空值连接

### 需求:ai_news_events 承载日报一句话要点列

系统必须为 `ai_news_events` 提供 `headline_zh` 列（`text`，可空），承载中文摘要 Agent 产出的「一句话要点」，供 Telegram 日报渲染。该列由一次 forward-only 迁移 `ALTER TABLE ai_news_events ADD COLUMN headline_zh text` 添加（取当前下一个未用迁移序号 `0003`，不重写既有 0000/0001/0002）；`drizzle-kit migrate` 必须可重复执行幂等（journal 追加一条 entry、重跑跳过、结构无变化）。该列可空使旧事件（迁移前已落库、无要点）保持 `NULL`，由日报渲染层按固定顺序回退（`summary_zh` 截断 → `representative_title` → 仅标题），不阻塞。

> 本需求把 `headline_zh` 这一新增 schema 列归入 platform-foundation（schema 的单一事实来源），使「中文摘要 Agent 写 `ai_news_events.headline_zh`」与「schema 声明该列」一致，不产生"消费方要求某列但 schema 不声明"的断裂。

#### 场景:迁移添加 headline_zh 列且幂等
- **当** 对已落 P1 schema 的数据库执行新增迁移 `0003`，再次执行 `drizzle-kit migrate`
- **那么** `ai_news_events` 含可空 `headline_zh text` 列；第二次 migrate 被跳过、结构无变化、不报错

#### 场景:旧事件 headline_zh 为 NULL 不阻塞
- **当** 迁移前已存在的事件（`headline_zh` 为 NULL）进入当日 Top N
- **那么** 日报渲染按回退顺序取 `summary_zh` 截断/`representative_title`，不因 `headline_zh` 为 NULL 报错或漏推

