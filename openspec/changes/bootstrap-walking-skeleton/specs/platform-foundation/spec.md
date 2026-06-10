## 新增需求

### 需求:容器化基础设施可编排
系统必须提供一份 `docker-compose.yml`，通过单条 `docker compose up` 启动 PostgreSQL 与 Redis 两项基础设施。PostgreSQL 必须使用 `pgvector/pgvector` 镜像，以便后续期次引入向量检索时无需更换镜像；但本期禁止建立任何 vector 列、禁止启用 `vector` 扩展逻辑。Redis 必须可被应用连通（供后续 BullMQ 使用）。

#### 场景:一键启动基础设施
- **当** 在仓库根目录执行 `docker compose up`
- **那么** PostgreSQL 与 Redis 容器均成功启动并进入健康状态

#### 场景:PostgreSQL 使用 pgvector 镜像但不启用向量能力
- **当** 检视 `docker-compose.yml` 的 postgres 服务镜像与本期 migration
- **那么** 镜像为 `pgvector/pgvector`，且 migration 中不包含任何 vector 列或 `CREATE EXTENSION vector` 语句

### 需求:数据库 Schema 可迁移
系统必须用 Drizzle 定义并通过 `drizzle-kit migrate` 落库本期核心表 `raw_items`、`ai_news_events`、`push_records`，且仅这三张表。三张表的列必须对齐 QA.md §8.1 / §8.2 / §8.6 的 DDL（不得只建主键与唯一约束的空壳表），其中 `ai_news_events` 必须含 `importance_score` / `novelty_score` / `developer_relevance_score` / `hype_risk_score` / `should_push` 等列，`raw_items` 必须含 `UNIQUE(source, source_item_id)` 且包含 §8.1 全部列（`canonical_url` 等列本期建好但不生成其值，P1 去重直接复用、免再加 migration）。`drizzle-kit migrate` 必须可重复执行：已应用的迁移被跳过、命令成功返回、数据库结构无变化（迁移 journal 级幂等）。本期禁止定义其余六张表（`item_event_relations` / `item_product_relations` / `ai_products` / `kb_ingestion_records` / `ai_tools` / `task_patterns`），它们留待各自期次提案再加。

`push_records` 必须带 `UNIQUE(target_type, target_id, channel, push_date)` 唯一约束——推送幂等地基第 0 天就位；但本期禁止实际写入推送记录（不实跑推送）。

#### 场景:迁移落三张核心表
- **当** 对一个空数据库执行 `drizzle-kit migrate`
- **那么** 数据库中存在且仅存在 `raw_items`、`ai_news_events`、`push_records` 三张本期表

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
