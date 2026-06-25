## 为什么

Model Radar（P5）要做 AI 编程订阅 / Coding Plan / Token 包的**比价 + 选型**，而本仓现有数据模型撑不起它：`ai_products` 承载的是新闻管线发现的**非结构化产品**（仅 `name` + 三个硬合并冲突键 `canonical_domain`/`github_repo`/`product_hunt_slug` + 去重/合并/推送语义；`vendor` 列尚不存在，仅注释保留待 P6 富化），其领域语义（去重/合并/last_seen）与 Model Radar 的**精确关系事实**（套餐/模型兼容矩阵/价格历史/异构额度）正交——故另起 `mr_*` 域而非扩 `ai_products`。本变更（5a）只做**地基**——Model Radar 作为同仓 bounded domain 的结构化关系模型 + provenance，是 5b（抓取/录入/保鲜）、5c（快照/比价 API）、5d（比价页）、5e（选型推荐器）一切的前置闸门。先把表建对，后面才不返工。

权威背景见 `ROADMAP.md`「P5 Model Radar 步骤拆解」、`CLAUDE.md`「Model Radar（P5）专属约束」、`docs/model-radar-tech-plan.md`（含已锁决策与 v1/v2 切分）。

## 变更内容

- 新增一组 `mr_*` Drizzle 表（`src/db/schema.ts` 追加 + 新 forward-only 迁移），作为 Model Radar 的事实 SOT，**与 `ai_products` / 新闻管线 schema 完全隔离**：
  - `mr_vendors`：厂商。
  - `mr_plans`：套餐，带 `category` facet（4 slug `{ide_membership, coding_plan, token_plan, enterprise_seat}`，对应 IDE会员/Coding Plan/Token Plan/企业席位）。
  - `mr_models`：模型，**带版本**（GLM-5.2 ≠ GLM-4.7）。
  - `mr_plan_models`：套餐 ↔ 模型 兼容矩阵（junction）。
  - `mr_plan_clients`：套餐 ↔ 工具/协议 兼容（junction：Claude Code/Cursor/Cline/OpenClaw/Codex… + OpenAI/Anthropic 协议）。
  - `mr_plan_limits`：**带类型限额行** `{limit_type, value, window}`（如 `monthly_tokens` / `rolling_5h_requests` / `weekly_messages` / `none`）——**绝不**建单个 `quota INT`。
  - `mr_price_history`：价格变更时序（从第 0 天就记，即便 v1 不画图；漏记则 v2 无米下锅）。
  - `mr_source`：每源带 `fetch_strategy` ∈ {http, browser, manual} + `content_fingerprint`（供 5b 变更检测）。
  - `mr_review_flag`：待复核标（供 5b 抓取变更检测与 ai-radar 事件流写）。
  - `mr_catalog_version`：快照重建版本号（供 5c）。
- **provenance** 挂在**每张承载断言事实的表**上：`mr_plans` / `mr_plan_limits` / `mr_plan_clients` / `mr_plan_models` 各带三字段 `source_url`/`last_checked`/`source_confidence`；`mr_price_history` 例外，只带 `source_url`/`source_confidence`/`changed_at`（`changed_at` 兼任 last_checked，不可变历史行不重核）。身份行 `mr_vendors`/`mr_models` 与定位边 `mr_source`/`mr_plan_sources` 有意不挂 provenance。`mr_plans` 级 provenance 覆盖该行**价格事实**；`category`/`name` 是策展内部分类，不单独溯源。列类型：`source_url text NOT NULL`、`last_checked timestamptz NOT NULL`、`source_confidence text NOT NULL`——**仅 `source_confidence` 是枚举** ∈ {official_pricing, official_doc, official_community, media_report, needs_login_recheck}，由应用层 Zod 校验（对齐全仓零 DB-CHECK/零 pg-enum 惯例）。
- 引用列**沿用全仓零-FK 惯例**（裸 id，不 `references()`；引用完整性由 5b 录入事务保证）。
- 每张表带 `created_at`（承载可变事实的 `mr_plans`/`mr_plan_limits` 另带 `updated_at`），均 `NOT NULL DEFAULT now()`——**较既有审计列收紧**（基线 `created_at`/`updated_at` 为 `defaultNow()` 可空；新表无 legacy 回填问题，有 default 故 insert 永不失败），不声称与既有列逐字一致。
- **逐一列举的唯一约束** + 迁移幂等（沿用既有范式：CI/本地 `npm run migrate` 二跑 journal no-op，幂等不在 test 内重跑；结构断言走 `information_schema` 只读，行为/往返测试写隔离数据并清理）。
- 把已核样例厂商数据固化为带 provenance 的 checked-in seed fixture，作为样例往返的可审计真值基线。

## 功能 (Capabilities)

### 新增功能
- `model-radar-catalog`: Model Radar 结构化目录的数据模型——厂商/套餐/模型/兼容矩阵/带类型限额/价格历史/来源与待复核状态；**断言事实表逐表带 provenance，身份行/定位边/复核状态按设计豁免**；分桶为 facet（同桶内比、检索跨桶）；事实与状态由程序和 DB 保障，不交 LLM。

### 修改功能
<!-- 无：bounded domain，不改动现有任何 capability 的需求或 schema。 -->

## 影响

- **代码**：`src/db/schema.ts` 追加 `mr_*` 表；新增一支 forward-only 迁移；新增针对该迁移的不变量测试（落表 + 唯一约束 + 既有表结构未变 + 一家样例厂商完整录入读回）；新增 checked-in seed fixture（带 provenance 的样例厂商核对数据）。
- **依赖 / 中间件**：无新增（纯 Drizzle + PostgreSQL）。
- **现有系统**：零侵入——不触碰 `ai_products`、新闻/去重/推送/KB/MCP 任何表或链路。

## 非目标

- **不做** 抓取 / Playwright / 录入后台 / 比价页 / 推荐器（分属 5b–5e）；本变更只建表与迁移。
- **不把** 价格 / 兼容 / 额度等精确事实交给 LLM 判定——这些是确定性状态，由结构化录入 + DB 唯一约束保障；LLM 在后续步骤只做解释。
- **不复用 / 不污染** `ai_products` 与新闻管线 schema（bounded domain 隔离）。
- **不把** 四个桶并成一个总榜——`category` 是 facet 字段，同桶内归一化比较、检索横切所有桶。
- **不在** 读路径放 DB / join（那是 5c 快照的职责）；5a 只建写侧 SOT 表。
- **不建** 单个 `quota INT` 表达额度——各家口径异构，必须走带类型限额行。
