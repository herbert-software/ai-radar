## 上下文

本变更是 ai-radar 的 P0 / Walking Skeleton——整条流水线（采集→去重→判断→摘要→推送）的第一根纵向桩。仓库当前只有文档（QA.md / config.yaml / ROADMAP.md / README.md），无任何代码。技术栈以 `config.yaml` 为准：TypeScript + Node + Hono + Drizzle + pgvector + Vercel AI SDK/Zod + BullMQ；不用 QA.md §16 的 Python/FastAPI/LangGraph/Alembic 默认（其目录结构仅作语义参考）。

约束：单人 + VibeCoding 节奏，大量代码由 AI 生成、不逐行 review，故 TS 静态类型 + Zod 校验 + CI 是免费的正确性防线，必须第 0 天就位。本期需在不交付业务能力的前提下证明所有承重点联通，并一并接入 GitHub Actions 与 Dependabot 以减少后续返工。

## 目标 / 非目标

**目标：**
- 单包 TS 脚手架可构建、可 typecheck、可跑 vitest。
- `docker compose up` 起 pg(pgvector 镜像) + redis 并健康。
- Drizzle 定义并迁移 `raw_items` / `ai_news_events` / `push_records` 三张表，可重跑幂等，`push_records` 唯一约束就位。
- `GET /health` 如实反映 db/redis 连通状态。
- Value Judge 雏形完成 seed→generateObject+Zod→落库 `ai_news_events`→读回 的完整往返，校验失败可观测。
- GitHub Actions CI（lint/typecheck/migrate smoke/vitest）+ Dependabot（npm + github-actions）就位。

**非目标：**
- 不交付业务能力：不采集真实源、不去重、不真推送、不入知识库、不做 MCP/选型顾问。
- 不把确定性状态（去重/幂等/唯一约束）交给 LLM。
- 不预设 P1 推送目标模型（`push_records.target` 指向 raw_item 还是 event 留给 P1）。
- 不启用 pgvector 向量检索；不定义其余 6 张表。

## 决策

**D1 — 单包而非 monorepo。** P0 只有一个可部署单元，monorepo（pnpm workspaces / turbo）的收益尚未出现。后续 MCP server（P4）若需独立部署再考虑拆包。代价：将来拆包有一次性成本，可接受。

**D2 — pgvector/pgvector 镜像但本期零向量。** ROADMAP 决策已定：镜像是地基，P3 上 embedding 时换镜像成本高，故 P0 即用 pgvector 镜像；但不建 vector 列、不 `CREATE EXTENSION vector`，避免引入未使用的 schema 复杂度。替代方案（官方 postgres，P3 再换）被否，因换镜像 + 数据迁移更烦。

**D3 — Drizzle schema 只声明 3 张表。** 全 9 表一次定义会过早写死 P1+ 才确定的字段（如 `ai_news_events` 的 `should_push` 与 P1 推送目标模型耦合）。只落本期 Value Judge 往返与幂等地基真正需要的表，其余随期追加 migration。`push_records` 虽本期不实跑，但唯一约束是"不可回退的地基"（ROADMAP 原则），故 schema 与约束先就位。

**D4 — Value Judge 做完整往返而非孤立 LLM demo。** 走 seed raw_item → generateObject+Zod → 写 `ai_news_events` 评分列 → 读回，比孤立 `/health/llm` 多证一件事：Agent 结构化输出能正确落库。这正是 P1 可复用的 Agent 骨架（schema 定义、调用封装、校验失败处理），雏形即生产骨架，减少 P1 返工。Zod schema 字段对齐 QA.md §10.4 Value Judge 输出 JSON（`is_ai_related` / `type` / `category` / `importance` / `novelty` / `developer_relevance` / `hype_risk` / `should_push` / `reason`）。

**关键映射陷阱**：§10.4 输出字段**无** `_score` 后缀，而 §8.2 `ai_news_events` 列**带** `_score` 后缀，二者不同名。落库前必须显式映射（`importance`→`importance_score` 等，`should_push` 同名直写），禁止假定同名直插——否则"读回一致"验收无法成立。映射表见 `specs/value-judge-agent/spec.md` 的"Agent 输出落库往返"需求。

**D5 — LLM provider 经 Vercel AI SDK 抽象，key 从 env 注入。** `.env.example` 列 provider key + model 名。CI 无密钥，故 migrate smoke 与 vitest 占位不依赖真实 LLM；真实往返在本地/带密钥环境手动验证（写入退出标准）。校验失败处理：generateObject 抛错 → 记录日志 → 有限重试 → 仍失败则降级（不写库），不静默吞掉。

**D6 — migrate smoke 在 CI 用临时 Postgres service。** GitHub Actions 用 `services: postgres`（pgvector 镜像）起临时库，跑 `drizzle-kit migrate` 验证可落表，再跑 vitest。lint 用 ESLint，typecheck 用 `tsc --noEmit`。

**D7 — Redis/BullMQ 本期仅验证连通。** 不注册任何 queue/worker，`/health` ping redis 即可。BullMQ 依赖先装好，P1 接每日任务时直接用。

## 风险 / 权衡

- [CI 无 LLM 密钥，真实往返不在 CI 覆盖] → 退出标准要求在带密钥环境手动验证一次往返；vitest 对 Value Judge 用 mock/stub 覆盖 schema 校验与落库逻辑，真实 LLM 调用不进 CI。
- [pgvector 镜像体积比官方 postgres 大、本期用不到向量] → 可接受，换镜像成本远高于镜像体积，且统一镜像避免环境漂移。
- [只落 3 表，P1 追加 migration 可能与既有表产生关系（如 item_event_relations 引用 raw_items/ai_news_events）] → 这是 Drizzle migration 的常规增量，FK 在 P1 提案中补；P0 三表的主键/唯一键已为被引用做好准备。
- [`push_records` 定义了但本期不写] → 刻意为之；唯一约束是地基，提前就位不增加风险，且让 P1 聚焦推送逻辑而非建表。
- [Value Judge schema 字段现在定下，P1 可能调整] → 雏形 schema 标注为可演进；字段已对齐 QA.md 权威定义，P1 调整属正常 spec 演进（走 MODIFIED）。

## 迁移计划

全新仓库，无存量数据与回滚需求。部署即"本地起 compose + migrate + 跑 app"。后续期次通过新增 Drizzle migration 文件增量演进 schema，不回改 P0 migration。

## 待解决问题

- LLM provider 具体选哪家（OpenAI / Anthropic / 其他）由 `.env` 配置，雏形对 provider 无硬编码偏好；默认示例可填一个，不阻塞 P0。
- ESLint 配置档位（flat config 规则集严格度）实现时按 TS 推荐起步，可在 P1 收紧。
