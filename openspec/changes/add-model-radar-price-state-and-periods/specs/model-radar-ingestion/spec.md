## MODIFIED Requirements

### 需求:录入经 Zod 闸（每写 mr_* 前校验，含非录入路径）

**任何生产路径**写入或更新任一 `mr_*` 表前，必须对其涉及的有限值字段调 `src/db/mr-schema.zod.ts` 对应 schema（既有 8 枚举 + 本变更新增的 availability/billing_period），`mr_plans` 调 `mrPlanWriteSchema` refine，`mr_plan_prices` 调周期价写 schema（`billing_period`、`currency`、`source_confidence` + confidence↔price 绑定）；校验失败不得发 SQL。这包括录入路径**以及**抓取链（写 `mr_source.fetch_strategy`）、事件消费者（写 `mr_review_flag.target_type`）、改价（`mr_price_history`）、availability 授权写、周期价授权写。5a 只提供 8 enum + partial plan schema，5b 必须为 `upsertPlan/Model/PlanLimit/PlanClient/PlanModel/PlanSource/Source` 各建组合写校验器，且本变更必须同时覆盖 `setPlanAvailability` 与 `upsertPlanPeriodPrice`；**改价路径（`recordPriceChange` 写 `mr_price_history`）必须校验 `source_confidence`/`currency` 枚举**（`mr_plan_models`/`mr_price_history`/`mr_plan_prices` 同为有限值列，不可漏）。全桶所需新枚举值（`credit`/`fast_pass`/更多 currency）随录入扩入 `mr-schema.zod.ts`（扩值不改语义，仍是该文件统一闸）。

#### 场景:非录入路径写枚举列也过 Zod
- **当** 抓取链注册一个 `fetch_strategy` 非法的源（或事件消费者写非法 `target_type`）
- **那么** 对应 Zod 枚举校验在发 SQL 前拒绝

#### 场景:全桶新枚举值随录入扩
- **当** 录入 IDE会员/Token 桶含 `fast_pass`/`credit` 限额
- **那么** `mr-schema.zod.ts` 词表已扩入该值并校验通过（扩值有对应录入往返测试）

#### 场景:周期价写入也过 Zod
- **当** 周期价写入收到 `billing_period='monthly'`、非法 currency、或非官方 confidence 携带非 NULL price
- **那么** Zod 在发 SQL 前拒绝，不落库

### 需求:ingest 区分 identity 与 fact 写，禁止盲覆盖事实

`upsertVendor/upsertModel` 是 identity（唯一键冲突幂等）；`upsertPlan/upsertPlanLimit/upsertPlanClient/upsertPlanModel/upsertPlanPeriodPrice` 写断言事实。事实写**机制必须**为 `INSERT … ON CONFLICT DO NOTHING RETURNING` → RETURNING 空则读既有行**数值归一逐字段比对事实字段**（相同=幂等 no-op、不同=返回 `{conflict,field}` + 打 flag），**禁止用 `onConflictDoUpdate` 在唯一键冲突时盲覆盖事实字段**（plan=`current_price/currency/source_url/source_confidence` + **`category`**（5a 唯一键 `(vendor_id,name)` 不含 category，同 `(vendor_id,name)` 重录但 category 异**必须打 conflict、不静默 no-op**）+ 本变更新增的 **`availability`**，limit=`value/source_*`（`window` 是 5a 唯一键组件非比对事实），junction=`source_confidence/source_url`，period price=`price/source_*`（`billing_period/currency` 是唯一键组件非比对事实）；`last_checked` 是可刷新 provenance 非事实字段），二次读容 0 行不 NPE。**价格路径例外**：existing-plan canonical 月价及对应 provenance 经 `recordPriceChange`（唯一授权刷 `mr_plans.current_price/currency` 的入口）同事务更新——属授权事实更新非盲覆盖；D2「禁盲覆盖」专指 `upsertPlan` 冲突分支对事实字段禁 `.set()`。本变更新增的 availability 与季/年付价各有显式授权写入口：`setPlanAvailability` 刷 lifecycle，`upsertPlanPeriodPrice` 写/刷新 `mr_plan_prices`，均不得借 `recordPriceChange` 冒充。`mr_models.family` 写前必须小写归一（5a 移交契约，防 `GLM`/`glm` 误分裂）。

