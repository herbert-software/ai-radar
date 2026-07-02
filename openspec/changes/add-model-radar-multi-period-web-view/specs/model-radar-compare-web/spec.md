## 新增需求

### 需求:比价页必须呈现季/年付周期价并同时给出折算月价

比价页 MUST 在每个 plan 的价格格内、canonical 月价下方渲染已在快照 DTO 就绪的季/年付 `periodPrices` 子行，每条子行 MUST 同时显示原始周期价与 `effectiveMonthly` 折算月价（如 `季付 CNY 297（≈CNY 99/月）`，币种沿代码既有「币种代码 + 空格 + 金额」呈现约定、非货币符号）。`effectiveMonthly` MUST 直接读取 DTO 已算好的值、MUST NOT 重算；DTO 原值是**未取整浮点**（如 `1099/12=91.58333…`），故 render 层 MUST 在**展示前**四舍五入到最多两位小数**并去掉末尾多余的 0**（整数不显 `.00`：`79`（非 `79.00`）、`91.58`；即 `String(Math.round(n*100)/100)` 语义，而非 `toFixed(2)`）、MUST NOT 直接输出原始长浮点；该展示取整 MUST NOT 改写 DTO 值、MUST NOT 进入 money-path 或最佳周期判定（判定见下：用未取整精确值）。周期价 `priceStatus=unknown` 时 MUST 显「待核」占位、MUST NOT 编造折算月价。月价 `priceStatus=unknown`（待核）MUST NOT 遮蔽同 plan 已核的周期价——月价段与周期段 MUST 各自独立渲染。

#### 场景:已核周期价同时显原始价与折算月价
- **当** 一个 plan 有 `billingPeriod=annual`、`priceStatus=known`、原始年付价与非空 `effectiveMonthly`
- **那么** 价格格月价下方渲染年付子行，同时显示原始年付价与括号内折算月价（`≈CNY N/月`，N 四舍五入到最多两位小数并去末尾 0——整数如 `79` 不显 `79.00`）

#### 场景:未核周期价显待核不折算
- **当** 一个 plan 的季付 `priceStatus=unknown`（`effectiveMonthly` 必为 null）
- **那么** 渲染「季付 待核」子行，不显任何折算月价数字

#### 场景:月价待核不遮蔽已核周期价
- **当** 一个 plan 的 canonical 月价 `priceStatus=unknown` 但年付 `priceStatus=known`
- **那么** 月价段显「待核」，年付已核子行仍照实渲染（原始价 + 折算月价）

### 需求:比价页必须仅在周期价真比月价便宜时标注最佳周期

最佳周期判定 MUST 收敛在**单一** render 层纯函数 `bestPeriod(plan)`（组件层 MUST NOT 另设并行抑制分支，防两处守卫互相假设对方负责而漏判）。`bestPeriod` MUST 仅比较**币种与 canonical 月价相同**（`periodPrice.currency === plan.currency`）的已核周期价——币种不同的周期价 MUST 被排除出最佳周期比较（金额精确、不做跨币/跨桶 FX 红线）；仅当某入选周期价的 `effectiveMonthly` **严格低于** canonical 月价时返回该 `billingPeriod`，否则返回 null。以下情形 `bestPeriod` MUST 返回 null（即不标注）：月付最低、无同币种已核周期价、折算与月价平局、canonical 月价 `priceStatus=unknown`（无合法基线）、`availability=discontinued`（停售不可买、不推荐去买）。当多个同币种入选周期价 `effectiveMonthly` **并列最低且均严格低于月价**时，MUST 以确定性规则择一（择更长承诺周期，即 annual 优先于 quarterly），避免徽标目标不确定。徽标 MUST 只标明获胜周期（如「最佳周期 · 年付」）、MUST NOT 附省额数字。判定 MUST 用**未取整的精确** `effectiveMonthly` 与 `Number(plan.currentPrice)` 比较（非展示用的两位取整值）——故在取整边界上，徽标可能出现而两条展示金额看起来相同（如精确 33.3299 严格低于 33.33，两者都显 `33.33`），此为按精确事实判定的预期行为、非 bug。最佳周期判定与周期子行渲染为 render 层纯展示，MUST NOT 进入「最划算」/价格排序，MUST NOT 向快照内容哈希新增任何输入，MUST NOT 改变以 canonical 月价为准的 money-path 口径。

#### 场景:年付折算严格低于月价则标最佳周期
- **当** 一个在售 plan 的年付 `effectiveMonthly` 严格小于其 canonical 月价
- **那么** 年付子行挂「最佳周期 · 年付」徽标，且不显省额数字

