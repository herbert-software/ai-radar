## MODIFIED Requirements

### 需求:目录作为隔离的 bounded domain

Model Radar 目录必须存放在自有的 `mr_*` 表中，与 `ai_products` 及新闻/去重/推送/KB 管线 schema 完全隔离。迁移禁止改动任何既有表结构。引用列沿用全仓零-FK 惯例（裸 id，不 `references()`）。**孤儿引用（指向不存在行）由 DB 放行——这是零-FK 取舍，不是漏测；引用完整性是录入事务契约与快照 fail-closed，非 DB 保证。**新增 `mr_plan_prices.plan_id` 也必须是裸 `varchar(128)` 引用，**不得**建 DB FOREIGN KEY。

#### 场景:迁移落表不触碰既有表
- **当** 应用 Model Radar 价格状态与周期价迁移
- **那么** 只新增/修改 `mr_*` 表，且 `raw_items`、`ai_news_events`、`ai_products`、`push_records` 等既有表结构保持不变

#### 场景:无外键（零-FK 断言）
- **当** 检查 `mr_*` 表的外键约束
- **那么** 不存在任何 `references()`/FOREIGN KEY，包括 `mr_plan_prices.plan_id`；引用完整性显式属录入层

### 需求:每条断言事实带 provenance（逐表）

承载断言事实的表（`mr_plans`、`mr_plan_limits`、`mr_plan_clients`、`mr_plan_models`、`mr_plan_prices`）必须各自携带 `source_url text NOT NULL`、`last_checked timestamptz NOT NULL`、`source_confidence text NOT NULL`。**仅 `source_confidence` 是枚举** ∈ {official_pricing, official_doc, official_community, media_report, needs_login_recheck}，由应用层 Zod 校验（DB 不建 CHECK/pg-enum）；`source_url`/`last_checked` 是普通 text/timestamptz 非枚举。`mr_plans` 表达 canonical 月价事实；登录墙或待复核导致月价缺值时，`current_price` 与 `currency` 必须同为 NULL、provenance 三字段仍齐备、且不写 `mr_price_history`（无确值不追历史）。`mr_plan_prices` 表达季/年付价格事实，按行拥有独立 provenance；`mr_price_history` 继续按既有例外使用 `source_url`/`source_confidence`/`changed_at`，`changed_at` 兼任记录/核对时间。身份行 `mr_vendors`/`mr_models` 与定位边 `mr_source`/`mr_plan_sources` 不挂 provenance（实体存在性/边，非定价或兼容断言；时效由拥有它的兼容/价格行承载）。

#### 场景:needs_login_recheck 月价缺值可表达
- **当** 录入一条登录墙后的事实（如火山续费价，`source_confidence=needs_login_recheck`、月价缺）
- **那么** `mr_plans.current_price` 与 `currency` 同为 NULL（占位、同生同灭），provenance 三字段齐备，**不写** `mr_price_history` 行（`new_value` NOT NULL，无确值不追历史）；该记录可无损录入读回

#### 场景:周期价行自带 provenance
- **当** 某 plan 录入年付价
- **那么** `mr_plan_prices` 该行可读回自己的 `source_url`、`last_checked`、`source_confidence`，不继承或复用 plan 月价 provenance

#### 场景:needs_login_recheck 周期价缺值可表达
- **当** 已知某 plan 有 CNY 年付周期但价格需登录复核
- **那么** 可写 `billing_period='annual'`、`currency='CNY'`、`price=NULL`、`source_confidence='needs_login_recheck'` 的周期价占位；该行不冒充已核价

### 需求:唯一约束逐一列举且迁移幂等由 DB/CI 保障

所有 `mr_*` 表唯一键必须逐一列举落地（`mr_vendors UNIQUE(normalized_name)`、`mr_plans UNIQUE(vendor_id,name)`、`mr_models` 三列、各 junction 键、`mr_plan_limits` 三元、`mr_price_history UNIQUE(plan_id,changed_at)`、`mr_source UNIQUE(vendor_id,source_url)`、`mr_plan_sources`、`mr_review_flag UNIQUE(target_type,target_id)`、`mr_catalog_version UNIQUE(version)`，以及新增 `mr_plan_prices UNIQUE(plan_id,billing_period,currency)`），必须全部用**命名表级** `unique('<name>').on(...)` 约束（对齐本仓 `push_records`/`ai_products` 命名约束形式，非列级 `.unique()` 链；禁用 partial index），由 DB 保障不交 LLM。**每个唯一键组件列必须 `.notNull()`**（PG `UNIQUE` 对 NULL distinct，组件可空会让去重键静默失效）；因此 `mr_plan_prices.currency` 必须 NOT NULL，不能用 `currency=NULL` 加唯一键表达未知币种。币种未知的周期价不写占位行，待复核后补。`mr_plans.name` 必须作为真实列 `name text NOT NULL` 建。**`name` 录入约定 = 套餐全名（含产品上下文，如 `Coding Plan Pro`、`Qoder Pro`），非裸档位（`Pro`）**——故 `UNIQUE(vendor_id, name)` 不含 `category` 仍正确：同厂跨桶套餐全名天然不同，且该键能挡住同厂同名误录重复；裸档位录入会让跨桶同档位误撞，属录入契约须避免。PK 一律 `id varchar(128) DEFAULT gen_random_uuid()::text`，`mr_review_flag.target_id` 同型以多态引身份表 PK。迁移幂等沿用既有范式：`npm run migrate` 二跑 journal no-op（命令级），**幂等不在 test 内重跑迁移**；结构（表/列/唯一约束/`is_nullable`）经 `information_schema` 断言；行为/往返测试（唯一键拒绝、upsert、fixture 录入读回）**写隔离数据并清理**——「只做只读断言」仅指迁移幂等那一项，不限制行为测试写库。

