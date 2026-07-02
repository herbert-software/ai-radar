## 上下文

Model Radar 比价页（5d-B，`model-radar-compare-web`）是静态无 JS 的 `hono/jsx` SSR 页，按 `(category, currency)` 分组渲染原生 `<table>`（9 列），UI gate 到 `coding_plan`。money-path（过滤/排序/最划算）全由 vetted `queryModelRadarSnapshot` 决定，render 层（`render.ts` 纯函数 + `components.tsx` 组件）只组装 DTO 字段、不向快照内容哈希新增输入。（注：快照内容哈希由 builder 对完整 DTO 计算，`periodPrices`/`effectiveMonthly` 作为 DTO 字段**已由 PR #51 纳入哈希**并有测试守（`cache.test.ts`）；本变更是 render-only，不改 DTO 构成、不新增哈希输入——这与「effectiveMonthly 不进哈希」是两回事，后者说法错误。）

PR #51 已把 `availability`（生命周期）与季/年付 `periodPrices`（含 builder 算好的 `effectiveMonthly`）落进只读快照 DTO，builder 填充（`build.ts:297/309`）、query 透传（`result.groups[].plans[]`）。当前页面消费了 DTO 却丢弃这两批字段——本期是纯前端收尾，把已核事实呈现出来。

展现形式经 grill 逐项定案（决策见下），核心约束：一 plan 一行、周期价作价格格内子行、最佳周期严格「相对 canonical 月价」、停售可看不可买、money-path 口径不动。

## 目标 / 非目标

**目标：**
- 价格格内渲染季/年付子行（原始价 + `effectiveMonthly` 折算月价），未核显「待核」。
- 仅在周期价折算严格低于月价时标「最佳周期 · 周期名」（不报省额）。
- 呈现 availability：停售降权 + 抑制最佳周期 + 不参与最划算；未知次级态；在售不出标。
- 周期价逐条可溯源（溯源区加行）、新鲜度纳入 plan 最旧徽标。
- `PriceCell` 拆段，使月价待核不遮蔽已核周期价。

**非目标：**
- 不改 cheapest/排序口径（仍只按 canonical 月价、同桶同币种）；不向快照内容哈希新增输入（DTO 字段哈希构成不变）。
- 不做整页重设计（category 多视图、卡片化、响应式重排 = 独立后续提案）。
- 不解 `coding_plan` UI gate；不为 `token_plan` 生成折算/最佳周期。
- 不接自动 setter、不改数据层/DTO/builder/query。

## 决策

**D1 — 行模型：一 plan 一行，周期价作价格格内子行（Q1=A）。** 备选「一周期一行」会打破一 plan 一行心智、且把只按月价的 cheapest/排序搞复杂；「只放溯源区」把 A-3 核心（一眼看最佳周期）埋掉。子行方案直接对齐 DTO 形状（`plan.periodPrices[]` 挂在 plan 上），并天然守住 money-path 只按 canonical 月价的不变量。

**D2 — 子行格式：原始周期价 + 括号折算月价（Q2=A）。** `季付 CNY 297（≈CNY 99/月）`（币种沿代码「币种代码 + 空格 + 金额」约定，非货币符号）。折算月价是「哪个周期划算」的核心、真实承诺额（一次付多少）是决策要素，两者都保留。`effectiveMonthly` 直接读 DTO、render 不重算；但 DTO 原值是**未取整浮点**（`1099/12=91.58333…`），故 render 层 MUST 在展示前四舍五入到最多两位小数**并去末尾 0**（`String(Math.round(n*100)/100)` 语义，非 `toFixed(2)`——整数显 `79` 而非 `79.00`；`91.58` 正常显）——取整仅为展示，不改写 DTO 值、不入 money-path、不用于最佳周期判定（判定用未取整精确值，见 D3）。

**D3 — 最佳周期判定 `bestPeriod(plan)`（Q3=A, Q7=B, Q9 抑制）。** 新增 `render.ts` **单一** 纯函数（组件层不设并行抑制分支——两处守卫会互相假设对方负责而漏判）：只在**同币种**（`periodPrice.currency === plan.currency`）的已核周期价中取最低 `effectiveMonthly`，仅当严格低于 canonical 月价时返回该 `billingPeriod`，否则 null。返回 null 的全部情形：月付最低 / 平局 / 无同币种已核周期价 / 月价 `priceStatus=unknown`（无基线）/ `availability=discontinued`（停售抑制在此函数内实现）。同币种周期并列最低时按确定性规则择一（annual 优先于 quarterly，取更长承诺）；注 `mr_plan_prices` 有 `UNIQUE(plan_id,billing_period,currency)`（`schema.ts:519`），故同 (plan,period,currency) 至多一行、并列只可能发生在 quarterly-vs-annual 之间，两元素择一即完全确定。判定基线是 `Number(plan.currentPrice)`（`currentPrice` 在 DTO 是字符串，须显式 `Number()`，勿写字符串比较）；比较用**未取整精确** `effectiveMonthly`（非展示两位取整值），故取整边界上徽标可能出现而展示金额看似相等——按精确事实判定的预期行为。徽标只标周期名、不报省额（折算已在子行）。纯展示、不新增哈希输入、不碰 money-path。**跨币防线的理由**：周期价 `currency` 是 DTO 独立非空字段、builder 原样透传（`build.ts:232`），与 `plan.currency` 无任何 cross-check；若不加同币种前置，异币种周期（如 CNY 月价 vs USD 年付）会被裸数值比较误判「最佳周期」，直接违反「不做跨币/跨桶 FX」红线（Codex + CR + RC 三方独立命中）。

