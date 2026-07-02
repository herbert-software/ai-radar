## 为什么

PR #51（`add-model-radar-price-state-and-periods`）已在数据模型 + 只读快照 DTO 里落地了 `availability`（产品生命周期）与季/年付 `periodPrices`（含算好的 `effectiveMonthly` 折算月价），且 builder 已填充、query 已透传到页面层（`build.ts:297/309`、`result.groups[].plans[]`）。但比价 Web 页仍只渲染 canonical 月价——用户看不到「这家已停售」「年付折算后更便宜」「哪个周期最划算」。字段已就绪、纯前端收尾即可把这批已核事实呈现出来，是当前最短闭环的用户可见增量。

## 变更内容

- **周期价子行**：价格格内在月价下方渲染季/年付子行，格式 `季付 CNY 297（≈CNY 99/月）`（原始周期价 + `effectiveMonthly` 括号折算；币种沿代码「币种代码 + 空格 + 金额」约定、非货币符号）；`effectiveMonthly` DTO 原值是未取整浮点，render 层展示前 **MUST 格式化为最多两位小数**（防 `≈CNY 91.58333…/月`）；周期价 `priceStatus=unknown` → 显「季付 待核」，不编造折算。
- **最佳周期标注**：收敛在单一 render 纯函数 `bestPeriod(plan)`；仅在**与月价同币种**（`periodPrice.currency === plan.currency`）的已核周期价里，某条 `effectiveMonthly` **严格低于** canonical 月价时，给获胜子行打「最佳周期 · 年付」徽标（不报省额——折算月价已在子行）；月付最低 / 无同币种已核周期价 / 平局 / canonical 月价 `unknown`（无基线）/ 停售 → 不打；同币种季年并列最低 → 确定性择 annual（更长承诺）。异币种周期价不参与比较（守不跨币红线）。
- **availability 生命周期呈现**：`discontinued` → 「已停售」徽标 + 整行置灰 + 月价删除线 + **抑制最佳周期**（经 `bestPeriod` 单一实现，可看不可买）；`unknown` → 次级灰「状态未知」（区别于「正常」，防未迁移旧行冒充在售）；`on_sale` → 不出标（默认态）。availability 标进现有「状态」列**并先于/独立于**该列 `!stale && !pending` 的「正常」提前返回求值（否则 fresh+已复核的 unknown 行会被吞成「正常」），并在套餐名旁加小标签（双管提升停售可见性）。
- **周期价溯源**：`<details>溯源` 展开区加「季付价 / 年付价」行，逐条挂 `source_url` / `source_confidence` / age 徽标（守「每条事实可溯源 + 标陈旧」红线）；价格格内周期子行**不**带内联 age（新鲜度列的 plan 最旧徽标已含周期价日期 + 溯源区逐条覆盖）。
- **`PriceCell` 短路重构**：现有「`priceStatus==='known' && currentPrice!==null && currency!==null` 才渲染、否则整格待核」短路，拆成「月价段 + 周期段」独立渲染——月价待核但周期价已核时，月价显待核、周期子行照渲（诚实披露已核事实）；拆段时月价段 **MUST 保留 null-format 守卫**（防 SSR NPE）。

### 非目标

- **不改 cheapest / 排序口径**：比价/排序仍以 canonical 月价 `current_price` 为准、只在同桶同币种内比较；`effectiveMonthly` 与最佳周期只作附加展示，不进 cheapest/sort、不冒充月价。**不向快照内容哈希新增输入**——注意 `periodPrices`/`effectiveMonthly` 作为 DTO 字段**已由 PR #51 纳入内容哈希**（`cache.test.ts` 有守），本变更为 render-only、不改 DTO 哈希构成；「effectiveMonthly 不进哈希」是错误表述，本期只是不新增哈希输入。
- **不做整页重设计**：`category` 多视图、卡片化布局、响应式重排 = 独立后续提案；本期只在现有 `<table>` 原地增强，复用既有 a11y/XSS/排序/reflow 基线。
- **不解 `coding_plan` UI gate**：页面仍只显桶2（coding_plan）；`token_plan` 不生成 `effectiveMonthly`/最佳周期（本就不在本页）。
- **不接自动 setter / 不改数据层**：不判停售、不自动改链接、不让 LLM 判价；availability/周期价的写入仍走 PR #51 已立的人工/seed 授权入口。
- **不做跨币/跨桶 FX**；金额读为精确事实。

## 功能 (Capabilities)

### 新增功能

（无——本期是在既有 `model-radar-compare-web` 能力上扩展呈现，不引入独立新 capability。）

### 修改功能

- `model-radar-compare-web`: 比价页新增「季/年付周期价子行 + 折算月价呈现」「最佳周期标注（严格低于月价才标、停售/无基线抑制）」「availability 生命周期呈现（停售降权 + 未知次级态）」「周期价逐条可溯源」四项呈现需求；`PriceCell` 拆段使月价待核不遮蔽已核周期价。money-path（cheapest/排序/哈希）口径不变。

## 影响

- **代码**：`src/mr/web/render.ts`（新增纯函数：最佳周期判定 `bestPeriod`、availability 徽标判定；组 C 单测覆盖 Q3/Q5/Q9 边界）、`src/mr/web/components.tsx`（`PriceCell` 拆段 + 周期子行 + 最佳周期徽标 + availability 入状态列/名旁标签 + 停售行降权 + `ProvenanceDetails` 加周期行）、`PAGE_CSS`（`已停售`/`状态未知`/`最佳周期`/停售行删除线置灰类）、`src/mr/web/__tests__`（render 纯函数单测）。
- **无 data/API/schema 改动**：字段已随 PR #51 落地 DTO + builder + query；本期只消费不新增。
- **红线**：全桶 `mr_*` bounded domain 不动；money-path 只经 vetted `queryModelRadarSnapshot`，render 层新增判定不碰价格排序/最划算、不向内容哈希新增输入；最佳周期只比同币种（不跨币 FX）；每条周期价事实可溯源 + 标陈旧；停售不参与 cheapest、不打最佳周期；XSS 仍走 `safeHref` 单闸 + `hono/jsx` 默认转义。