#### 场景:同 (vendor,name) availability 异打冲突不静默
- **当** `upsertPlan` 重录同 `(vendor_id,name)` 但 `availability` 与既有不同
- **那么** 返回 conflict + 打 flag，不被当幂等 no-op，也不盲覆盖生命周期事实

#### 场景:同 vendor 同 family 大小写归一不分裂
- **当** 录入 `GLM` 与 `glm`（同 vendor、同 version）
- **那么** 归一后命中同一 family，唯一键视为同行，不分裂

#### 场景:同 (vendor,name) 异 category 打冲突不静默
- **当** `upsertPlan` 重录同 `(vendor_id,name)` 但 `category` 与既有不同（价格/provenance 即便相同）
- **那么** 返回 conflict + 打 flag，不被当幂等 no-op 静默吞掉

#### 场景:周期价冲突不盲覆盖
- **当** `upsertPlanPeriodPrice` 重录同 `(plan_id,billing_period,currency)` 但 price/provenance 事实不同
- **那么** 按授权写语义刷新或返回 conflict（实现须二选一并测试），不得通过普通 upsert 盲覆盖导致事实不可审计

### 需求:人工 dispose 最小面闭环

必须提供 `resolveFlag(target)`（plain UPDATE status='resolved'+resolved_at）+ 最小 dispose 面（脚本/函数）：列出 pending flags（按 target_type/age）+ `markChecked(target)`：resolveFlag + **按标的粒度同事务刷 last_checked**——source 标的刷 `mr_source.last_checked`，**plan 标的必须刷 `mr_plans.last_checked` 及其全部 child 事实行**（`mr_plan_limits`/`mr_plan_clients`/`mr_plan_models`/`mr_plan_prices`）的 `last_checked`（否则 junction/limit/period price 触发的 plan flag 因陈旧度仍扫到陈旧 child 行而被永久重打标）。保鲜回路必须闭合：propose（打标）→ 人工 dispose（resolve + 刷 last_checked），否则 flag 只进不出、陈旧度反复重打标。

#### 场景:resolve 后不被陈旧度立即重打标
- **当** 人工 `markChecked` 某源（resolve + 刷 last_checked=now）
- **那么** 陈旧度排程不再立即对它重打标（last_checked 已新）

#### 场景:junction 触发的 plan flag dispose 后不重打标
- **当** 某 `mr_plan_models` 行陈旧触发 plan flag，人工 `markChecked(plan)`
- **那么** 该 plan 的 `mr_plans` 及全部 child 事实行 `last_checked` 一并刷新，下轮陈旧度不再对该 junction 行重打标

#### 场景:周期价触发的 plan flag dispose 后不重打标
- **当** 某 `mr_plan_prices` 行陈旧触发 plan flag，人工 `markChecked(plan)`
- **那么** 该 plan 的 `mr_plan_prices` 行随其他 child 事实行一并刷新，下轮陈旧度不再因该周期价立即重打标

### 需求:陈旧度排程覆盖所有事实表（含 NULL 与 junction）

陈旧度必须扫 `mr_source` 与各事实表 `mr_plans`/`mr_plan_limits`/`mr_plan_clients`/`mr_plan_models`/`mr_plan_prices` 的 `last_checked`；超阈值（默认 30 天 env 可配）→ source 超期打 source flag，junction/limit/period price 超期**给其所属 plan 打 plan 级 flag**（reason 注明兼容/限额/周期价行陈旧，落地兼容/周期价陈旧经所属 plan 复核的意图）。判定为 **`last_checked IS NULL OR last_checked < threshold`**（NULL=从未核对=最该复核，不被静默跳过）。其中 `mr_plan_prices.last_checked` 按 DDL NOT NULL，只走 `< threshold`；`mr_source.last_checked` 可 NULL。

#### 场景:junction 陈旧经所属 plan 进复核
- **当** 某 `mr_plan_models` 行 `last_checked` 超 30 天
- **那么** 给其所属 plan 打 plan 级 flag（reason 注明兼容行陈旧）

