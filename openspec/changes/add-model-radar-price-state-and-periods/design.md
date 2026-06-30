## 上下文

5a–5e 已落地（`model-radar-catalog` 数据模型 / `model-radar-ingestion` 录入+保鲜 / `model-radar-compare-api` 只读快照+比价 / `model-radar-compare-web` SSR 页 / `model-radar-recommender` 推荐器）。现状：`mr_plans` 单 `current_price`(月)、`category` 4 桶、source provenance（`source_url`/`last_checked`/`source_confidence ∈ {official_pricing, official_doc, official_community, media_report, needs_login_recheck}`）、`reviewStatus.pending` 待核；无 availability 生命周期字段（→「已停售」与「待核价」不可分 = 5e 已声明缺口）、无季/年付价。价格策展手工、曾拿错页（Token vs Coding Plan）。本期打「自愈 + 多维价格情报」数据模型地基。tech-plan 红线：价=精确事实/DB、LLM 不判价、bounded domain `mr_*`、同桶同币种 money-path。

## 目标 / 非目标

**目标：** ① `availability` 生命周期字段（全桶、与 confidence/pending 三正交）闭合「停售 vs 待核」缺口；② 订阅型桶季/年付价行 + 确定性「有效月价」折算（附加展示 / 最佳周期，cheapest 月价口径不变）；③ DTO/录入/推荐器最小线（推荐器用 `discontinued` 给明确停售）。

**非目标：** 不接自动 setter（自动判停售 / 链接自愈 / 语义校验 = 后续 followup）；不改 cheapest 月价排序口径；Token Plan 不入月度比价；不动 compare-web 呈现（= followup #4）；不跨桶/跨币 FX；LLM 不判价。

## 决策

**D1. `availability` 字段（产品生命周期，与 confidence/pending 三正交）。**
`mr_plans` 加 `availability ∈ {on_sale, discontinued, unknown}`（新 `mrAvailabilitySchema`），默认 `unknown`。三者各管一维、不混：`availability`=产品生命周期（在售/停售/未知）；`source_confidence`=源可信度（含 `needs_login_recheck`）；`reviewStatus.pending`=待人核。`availability='discontinued'` 是明确不可订，推荐器优先判 `not_recommended`；`unknown` 不当停售、不误杀迁移后的既有 plan。

**D2. 月价单 SOT，`mr_plan_prices` 只存季/年付。**
`mr_plans.current_price` + `mr_plans.currency` 继续是 canonical 月价 SOT，也是 cheapest / budget / recommendation ranking 的唯一价格来源。新表 `mr_plan_prices` 只存月之外的订阅周期：`{id, plan_id, billing_period ∈ {quarterly, annual}, price numeric(12,2) NULL, currency varchar(3) NOT NULL, source_url, last_checked, source_confidence}`。禁止写 `billing_period='monthly'` 镜像行，避免 `current_price` 与周期表双 SOT 漂移。`plan_id` 是裸 `varchar(128)` 引用，不建 DB FK；引用完整性仍靠录入事务契约与快照 fail-closed。

**D3. 周期价唯一键与 known 判定。**
`mr_plan_prices` 唯一键为 `UNIQUE(plan_id, billing_period, currency)`，三个组件均 NOT NULL；未核周期价若已知目标币种，可写 `{price:NULL,currency:'CNY',source_confidence:'needs_login_recheck'}` 占位；若币种也未知，则不写周期价行（靠 pending/source 后续补），避免 nullable unique 失效。周期价 `priceStatus='known'` 当且仅当 `price 非 NULL + currency 非 NULL + source_confidence ∈ {official_pricing, official_doc}`；未核行 `effectiveMonthly` 必须为 `null`。

**D4. DTO/ETag：服务表征全量进 hash。**
snapshot build/dto 暴露 plan 的 `availability` + `periodPrices[]`（季/年付，含 `priceStatus`、`effectiveMonthly`、provenance）。这些字段是 API 实际服务表征，必须全部进入 canonical 内容哈希/ETag；禁止 served-but-unhashed 或 hashed-but-unserved。`effectiveMonthly` 不进 cheapest/sort，但只要对外返回就进 hash。

