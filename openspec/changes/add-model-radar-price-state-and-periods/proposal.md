## 为什么

当前 Model Radar 的价格策展是**手工 + 脆弱**：此前核价曾**拿错页**（录到 Token 套餐价而非 Coding Plan 价）；各家定价页链接会漂移、产品会停售或转需登录；且只记单一月付价，季/年付的「最佳周期」无法呈现，「已停售」与「待核价」在数据上也不可分（5e 已声明缺口）。目标是把它演进为「**自愈 + 多维价格情报**」——本期先打**数据模型地基**（后续三步：语义校验 Agent / 链接自愈 Web Search 环 / 多口径对比呈现，都依赖本期的字段）。

## 变更内容

- **availability 生命周期字段（全桶）**：`mr_plans` 加 `availability ∈ {on_sale, discontinued, unknown}`（产品生命周期），与 `source_confidence`（源可信度）和 `reviewStatus.pending`（待人核）三者正交、各管一维。推荐器可把 `availability=discontinued` 明确判为「已停售不荐」，而非笼统「待核」；`unknown` 不被当停售处理，避免迁移后误杀。
- **季/年付周期价表（订阅型桶）**：新 `mr_plan_prices` 只存**月之外**的周期价行 `{plan_id, billing_period ∈ {quarterly, annual}, price, currency, source_url, last_checked, source_confidence}`。`plan_id` 是裸 `varchar(128)` 引用（不建 FK，沿 `mr_*` 零-FK 红线）；`currency` **NOT NULL**，`price` 可 NULL（同一币种待核占位），`UNIQUE(plan_id, billing_period, currency)` 的所有组件均非 NULL，避免 PG `UNIQUE` 对 NULL distinct 放过重复。`mr_plans.current_price` 仍是唯一 canonical 月价 SOT，禁止在 `mr_plan_prices` 写 `monthly` 镜像行。
- **只读 DTO + 内容哈希一致**：只读快照 DTO 暴露 `availability` + `periodPrices`（季/年付，含 `priceStatus` 与 `effectiveMonthly`）。`effectiveMonthly = price ÷ {quarterly:3, annual:12}`；当 `priceStatus!='known'` 时必须为 `null`，禁止 `Number(null)` 变 0。凡 DTO 服务给客户端的字段都进入 canonical 内容哈希/ETag；这些字段**只是不进 cheapest/sort**，不允许 served-but-unhashed。
- **cheapest / 推荐器口径**：比价/排序仍以 canonical 月价 `current_price` 为准，且只在同桶同币种内比较；`availability=discontinued` 的 plan 可列出但不参与 cheapest、不成为推荐 `primary`。推荐文案可标「最佳周期」（月付 canonical 与已核季/年有效月价中最低者），但排名仍按月价。
- **授权写路径明确化（只立模型，不接自动 setter）**：`upsertPlan` 只在 INSERT 时写 `availability`；既有 plan 的 availability 差异走 guarded conflict + flag，不盲覆盖。新增人工/seed 授权写入口（例如 `setPlanAvailability`、`upsertPlanPeriodPrice`）显式更新 availability 与季/年付行，并在提交后触发快照 rebuild/invalidation。保鲜回路/抓取链仍只打待复核，不自动判停售、不自动改链接、不让 LLM 判价。

### 非目标

- **不接自动 setter 写路径**：自动判停售、链接漂移检测、Web Search 链接自愈、语义校验抽取 = 后续 followup；本期只提供 schema 与人工/seed 授权写入口。
- **不改 cheapest 月价口径**：比价/排序仍以 canonical 月价 `mr_plans.current_price` 为准；季/年付有效月价只作附加展示 + 最佳周期标注，不进 cheapest/sort，不冒充月价。
- **不做多口径对比页呈现**：比价页按 billing_period/category 分视图/打标 = 后续 followup；本期仅让字段经 DTO 可被消费。
- **Token Plan 不入月度比价**：Token Plan（按 token/credit 计、非按月订阅）继续按 token 单价或额度独立呈现，本期不为 `token_plan` 生成 `effectiveMonthly` 或最佳周期；季/年付表仅覆盖订阅型桶（`ide_membership` / `coding_plan` / `enterprise_seat`）。
- **不跨桶/跨币 FX**；价格值仍读为精确事实、LLM 不判价（LLM 只在后续 followup 做语义分类/找链接，不判价数字）。

## 功能 (Capabilities)

### 新增功能

（无——本期是跨既有能力的模型扩展，不引入独立新 capability。）

### 修改功能

- `model-radar-catalog`: `mr_plans.availability` + `mr_plan_prices` 季/年付价表（零 FK、非空唯一键组件、逐行 provenance）。
- `model-radar-ingestion`: 录入 schema 接受 `availability` 与季/年付写入；新增人工/seed 授权写入口；沿 confidence↔price 绑定红线；不接自动 setter。
- `model-radar-compare-api`: 快照 DTO 暴露 `availability` + 季/年付价；所有服务字段进内容哈希；cheapest 仍以月价且排除 discontinued。
- `model-radar-recommender`: verdict 用 `availability=discontinued` 给明确「停售」依据；推荐文案标该 plan 最佳周期。

## 影响

- **数据**：migration 加 `mr_plans.availability` 列（默认 `unknown`、向后兼容）+ `mr_plan_prices` 表（裸 `plan_id`、无 FK、`billing_period ∈ {quarterly,annual}`、`currency NOT NULL`、唯一键组件全非 NULL）；既有行不臆断在售，`current_price` 月价不动。
- **代码**：`src/db/mr-schema*`（schema+zod）、录入 `upsert*`/新增授权写入口、`src/mr/snapshot/{build,dto,query}`（读第 10 张表、DTO + hash + staleness）、`src/mr/recommend`（停售 verdict + 最佳周期）。
- **红线**：全桶 `mr_*` bounded domain；价格值=精确事实、LLM 不判价；DTO served 字段必须全部进 hash；availability/confidence/pending 三正交；季/年有效月价不进 cheapest/sort；本期不接自动 setter。
- **测试**：schema/migration 幂等 + 零 FK + 非空唯一键；多周期录入 + `effectiveMonthly=null` 防 phantom zero；DTO/hash 随 availability/period 变化而变；cheapest 排除 discontinued 且仍按月价；推荐器 `discontinued`→明确停售 + 最佳周期；既有未核/不跨币红线回归。