#### 场景:重复周期价唯一键由 DB 拒绝
- **当** 对同一 plan 重复插入两条 `{billing_period='annual', currency='CNY'}`
- **那么** `UNIQUE(plan_id,billing_period,currency)` 拒绝第二条；不会因 NULL currency distinct 放过重复

#### 场景:唯一键组件非 NULL
- **当** 检查 `mr_plan_prices` 的唯一键组件列
- **那么** `plan_id`、`billing_period`、`currency` 均为 NOT NULL；`price` 可 NULL 但不参与唯一键

#### 场景:迁移命令二跑幂等
- **当** 对同一库连续 `npm run migrate` 两次
- **那么** 第二次 journal 无新增已应用条目、目标表结构 `information_schema` 快照一致、退出码 0

#### 场景:重复唯一键由 DB 约束兜底
- **当** 重复插入任一 `mr_*` 表的唯一键
- **那么** 由 DB 唯一约束（`table_constraints` 可见）拒绝或塌缩，而非依赖 LLM

## ADDED Requirements

### 需求:套餐携带产品可用性生命周期（availability），与源可信度/待核三正交

`mr_plans` 必须携带 `availability ∈ {on_sale, discontinued, unknown}`（产品生命周期），默认 `unknown`。`availability`（在售/停售/未知）、`source_confidence`（源可信度）、`reviewStatus.pending`（待人核）三者正交、各管一维，禁止互相派生或混为一字段：某 plan 可同时 `availability:on_sale` + `confidence:needs_login_recheck`（需登录但在售），或 `availability:discontinued` + `pending:true`（停售且待核）。`availability='discontinued'` 是明确不可订，供 compare-api/recommender 排除 cheapest/primary；`availability='unknown'` 不得被当作停售误杀。

#### 场景:三正交不互相派生
- **当** 某 plan 需登录才可见定价但仍在售（如讯飞），另一 plan 已停售（如腾讯）
- **那么** 前者 `availability='on_sale'` 且 `source_confidence='needs_login_recheck'`；后者 `availability='discontinued'`，不靠 `confidence`/`pending` 暗示停售

#### 场景:既有行迁移默认 unknown 不臆断在售
- **当** migration 给既有 `mr_plans` 行补 `availability`
- **那么** 默认 `unknown`（不据 confidence/价格臆断为 `on_sale`）；`on_sale`/`discontinued` 须经显式核实录入才置

### 需求:季/年付周期价以带周期价行表达、月价为 canonical、有效月价为确定性折算

订阅型套餐（`ide_membership` / `coding_plan` / `enterprise_seat`）必须支持月之外的计费周期：月价仍以 `mr_plans.current_price`（canonical 月价 SOT）表达；季/年付价以 `mr_plan_prices` 行 `{plan_id, billing_period ∈ {quarterly, annual}, price, currency NOT NULL, source_url, last_checked, source_confidence}` 表达。禁止 `billing_period='monthly'` 行，避免与 `current_price` 形成双 SOT。周期价 `known` 当且仅当 `price` 非 NULL 且 `source_confidence ∈ {official_pricing, official_doc}`；未核行 `price=NULL` 且 `effectiveMonthly=NULL`，不得把 NULL 当 0。`effectiveMonthly = price ÷ {quarterly:3, annual:12}` 是确定性折算，仅作附加展示 + 最佳周期标注，透明标「含预付/锁期」，不进 cheapest/sort，但作为 DTO 服务字段必须进内容哈希。

#### 场景:多周期价各自 provenance + 有效月价确定性折算
- **当** 某 plan 录入月付 ¥49（走 `current_price`）、年付 ¥468（走 `mr_plan_prices`，billing_period='annual'，带 source_url/last_checked/confidence）
- **那么** 年付有效月价 = 468÷12 = ¥39，标「年付有效月价 ¥39（含预付锁 12 月）」；¥39 不进 cheapest/sort、不冒充月价，但 DTO 返回该字段时进入内容哈希

#### 场景:周期价逐行守 confidence↔price 绑定
- **当** 某 CNY 年付周期价未核
- **那么** 该 `mr_plan_prices` 行 `price=NULL`、`currency='CNY'`、`priceStatus='unknown'`、`effectiveMonthly=NULL`；已核周期价必带 price 非 NULL + 官方 confidence

#### 场景:禁止月镜像行与 Token Plan 月化泄漏
- **当** 写入 `mr_plan_prices.billing_period='monthly'`，或尝试为 `token_plan` 生成有效月价/最佳周期
- **那么** 应用层 Zod/录入守卫拒绝或忽略该路径；Token Plan 不被折算成月度订阅价参与展示