**D5. cheapest 与推荐器排除 discontinued，但不改变月价排序口径。**
query/cheapest 仍按同 `(category,currency)` 内 canonical 月价排序，但 `availability='discontinued'` 的 plan 不参与 `cheapestPlanId` / `comparable=true` 的候选集合；它仍可列在结果里，供用户看到停售状态。推荐器 verdict 规则 0：`discontinued → not_recommended(reason=已停售)`，优先于未核/预算/撞窗；primary 只从非停售 eligible 子集里选。最佳周期只作理由/文案：在 canonical 月价（若 known）与已核季/年有效月价中取最低，标「含预付锁期」，不影响排名。

**D6. 授权写路径：upsert guarded + 显式 setter。**
`upsertPlan` 接受 `availability`，仅 INSERT 时落库；冲突分支若 existing availability 与 incoming 不同，返回 conflict + 打 flag，不盲覆盖。新增人工/seed 授权写入口：`setPlanAvailability(planId, availability, ...)` 显式更新 lifecycle；`upsertPlanPeriodPrice(planId, billing_period, currency, price, provenance, ...)` 写/刷新季年付行并守 confidence↔price 绑定。这些授权写提交后触发快照 rebuild/invalidation。保鲜回路/三档抓取不得自动改 `availability`/`source_url`/价格，只打 pending。

**D7. 快照读集、staleness、dispose 纳入周期价。**
compare-api 快照读集从 9 张变 10 张，新增 `mr_plan_prices`，在同一只读事务内按稳定键读取并按 `(plan_id,billing_period,currency)` 固定排序。plan `freshness.stale` 聚合必须纳入周期价行 `last_checked`；`markChecked(plan)` 必须刷新 `mr_plan_prices.last_checked`（与 plan/limits/clients/models 同粒度），否则最佳周期可能陈旧却显示 fresh。

## 风险 / 权衡

- **既有行迁移后 `availability` 全 `unknown`**：只对 `discontinued` 做强不荐/排除 cheapest，`unknown` 不误杀；在售/停售须经 seed/人工显式置。
- **不存 monthly 行导致查询少一个统一数组**：换来单 SOT。DTO 可在展示/推荐层把 canonical 月价作为最佳周期候选，但 DB 不双写月价。
- **未核周期价需要 currency 非 NULL**：这是为让唯一键真兜底。币种未知时不写占位行，避免 `(plan,period,NULL)` 重复。
- **有效月价误读为真月价**：文案标「含预付 / 锁期 N 月」，且不进 cheapest/sort；Token Plan 不生成 effectiveMonthly。
- **停售判级位置**：`availability=discontinued` 优先于价/撞窗/未核 → `not_recommended`；与未核价 `insufficient_data` 语义分清。

## 迁移计划

1. `src/db/mr-schema.ts` + `mr-schema.zod.ts`：加 `mrAvailabilitySchema` + `mrBillingPeriodSchema({quarterly,annual})`、`mr_plans.availability` 列、`mr_plan_prices` 表 + zod；drizzle migration（零 FK、既有行 availability=unknown）。
2. 录入：`upsertPlan` INSERT 接受 availability、冲突只打 flag；新增 `setPlanAvailability` + `upsertPlanPeriodPrice`；不接自动 setter。
3. `src/mr/snapshot/{build,dto,query}`：读第 10 张表；DTO 暴露 availability + periodPrices；服务字段全进 hash；cheapest 排除 discontinued 且仍按月价。
4. `src/mr/freshness/dispose.ts` / staleness 相关：周期价纳入 stale 聚合和 `markChecked(plan)`。
5. `src/mr/recommend`：verdict 加 discontinued rule 0 + 最佳周期标注。
6. 测试：schema/migration 零 FK/唯一键；周期价 unknown/null；DTO hash；cheapest/recommender；既有红线回归。
- 回滚：纯加列/加表（向后兼容）；DTO/推荐器新字段可摘；money-path 月价未动。

## 待解问题

无。已收敛为：`mr_plan_prices` 不存 monthly；既有行 availability 默认 `unknown`；周期价 currency 非 NULL，币种未知不写占位行。
