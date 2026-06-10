## 1. 脚手架与依赖

- [x] 1.1 初始化单包 TS 项目：`package.json`、`tsconfig.json`（strict）、`.gitignore`、目录骨架（`src/`），`tsc --noEmit` 通过
- [x] 1.2 安装运行依赖：hono、drizzle-orm、pg、ai（Vercel AI SDK）、zod、bullmq、ioredis
- [x] 1.3 安装开发依赖与脚本：typescript、tsx、drizzle-kit、vitest、eslint（flat config）；在 `package.json` 加 `lint`/`typecheck`/`test`/`migrate`/`dev` 脚本
- [x] 1.4 编写 `.env.example`：`DATABASE_URL`、`REDIS_URL`、LLM provider API key、model 名；实现 env 加载与缺失校验（缺关键变量启动即报错，非静默）

## 2. 基础设施编排

- [x] 2.1 编写 `docker-compose.yml`：postgres 用 `pgvector/pgvector` 镜像 + redis；配 healthcheck 与端口/卷
- [x] 2.2 本地验证 `docker compose up` 起得来且 pg+redis 进入健康状态（写入验证记录到 PR 描述）
- [x] 2.3 确认本期 compose 与 migration 均不建 vector 列、不 `CREATE EXTENSION vector`（pgvector 镜像就位但零向量）

## 3. 数据库 Schema 与迁移

- [x] 3.1 用 Drizzle 定义 `raw_items` 表（对齐 QA.md §8.1，含 `UNIQUE(source, source_item_id)`）
- [x] 3.2 用 Drizzle 定义 `ai_news_events` 表（对齐 QA.md §8.2，含 importance/novelty/developer_relevance/hype_risk 评分列与 should_push）
- [x] 3.3 用 Drizzle 定义 `push_records` 表（对齐 QA.md §8.6），**必须含 `UNIQUE(target_type, target_id, channel, push_date)`**
- [x] 3.4 配置 `drizzle.config.ts` 并生成 migration；确认仅生成这 3 张表、无其余 6 表
- [x] 3.5 对空库执行 `drizzle-kit migrate`，验证落 3 张表；**再次执行验证幂等（可重跑不报错、不重复建对象）**
- [x] 3.6 写一条断言验证 `push_records` 唯一约束已存在（查 information_schema 或迁移后 introspect）

## 4. 健康检查端点

- [x] 4.1 搭建 Hono app 入口与启动（`src/app.ts` / `src/index.ts`）
- [x] 4.2 实现 db 连通探测（执行一次轻量查询）与 redis 连通探测（ping）
- [x] 4.3 实现 `GET /health` 返回 `{ db, redis }` 状态；任一依赖不可达时如实反映为不健康（非静默成功）
- [x] 4.4 vitest：`/health` 在依赖可达返回 ok；mock redis 不可达时 `redis` 反映不健康

## 5. Value Judge Agent 雏形

- [x] 5.1 用 Zod 定义 Value Judge 输出 schema，字段对齐 QA.md §10.4 输出 JSON：`is_ai_related` / `type` / `category` / `importance` / `novelty` / `developer_relevance` / `hype_risk` / `should_push` / `reason`
- [x] 5.2 封装 Vercel AI SDK `generateObject` 调用（provider/model 从 env），返回经 Zod 校验的对象——作为 P1 可复用的 Agent 骨架
- [x] 5.3 实现校验失败处理：记录错误日志 + 有限重试，仍失败则降级（不写库），**禁止静默吞掉**
- [x] 5.4 实现 seed 一条假 `raw_item` 入库，跑 Value Judge，**按字段名映射**（`importance`→`importance_score` / `novelty`→`novelty_score` / `developer_relevance`→`developer_relevance_score` / `hype_risk`→`hype_risk_score` / `should_push` 同名）写入 `ai_news_events`，再读回校验各 `*_score` 列与 Agent 输出对应字段一致（完整往返）
- [x] 5.5 vitest（mock LLM，不依赖真实 key）：覆盖 schema 校验通过路径 + 字段名映射正确 + 校验失败时不写入 `ai_news_events`；读回比对按**数值相等**（`ai_news_events.*_score` 为 `NUMERIC(5,2)`，driver 可能返回 `82.00`/字符串，禁用字面严格相等以免假阴性）
- [ ] 5.6 在带真实 LLM 密钥的环境手动跑通一次真实往返，**留可审计证据**：将落库的 `ai_news_events` 行 dump（或结构化日志）作为 artifact 附 PR，而非仅自由文本描述

## 6. CI 与依赖自动更新

- [x] 6.1 编写 `.github/workflows/ci.yml`：lint + `tsc --noEmit` typecheck，触发于 push 与 pull request
- [x] 6.2 在 CI 加 postgres service（pgvector 镜像）并跑 `drizzle-kit migrate` smoke 验证可落表
- [x] 6.3 在 CI 跑 vitest（本期占位/已有用例）；任一步失败 CI 必须红灯
- [x] 6.4 编写 `.github/dependabot.yml`，覆盖 `npm` 与 `github-actions` 两个 ecosystem
- [ ] 6.5 推一个分支触发 Actions，确认全绿；确认 Dependabot 已激活

## 7. 收尾与退出标准核对

- [x] 7.1 编写/更新 `README.md` 的本地起步说明（compose up → migrate → dev → /health → Value Judge 往返）
- [x] 7.2 逐条核对 P0 退出标准（全集）：compose 健康 / migrate 落 3 表且幂等 / `push_records` 唯一约束就位 / `/health` 通过 / Zod 校验失败可观测 / 一次真实 generateObject+Zod 往返按映射落库读回 / Actions 全绿 / Dependabot 激活
