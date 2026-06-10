## 为什么

ai-radar 的第一架构原则是"确定性工作流 + 数据库状态 + Agent 语义判断 + RAG 证据检索"，整条流水线（采集→去重→判断→摘要→推送）的每个环节都挂在同一组承重点上：容器化基础设施、可迁移的数据库 schema、结构化且经校验的 Agent 输出、能拦住 VibeCoding 高频错误的 CI。

在写任何业务能力（P1 起）之前，必须先用一根最细的纵向桩证明这些承重点真的通——这就是 P0 / Walking Skeleton。它不交付业务价值，只把地基浇好，让后续各期"挂得上去、且少返工"。本期把 CI 与依赖自动更新一并接入，正是为减少后续返工。

## 变更内容

- **新建 TypeScript 单包脚手架**：Node + Hono + Drizzle + Vercel AI SDK/Zod + BullMQ（技术栈以 `config.yaml` 为准，不用 Python/FastAPI/LangGraph/Alembic）。
- **docker-compose 基础设施**：postgres（用 `pgvector/pgvector` 镜像，P0 不建 vector 列、不启用扩展逻辑，仅镜像就位以降低 P3 迁移成本）+ redis（BullMQ 用，P0 仅验证连通）。
- **Drizzle schema + migration，仅落 P1 会用到的 3 张核心表**：`raw_items`、`ai_news_events`、`push_records`。`push_records` 带 `UNIQUE(target_type, target_id, channel, push_date)`——幂等地基第 0 天就位，但 P0 不实跑推送。其余 6 张表（`item_event_relations` / `item_product_relations` / `ai_products` / `kb_ingestion_records` / `ai_tools` / `task_patterns`）全部 deferred，随各自期提案再加 migration。
- **健康检查端点**：`GET /health` 返回 `{ db, redis }` 连通状态。
- **Value Judge Agent 雏形**（P1 可复用的 Agent 骨架）：seed 一条假 `raw_item` → `generateObject` + Zod schema → 校验通过后写入 `ai_news_events` 评分列 → 能读回，证明 Agent 结构化输出能正确落库；Zod 校验失败可观测（重试/降级而非吞掉）。
- **GitHub Actions CI**：lint + typecheck + `drizzle-kit migrate` smoke + vitest 占位（P1 起填 `pushIdempotency` / `dedup` / URL 归一 三个不变量测试）。
- **Dependabot**：覆盖 `npm` 与 `github-actions` 两个 ecosystem。
- **`.env.example`**：`DATABASE_URL` / `REDIS_URL` / LLM provider API key / model 名。

## 功能 (Capabilities)

### 新增功能
- `platform-foundation`: 容器化基础设施可编排（pg+redis）、Drizzle schema 可迁移（3 张核心表、可重跑幂等、`push_records` 唯一约束就位）、`GET /health` 健康检查。
- `value-judge-agent`: 对一条原始信息做结构化价值判断的 Agent 雏形——`generateObject` + Zod schema 校验 + 落库 `ai_news_events`，确立"Agent 输出必为结构化 JSON 并校验"的可复用契约（P1 将在此能力上扩展真实判断逻辑）。
- `ci-and-dependencies`: GitHub Actions CI 守正确性（lint/typecheck/migrate smoke/vitest 必须全绿）+ Dependabot 自动更新依赖（npm + github-actions）。

### 修改功能
<!-- 无现有规范，留空。 -->

## 影响

- **新增代码/目录**：TS 单包源码（Hono app、Drizzle schema/migrations、Value Judge 雏形、Zod schemas）、`docker-compose.yml`、`.env.example`、`.github/workflows/ci.yml`、`.github/dependabot.yml`、`drizzle.config.ts`、`vitest` 配置。
- **新增依赖**：hono、drizzle-orm、drizzle-kit、pg、ai（Vercel AI SDK）、zod、bullmq、ioredis、vitest、tsx、typescript、eslint（具体版本在 design.md 锁定）。
- **外部前提**：需要一个可用的 LLM provider API key 才能跑通 Value Judge 往返（CI 中该步可跳过或用占位，真实往返在本地/带密钥环境验证）。
- **非目标（明确不做）**：
  - 不交付任何业务能力——不采集真实源、不做去重（含 URL 规范化 / `title_hash` / canonical_url 生成均为 P1）、不真推送、不入知识库、不做 MCP/选型顾问。
  - **不把确定性状态（去重/幂等/唯一约束）交给 LLM**——这些由程序与 DB 唯一索引保障（第一架构原则不可违背）。
  - 不预设 P1 的推送目标模型——`push_records.target_type/target_id` 指向 `raw_item` 还是 `event` 是 P1 设计悬案，P0 只把表与唯一约束摆好、不实跑推送。
  - 不启用 pgvector 向量检索（embedding 去重是 P3）。
  - 不一次性定义全部 9 张表，避免过早写死后期细节。
