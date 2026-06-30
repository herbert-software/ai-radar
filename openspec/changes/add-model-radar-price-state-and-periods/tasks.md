## 1. 数据模型 + migration（`model-radar-catalog`；design D1/D2/D3/D7）

- [x] 1.1 `src/db/mr-schema.zod.ts`：加 `mrAvailabilitySchema = z.enum(['on_sale','discontinued','unknown'])` + `mrBillingPeriodSchema = z.enum(['quarterly','annual'])`；`mr_plans` zod 加 `availability`（默认 `unknown`）；新 `mrPlanPriceSchema`（`{plan_id, billing_period, price:nullable, currency:non-null, source_url, last_checked, source_confidence}`，逐行守 confidence↔price 绑定，`priceStatus='known'` iff price 非 NULL + official confidence）
- [x] 1.2 `src/db/schema.ts`：`mr_plans` 加 `availability` 列（默认 `'unknown'`、NOT NULL）；新表 `mr_plan_prices`（`plan_id varchar(128) NOT NULL` 裸引用、**不建 FK**、`billing_period`/`currency` NOT NULL、`UNIQUE(plan_id,billing_period,currency)`、各自 provenance 列）
- [x] 1.3 drizzle migration：幂等加列 + 加表；既有 `mr_plans` 行 `availability` 默认 `unknown`（不据 confidence/价臆断）；`current_price`(月) 不动；迁移/结构测断言 `mr_*` 仍零 FK、唯一键组件全 NOT NULL
- [x] 1.4 有效月价纯函数 `effectiveMonthly(price, billing_period) = price ÷ {quarterly:3, annual:12}`；若 period `priceStatus!='known'` 则返回 `null`（防 `Number(null)→0`）；该值只不进 cheapest/sort，但作为 DTO 字段必须进内容哈希

## 2. 录入（`model-radar-ingestion`；design D5/D6；本期不接自动 setter）

- [x] 2.1 `mrPlanWriteSchema`/`upsertPlan`：接受 `availability`（默认 `unknown`）；INSERT 时写入；existing-plan 若 availability 不同，返回 conflict + 打 flag，**不得**盲覆盖
- [x] 2.2 新增人工/seed 授权写入口 `setPlanAvailability(planId, availability, ...)`：显式改 lifecycle；提交后触发快照 rebuild/invalidation；保鲜回路不得调用
- [x] 2.3 新增 `upsertPlanPeriodPrice`（或同等命名）：仅写 `billing_period ∈ {quarterly,annual}`，`currency` 必填，`price` 可空；逐行守 confidence↔price 绑定；同 `(plan,period,currency)` 幂等刷新 provenance/last_checked，事实冲突按既有 guarded-write 纪律处理
- [x] 2.4 不接自动 setter：保鲜回路/三档抓取不得自动改 `availability`/`source_url`、不 LLM 判停售判价；仅按既有红线打 `reviewStatus.pending`
- [x] 2.5 seed（`seed-data.ts`/`seed.ts`）：给可核实 plan 显式置 `availability`（在售→`on_sale`、腾讯停售→`discontinued`、未知→`unknown`）；如有已知季/年付（订阅型桶，非 `token_plan`）经 `upsertPlanPeriodPrice` 录入，带 provenance

## 3. 只读快照 + DTO（`model-radar-compare-api`；design D4/D5/D7）

- [x] 3.1 `src/mr/snapshot/{build,dto}.ts`：快照读集加入 `mr_plan_prices`（第 10 张表，同一 read-only tx，按 `(plan_id,billing_period,currency)` 稳定排序）；逐 plan 暴露 `availability` + `periodPrices[]`（`{billingPeriod, price, currency, priceStatus, provenance, effectiveMonthly}`）
- [x] 3.2 内容哈希：`availability`、`periodPrices`、`effectiveMonthly` 作为服务表征必须进入 canonical hash；新增测试证明 availability 变化、period row price/provenance/date 变化会改变 version/ETag；无变更 rebuild 仍稳定
- [x] 3.3 `src/mr/snapshot/query.ts`：cheapest/分组/排序仍只用 canonical 月价 `current_price`；`availability='discontinued'` 的 known-price plan 可列出但不参与 `cheapestPlanId` / `comparable=true` 候选；`availability='unknown'` 不当停售处理
- [x] 3.4 staleness/dispose：plan freshness 聚合纳入 `mr_plan_prices.last_checked`；陈旧度排程扫描 `mr_plan_prices` 并给所属 plan 打 flag；`markChecked(plan)` 刷新 `mr_plan_prices` 全部 child 行，避免最佳周期陈旧但 plan 显示 fresh
- [x] 3.5 Token Plan 守卫：`token_plan` 不生成 `effectiveMonthly` / 最佳周期；周期价写入限制在订阅型桶（`ide_membership` / `coding_plan` / `enterprise_seat`）

## 4. 推荐器（`model-radar-recommender`；design D5）

- [x] 4.1 `SnapshotPlan` / `RankedCandidate` 加 `availability`；`RuleReason.kind` 加 `discontinued` / `best_period`（或等价结构化原因）
- [x] 4.2 verdict 有序判定加 rule 0：`availability='discontinued'` → `not_recommended`（reason=「已停售」、优先于未核/价/撞窗）；rule 1 的 `insufficient_data` 去掉「含停售占位」
- [x] 4.3 候选若有 canonical 月价和/或已核季/年付 → `reasons`/文案标最佳周期（有效月价最低，标「含预付锁期」）；排名仍按月价
- [x] 4.4 空结果文案加「已停售 N 个」缘由（与待核/超预算/exceeds 并列、覆盖混合无空洞）

## 5. 测试

- [x] 5.1 schema/migration 测：`mr_plans.availability` 默认 unknown；`mr_plan_prices` 零 FK；唯一键组件全 NOT NULL；重复 `(plan,billing_period,currency)` 被 DB 拒；既有行不臆断在售
- [x] 5.2 周期价 + 有效月价测：拒 `monthly` 行；录入季/年价；未核行 `price=NULL,currency=已知币种,effectiveMonthly=null`；`Number(null)` 不会产生 0；逐行 confidence↔price 绑定
- [x] 5.3 DTO/快照/hash 测：暴露 `availability` + `periodPrices`；字段变更会改变 ETag；无变更 hash 稳定；period row `lastCheckedDate` 固定 UTC 截断
- [x] 5.4 query/cheapest 测：cheapest 仍按月价；季/年有效月价不参与 cheapest；`discontinued` 不成为 cheapest；`unknown` availability 不误杀；不跨币 FX
- [x] 5.5 推荐器 verdict 测：`discontinued`→`not_recommended`(已停售、优先于未核)；非停售未核→`insufficient_data`；最佳周期标注 + 排名仍月价；空结果含「已停售」缘由
- [x] 5.6 staleness/dispose 测：period row 陈旧使 plan stale；陈旧度排程为 stale period row 打所属 plan flag；`markChecked(plan)` 刷新 `mr_plan_prices` 后不再立即重打标
- [x] 5.7 既有红线回归：未核价不入最便宜、cheapest 月价口径不变、不跨币 FX、money-path 不手搓

## 6. 验证

- [x] 6.1 `openspec-cn validate add-model-radar-price-state-and-periods --strict` 通过
- [x] 6.2 `npx tsc --noEmit` 0 + `npm run lint` 干净
- [x] 6.3 `npx vitest run src/db src/mr`（schema/migration/录入/快照/推荐器全绿；既有红线：未核不入、cheapest 月价、不跨币、哈希稳定）