#### 场景:月付最低或平局不标最佳周期
- **当** 一个 plan 的 canonical 月价 ≤ 所有已核周期价的 `effectiveMonthly`
- **那么** 不标注任何最佳周期徽标

#### 场景:月价缺基线不标最佳周期
- **当** 一个 plan 的 canonical 月价 `priceStatus=unknown`
- **那么** 即使存在已核周期价，也不标注最佳周期徽标

#### 场景:周期币种不同于月价币种不参与最佳周期
- **当** 一个 plan 的 canonical 月价为 `CNY`，而某已核周期价币种为 `USD`（其数值折算 `effectiveMonthly` 恰低于月价数值）
- **那么** 该异币种周期价 MUST NOT 参与最佳周期比较、MUST NOT 触发徽标（不做跨币 FX）；该周期子行仍以其自身币种正常展示

#### 场景:同币种周期并列最低按确定性规则择一
- **当** 一个 plan 的季付与年付 `effectiveMonthly` 并列最低且均严格低于月价
- **那么** 徽标确定性地落在年付（更长承诺周期），不出现不确定目标

#### 场景:最佳周期与周期呈现不改 money-path
- **当** 渲染最佳周期徽标与周期子行
- **那么** 「最划算」评定与价格排序仍只依据 canonical 月价，且本 render-only 变更 MUST NOT 向快照内容哈希新增任何输入（`periodPrices`/`effectiveMonthly` 作为 DTO 字段已由既有快照契约纳入内容哈希，本变更不改其构成）

### 需求:比价页必须诚实呈现 availability 生命周期并对停售方案降权

比价页 MUST 按 plan 的 `availability` 呈现产品生命周期状态：`discontinued` MUST 显「已停售」徽标、MUST 对整行做视觉降权（置灰 + 月价删除线）、MUST 抑制该行最佳周期徽标（经 `bestPeriod` 单一判定实现，见上），且 MUST NOT 参与「最划算」评定；`unknown` MUST 显次级「状态未知」以区别于「正常」（避免未迁移旧行被冒充在售）；`on_sale` MUST NOT 出任何 availability 标（默认态）。availability 与 `source_confidence`、`reviewStatus.pending` 三者正交，MUST 各自独立呈现、MUST NOT 相互冒充；具体地，availability 的呈现 MUST 独立于既有「陈旧 / 待复核 / 正常」状态判定——`availability=unknown` MUST NOT 因 plan 恰为「不陈旧且不待复核」而被吞进「正常」而丢失（现有状态格对 `!stale && !pending` 提前返回「正常」，故 availability 呈现 MUST 先于/独立于该分支求值）。停售行置灰后的正文文字 MUST 仍满足对比度 ≥4.5:1（状态由「已停售」徽标 + 删除线承载，置灰仅为装饰降权）。

#### 场景:停售方案降权且不参与最划算
- **当** 一个 plan 的 `availability=discontinued`
- **那么** 该行显「已停售」徽标、整行置灰且月价删除线、无最佳周期徽标，且不被评为该组「最划算」

#### 场景:未知生命周期显次级态
- **当** 一个 plan 的 `availability=unknown` 且该 plan 既不陈旧也不待复核（现有状态格会对此提前返回「正常」）
- **那么** 仍显次级「状态未知」标识、MUST NOT 因命中「正常」提前返回而被吞掉

#### 场景:在售方案不出生命周期标
- **当** 一个 plan 的 `availability=on_sale`
- **那么** 不渲染任何 availability 徽标

### 需求:季/年付周期价必须逐条可溯源且新鲜度纳入 plan 聚合

比价页 MUST 为每条季/年付周期价在溯源展开区列出独立的 provenance 行，含 `source_url`（经 `safeHref` scheme 闸，危险 scheme 降级纯文本）、`source_confidence` 与 per-fact age 徽标。周期价的 `last_checked` MUST 纳入该 plan「最旧事实」新鲜度徽标的计算。价格格内的周期子行 MUST NOT 各自内联 age 徽标（新鲜度由新鲜度列的 plan 最旧徽标与溯源展开区逐条覆盖）。

#### 场景:溯源区逐条列出周期价来源
- **当** 展开一个含已核年付价的 plan 的「溯源」
- **那么** 展开区出现独立「年付价」行，含经 scheme 闸的来源链接、置信度与 age 徽标

#### 场景:周期价新鲜度纳入 plan 最旧徽标
- **当** 一个 plan 的年付价 `last_checked` 早于其它所有事实
- **那么** 该 plan「数据新鲜度」列的最旧徽标反映该年付价的核对日
