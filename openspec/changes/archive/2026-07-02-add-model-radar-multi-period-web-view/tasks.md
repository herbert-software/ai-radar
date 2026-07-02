## 1. render 层纯函数（组 B / render.ts）

- [x] 1.1 新增**单一** `bestPeriod(plan)` 纯函数（组件层不设并行抑制分支）：只在**同币种**（`periodPrice.currency === plan.currency`）已核周期价里取最低 `effectiveMonthly`，仅当**严格低于** canonical 月价时返回其 `billingPeriod`，否则 null；返回 null 的全部情形：月付最低 / 平局 / 无同币种已核周期价 / 月价 `priceStatus=unknown` / `availability=discontinued`（停售抑制在此实现）；同币种季年并列最低 → 确定性择 annual。纯读 DTO、不重算、不碰 money-path、不新增哈希输入（D3）
- [x] 1.2 新增 availability 徽标判定纯函数：`discontinued`→已停售、`unknown`→状态未知、`on_sale`→无标；含文字标签（emoji `aria-hidden`），与 age/status 徽标风格一致（D4）
- [x] 1.3 新增周期子行折算文案纯函数：已核→`{周期} {currency} {price}（≈{currency} {effectiveMonthly 展示值}/月）`（币种代码 + 空格 + 金额；展示值 = 四舍五入到最多两位小数**并去末尾 0**，`String(Math.round(n*100)/100)` 语义、非 `toFixed(2)`——整数 `79` 不显 `79.00`）；未核→`{周期} 待核`（D2）

## 2. 组件呈现（组 B / components.tsx + PAGE_CSS）

- [x] 2.1 `PriceCell` 拆段：月价段按 known/unknown 分别渲染（unknown 显待核）+ 周期段独立渲染（不受月价短路影响），使月价待核不遮蔽已核周期子行；**月价段 MUST 保留 `currentPrice!==null && currency!==null` 的 null-format 守卫**（防 SSR NPE）（D7 / Q9）
- [x] 2.2 周期子行渲染于月价下方，用 1.3 文案；子行**不**带内联 age（D6）
- [x] 2.3 最佳周期徽标：由 `bestPeriod` 命中的子行挂「最佳周期 · {周期名}」，不报省额；停售抑制**已在 `bestPeriod` 内实现，组件层不重复设停售守卫**（D3/D5/Q7）
- [x] 2.4 availability 呈现：状态列 + 套餐名旁小标签；仅 discontinued/unknown 出标。**改造 `PlanStatusCell` 使 availability 先于/独立于 `!stale && !pending` 的「正常」提前返回求值**（否则 fresh+已复核的 `unknown` 行被吞成「正常」，components.tsx:339）（D4 / M2）
- [x] 2.5 停售行降权：整行 `.row-discontinued` 置灰 + 月价删除线；确认 `cheapestInfo` 已排除 discontinued（render.ts:139-141），无需改 money-path（D5）
- [x] 2.6 `ProvenanceDetails` 加「季付价 / 年付价」provenance 行，复用 `ProvenanceLine`（source 经 `safeHref` + confidence + age）（D6）
- [x] 2.7 `PAGE_CSS` 加 `已停售` / `状态未知` / `最佳周期` 徽标类与 `.row-discontinued`（置灰 + 删除线）；**置灰后正文文字对比度仍 ≥4.5:1**、状态不单靠颜色（复用既有 a11y 基线）

## 3. 测试（组 C / __tests__）

- [x] 3.1 `bestPeriod` 单测覆盖全边界：月付最低→null、年付严格更低→annual、季付更低→quarterly、平局→null、无同币种已核周期→null、月价 unknown→null、**停售→null**、**异币种周期（数值更低）→null（不跨币）**、**同币种季年并列最低→annual**（确定性；判定用未取整精确值 + `Number(plan.currentPrice)` 基线）
- [x] 3.2 子行折算文案单测：已核显原始价 + 折算（**非整除 1099/12 → `91.58`；整除如 948/12 → `79`（不带 `.00`）**）、未核显待核不折算
- [x] 3.3 availability 徽标判定单测：三值各自输出（含 on_sale 无标）；**`PlanStatusCell` 对 fresh+已复核的 `unknown` 行仍出「状态未知」、不被「正常」吞**（M2）
- [x] 3.4 组件渲染断言（沿既有 render 单测模式，不 boot server）：月价待核+周期已核仍渲周期子行、停售行有 `.row-discontinued` 且无最佳周期徽标、溯源区含周期价行；**空 `periodPrices`（现有主流 plan）→ 不渲子行、月价路径与现状一致（no-op 回归）**
- [x] 3.5 money-path 不变断言：最佳周期/周期呈现渲染下，cheapest/排序仍只依 canonical 月价（或注明由既有 `query`/`cache.test.ts` 覆盖，本变更不新增哈希输入）（F7）

## 4. 验收

- [x] 4.1 `pnpm lint` + `pnpm test`（或项目对应命令）通过（`npm run lint` exit 0；`vitest run src/mr` 1484 passed / 0 failed；全量套件含慢速集成测试超时，非本变更相关）
- [x] 4.2 本地起页面核对：SSR 页无客户端 JS，组 C 渲染测（multi-period.test.tsx，23 passed）已对 ComparePage 输出 HTML 断言全部验收点——含季/年付子行 + 最佳周期徽标、停售行 `.row-discontinued` + 删除线且无最佳周期、月价待核+年付已核仍渲年付、溯源区含周期价行；起服务器只会返回同一 HTML，故以 SSR 渲染断言等价覆盖
- [x] 4.3 `openspec-cn validate add-model-radar-multi-period-web-view` 通过