**D4 — availability 呈现：状态列 + 名旁小标签双管，且独立于「正常」提前返回（Q4=A+C，暂定）。** 复用「状态」列聚合 plan 级旗（与 待复核/陈旧 同列），并在套餐名旁加小标签提升停售可见性。仅 `discontinued`/`unknown` 出标，`on_sale` 静默。**关键**：现有 `PlanStatusCell` 对 `!stale && !pending` **提前返回「正常」**（`components.tsx:339`），会把 `availability=unknown` 的 fresh+已复核行吞成「正常」——故 availability 呈现 MUST 先于/独立于该分支求值（在提前返回前先算 availability 标），否则「未知状态显次级态」需求落不了地。此放置在整页重设计时可重定——本期取「可见性优先」的双管。

**D5 — 停售降权（视觉层，抑制逻辑归 D3）（Q5=A）。** 与「停售不参与 cheapest / 不作推荐 primary」红线一致：整行置灰 + 月价删除线（纯 CSS class `.row-discontinued`）；置灰后正文文字仍须对比度 ≥4.5:1（状态由「已停售」徽标 + 删除线承载，灰仅装饰）。**最佳周期抑制不在视觉层重复实现**——已收敛进 `bestPeriod`（D3 返回 null），组件层不设第二处停售守卫。`cheapestInfo` 已过滤 `availability!=='discontinued'`（`render.ts:139-141`），cheapest 排除无需改动。

**D6 — 溯源加周期行、子行不带内联 age（Q6）。** 守「每条事实可溯源 + 标陈旧」红线：`ProvenanceDetails` 复用 `ProvenanceLine` 加「季付价/年付价」行。`render.ts` 的 `planFactDates` 已含周期价日期（新鲜度已覆盖），故价格格子行不再堆内联 age，只 canonical 月价（money-path 数字）保留内联 age。

**D7 — `PriceCell` 拆段（Q9=A）。** 现有「`priceStatus==='known' && currentPrice!==null && currency!==null` 才渲染，否则整格待核」短路（`components.tsx:311`）会遮蔽已核周期价。重构为：月价段按 known/unknown 分别渲染 + 周期段独立渲染（不受月价短路影响）。**拆段时月价段 MUST 保留原 `currentPrice!==null && currency!==null` 的 null-format 守卫**（现有「禁止 format null 防 SSR NPE」red line），不能因改判 `priceStatus` 而丢。最佳周期徽标依赖 canonical 月价基线，月价 unknown 时由 `bestPeriod` 返回 null 自然抑制。

**D8 — 测试：render 纯函数单测（组 C 模式）。** `bestPeriod` 覆盖 D3 全边界（月付最低→null / 年付严格更低→annual / 季付更低→quarterly / 与月价平局→null / 月价 unknown→null / 无同币种已核周期→null / 停售→null / **异币种周期不参与**→null / **同币种季年并列最低→annual** 确定性）；子行折算文案（已核：四舍五入到最多两位、去末尾 0——整数 `79` 无 `.00`、`91.58` 保留；未核显待核）与 availability 徽标判定（三值，含 unknown 不被「正常」吞）各断言；另加「本 render-only 变更不改快照哈希构成」的说明性断言（或注明由既有 `cache.test.ts` 覆盖）。沿既有「render 层纯函数单测、不 boot server」模式，无新框架。

## 风险 / 权衡

- **价格格信息密度上升**（月价 + 最划算 + 季/年付子行 + 最佳周期 + age）→ 缓解：子行不带内联 age（D6）、最佳周期仅真省钱才出（D3）、省额不显（D7=B），把噪声压到最低；整页重设计另开时再考虑卡片化。
- **availability 双管标（状态列 + 名旁）可能视觉重复** → 缓解：标为暂定（D4），页面重设计时重定；本期取停售可见性优先。
- **最佳周期语义被误读为跨 plan 最划算** → 缓解：徽标文案「最佳周期 · 年付」明确是 plan 内周期比较，与 group 级「最划算」措辞区分；spec 场景钉死两者正交、最佳周期不改 money-path。
- **月价 unknown + 周期已核的罕见组合**（D7）→ 缓解：`bestPeriod` 对 null 基线返回 null，spec 单场景 + 单测钉死「不宣称最佳」。