#### 场景:周期价陈旧经所属 plan 进复核
- **当** 某 `mr_plan_prices` 年付行 `last_checked` 超 30 天
- **那么** 给其所属 plan 打 plan 级 flag（reason 注明周期价行陈旧）

#### 场景:last_checked NULL 也进复核
- **当** 一个 manual/needs_login 占位源 `last_checked IS NULL`
- **那么** 它进入复核（NULL 判为最该复核，非跳过）

### 需求:三档抓取仅做变更检测、检测器原子防 stale-retry、绝不改事实

抓取必须按 `mr_source.fetch_strategy ∈ {http,browser,manual}` 分档：抽价格/额度区域归一文本 → `content_fingerprint` sha256。必须**原子比对 `mr_source.content_fingerprint`，仅真变时**才同事务更新 fingerprint+last_checked + 经 `mr_plan_sources` 定位覆盖 plan 逐个打标；**定位空集合则给 source 自身打 `target_type='source'` flag**（页面变动永不被吞）。无变化只刷 last_checked，不打标。`manual` 不抓。**禁止自动改 `mr_*` 价格/限额/兼容/availability/source_url/周期价事实**——结构上 `src/mr/scrape/` 禁止 import 事实 writer（`upsertPlan`/`recordPriceChange`/`setPlanAvailability`/`upsertPlanPeriodPrice`），eslint `no-restricted-imports` 兜底。自动判停售、链接自愈、语义校验抽取均属后续 followup，本期抓取链不得调用任何事实 writer。

#### 场景:指纹真变只打标不改值
- **当** 某源 fingerprint 较存储值变化
- **那么** 更新 fingerprint/last_checked + 给覆盖 plan 打待复核，`mr_*` 事实值不变

#### 场景:stale 重试 no-op
- **当** 一个旧抓取 job 重试，抓到与已更新 fingerprint 相同的内容
- **那么** 无变化 → 不打标（已 resolve 的 flag 不被旧 job 无条件重开）

#### 场景:定位空集合给 source 打标
- **当** 一个未关联任何 plan 的源指纹变化
- **那么** 给 `target_type='source'` 打标（不静默吞掉页面变动）

#### 场景:manual 源不抓
- **当** `fetch_strategy='manual'` 的源
- **那么** 抓取链不发请求

#### 场景:保鲜回路不自动判停售/不自愈链接
- **当** 保鲜回路检测到某 plan 关联源变更
- **那么** 仅按既有红线打 `reviewStatus.pending` 待复核；不自动改 `availability`、不自动改 `source_url`、不 LLM 判停售/判价

## ADDED Requirements

### 需求:录入支持 availability + 季/年付周期价写入，本期不接自动 setter

`mrPlanWriteSchema` / 录入路径必须接受 `availability ∈ {on_sale, discontinued, unknown}`；`upsertPlan` 仅在 INSERT 时写入，existing 行差异按 guarded conflict 处理。必须新增人工/seed 授权写入口 `setPlanAvailability(planId, availability, ...)`，用于显式 lifecycle 状态转移（`on_sale ↔ discontinued`、`* → unknown`）。必须新增 `upsertPlanPeriodPrice`（或等价命名）写 `mr_plan_prices`，仅接受 `billing_period ∈ {quarterly, annual}`、`currency` 非 NULL，逐行守 confidence↔price 绑定。上述授权写提交后必须触发快照 rebuild/invalidation。

#### 场景:availability 经授权 setter 写入
- **当** 人工核实某 plan 已停售并调用 `setPlanAvailability(planId,'discontinued')`
- **那么** 写入 `mr_plans.availability='discontinued'`，提交后触发快照 rebuild/invalidation；不经 LLM 判定、不由抓取链自动调用

#### 场景:季/年付价经授权写入
- **当** 经人工/seed 授权录入某 plan 的年付 CNY 价
- **那么** Zod 闸校验通过后写 `mr_plan_prices` 年付行（带独立 provenance）；若未核但币种已知，则 price 为 NULL、effectiveMonthly 为 NULL；若币种未知，则不写占位行
