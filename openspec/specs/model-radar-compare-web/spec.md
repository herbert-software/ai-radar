# model-radar-compare-web 规范

## 目的
Model Radar（P5 / 5d-B）Web 比价页：项目首个公开只读 Web 前端。由 Hono JSX 服务端渲染，数据只经既有 `getModelRadarSnapshot()` 取只读快照（不查规范化 `mr_*`、不写库、不 bump version），在浏览器内 10 秒答四问（谁含某模型 / 谁支持某工具协议 / 同档谁最划算 / 谁最近被核对或最陈旧）且每格可溯源。陈旧（plan 级聚合）与 age（per-fact `lastCheckedDate`）徽标按各自粒度诚实呈现；估算轮次做成带旋钮区间、视觉次于官方额度、挂 ⚠ 估算；未核价显式占位、不参与「最划算」、披露未参与数。作为首个公开页强制输出编码与 `source_url` scheme 闸（防存储型 XSS）+ CSP，本期 UI gate 到桶2（coding_plan），并满足 WCAG 2.2 AA（原生语义优先）。比价/检索 API（model-radar-compare-api）、只读快照构建（同上）不在本规范。
## 需求
### 需求:只读 SSR 比价页从快照渲染、不查规范化表、不写库

比价页必须由 Hono JSX（`hono/jsx`）**服务端渲染**，数据**只**经既有 `getModelRadarSnapshot()`（冷启动 build-from-DB、fail-closed）取快照；**禁止**查规范化 `mr_*` 表、**禁止**任何写库或 bump version；不引 SPA/React/打包器、不做登录鉴权（公开只读）。**页面每请求以 live `render_now` 重渲，禁止用 snapshot version 作 HTML 的 ETag/304**——HTML 含 render-time 派生的相对 age（「N 天前」），version-304 会在快照未变而日界已过时服务陈旧 age（304-with-stale-render，违下「诚实呈现新鲜度」）；JSON `/model-radar/snapshot` API 的内容哈希 ETag 不受本页影响、照旧。冷启动首建失败必须返回 503（沿用 5c fail-closed），禁止渲染坏快照。

#### 场景:页面只读渲染、不触发写
- **当** 浏览器请求比价页
- **那么** 服务端经 `getModelRadarSnapshot()` 取快照并 SSR 出 HTML；`mr_*` 与既有表无任何写、version 不被 bump

#### 场景:HTML 页不挂 version-304、age 始终 live
- **当** 快照一周未变（version 不变）但已跨数个 UTC 日界，浏览器再次请求
- **那么** 页面以当日 `render_now` 重渲、age 文案随之更新（如「🟡 3 天前」），不返回 304-with-stale 的「🟢 今日」

#### 场景:冷启动首建失败 fail-closed
- **当** 进程冷缓存下快照首建失败（DB 不可达等）
- **那么** 页面返回 503，而非渲染空/坏快照

### 需求:比价页必须能在浏览器 10 秒内答四问且每格可溯源

页面必须支持回答四问：①谁含某模型（如 GLM-5.2）②谁支持某工具/协议（如 Claude Code）③同档谁最划算 ④**谁最近被核对 / 谁最陈旧**（按 per-fact `lastCheckedDate` / `stale`——快照不含价格变更时间线，故本期不答「谁最近变价」，见非目标）。必须提供筛选 chips（model / tool / protocol / currency / budget，query 参数、渐进增强、无 JS 可用）。**价格排序与「最划算」必须经既有 `queryModelRadarSnapshot(snapshot, params)`** 取 per-group `cheapestPlanId`/`comparable`/`unknownCount`——**禁止**在裸快照对象上手搓 cheapest（绕过守「未知价不入 cheapest / NULL 不当 0 / 同 (category,currency) 分组」的 vetted 函数）。**调用边界**：`getModelRadarSnapshot()` 返回 `{snapshot,version}`、须传 `.snapshot`；只把 API 子集喂 `.strict()` `modelRadarQueryParamsSchema`（ZodError→400），估算旋钮/Q4 排序等 web-only param 留 schema 外、render 层用。**Q4「最近被核对/最陈旧」排序是 render 层对 per-fact `lastCheckedDate` 的重排**（取 plan 最旧 fact date 作键，不经 `queryModelRadarSnapshot`、不入 DTO/哈希、不碰 money-path）。render 对 `currentPrice=null` 必须显式占位、**禁止** format（防 SSR NPE）。每条价/兼容/额度事实必须可溯源——展开后呈现该事实的 `source_url`、`lastCheckedDate`（render 为 age 徽标）、`source_confidence`。

#### 场景:按模型筛选答「谁含 GLM-5.2」
- **当** 用户选「含 GLM-5.2」chip
- **那么** 表只列含该模型的 plan，每行可展开看该兼容事实的来源

#### 场景:答「谁最近被核对 / 谁最陈旧」
- **当** 用户按核对新鲜度查看/排序
- **那么** 页面据 per-fact `lastCheckedDate` + plan 级 `stale` 呈现各 plan 的最近核对/陈旧状态（不声称呈现「最近变价」）

#### 场景:每格可溯源
- **当** 用户展开某 plan 的某条价/兼容/额度事实
- **那么** 呈现该事实的 `source_url` + age 徽标 + `source_confidence`，而非无出处的裸值

#### 场景:排序与最划算经 vetted 函数、不跨桶不跨币种
- **当** 用户按价排序或看「同档最划算」
- **那么** 结果来自 `queryModelRadarSnapshot` 的 per-(category,currency) `groups`/`cheapestPlanId`（未知价不入 cheapest），不在裸快照上手搓

### 需求:陈旧（plan 级）与 age（per-fact）徽标必须按各自粒度诚实呈现

**徽标分两层粒度，禁止混用**：① **plan 级** 🔴 待复核/陈旧——来自 `freshness.stale` / `reviewStatus.pending`（plan 级聚合，快照无 per-fact stale 字段）；**禁止**用 plan 级 stale 冒充某一格的 per-cell stale（会把一个 child 陈旧污染成整行所有格陈旧）。② **per-fact** 🟢 今日核对 / 🟡 N 天前——按该事实 provenance 的 `lastCheckedDate` 在 render 时算（`render_now − lastCheckedDate`）；关联源行 `lastCheckedDate` 为 null（从未抓的 browser 源）时显示「待核/从未核对」、**不**显示 🟢/🟡（且其 plan 经既有 stale 聚合判陈旧）。**禁止**把未知/陈旧伪装成新鲜。徽标**禁止仅靠颜色/emoji 承载状态**（见可访问性需求）。

#### 场景:plan 级 🔴 待复核
- **当** 某 plan 在快照中 `stale` 为 true 或 `reviewStatus.pending` 为 true
- **那么** 该 plan 显示 plan 级 🔴 待复核/陈旧标，而非把它当作某一格的 per-cell 状态

#### 场景:per-fact age 徽标
- **当** 某事实 provenance 的 `lastCheckedDate` 为今日 / N 天前
- **那么** 该格显示 🟢 今日 / 🟡 N 天前（render 时按 `render_now − lastCheckedDate` 算，不进哈希）

### 需求:估算中等任务轮次必须做成带旋钮区间、视觉次于官方额度、挂 ⚠ 估算

「估算中等任务轮次」必须由快照既供的限额事实 + 一个可调假设旋钮算出**区间**，**禁止引入快照之外的新事实**、**禁止**进内容哈希（旋钮值是 URL query 参数、在 render 层算）。渲染必须**视觉次于**官方原始额度并显式标 **⚠ 估算**。某 plan 限额 `value` 为 NULL（不限/占位）时必须优雅降级（不输出区间、不 NPE）。

#### 场景:估算区间标记为估算且次于官方额度
- **当** 页面展示某 plan 的估算轮次
- **那么** 显示为带 ⚠ 的区间、视觉次于官方原始额度，随旋钮假设仅在既供限额数据上重算；limit.value 为 NULL 时不输出区间

### 需求:未核价必须诚实呈现、不参与「最划算」、并披露未参与数

未核价（占位 NULL / `needs_login_recheck`）必须显式呈现为「待核」，**禁止**冒充已核 provenance、**禁止**纳入「同档最划算」判定。「最划算」= **已核价中最低**；若该档有 N 个未核价，必须并显「**另有 N 个未核价未参与**」（`unknownCount` 挂该 category 的 `currency=null` 组、已核币种组上恒 0，须**跨引该 null 组**取 N，勿读已核组上的 0）；**已核 <2 时不输出**最划算标签（标「待核」而非编造名次——须**数 plans.length≥2**，`comparable=true` 对单 plan 已核组也成立、仅凭 `comparable` 不足判）。

#### 场景:最划算披露未核数、不编造
- **当** 某档内已核价 ≥2 且另有 N≥1 个未核价
- **那么** 「最划算」标已核中最低 + 「另有 N 个未核价未参与」；若已核 <2，则不输出最划算、标「待核」

### 需求:首个公开页必须做输出编码与 href scheme 闸（防存储型 XSS）

页面把快照中的 DB 字符串渲进 HTML。所有快照串必须经 `hono/jsx` 默认转义，**禁止** `raw()` / `dangerouslySetInnerHTML`。`source_url` 渲为 `<a href>` 前**必须 gate scheme ∈ {`http`,`https`}**，否则**降级为纯文本**（fact-row provenance 的 `source_url` 录入侧仅过 `mrSourceUrlSchema`、不校 scheme，`javascript:`/`data:` 可入库 → 公开页直接渲链接即存储型 XSS）；scheme 闸还须拒含 userinfo 的 `https://good.com@evil.com`（仍 http(s) 但诱导误判主机的钓鱼向量）。响应必须挂 **CSP 头**（首个公开页基线 + 防 5d-C 流入抓取内容时的纵深）：`default-src 'none'` 收口未声明取数指令（object/connect/img/font… 全拦）+ `script-src 'self'`（脚本只同源）+ `style-src 'self' 'unsafe-inline'`（容内联 `<style>`，内联样式非 script-XSS 向量、页面无内联脚本）+ `base-uri 'none'`（防注入 `<base>` 劫持相对链接/表单）+ `form-action 'self'` + `frame-ancestors 'none'`（防点击劫持）。注意 `default-src 'none'` 配**显式** `style-src` 不拦内联 `<style>`（与禁 `default-src 'self'` 不矛盾——`'self'` 无 `'unsafe-inline'` 才会拦内联样式 → 裸样式 + 破自家 a11y CSS）。并把「复核 fact-row provenance `source_url` 录入是否应同样过 `assertUrlAllowed`」列为本变更 task（防御纵深）。

#### 场景:危险 scheme 的 source_url 降级纯文本
- **当** 某事实 provenance 的 `source_url` 为 `javascript:...` 或 `data:...`
- **那么** 页面渲染为纯文本、不生成可点 `<a href>`，且 CSP 头限制脚本来源

### 需求:本期页面必须 UI gate 到桶2（coding_plan）

数据跨桶入库，但本期页面必须 facet 到 `category==='coding_plan'`（多模型 Coding Plan，枚举字面）；其余桶不在本期 UI 暴露（v2 翻 tab）。gate 必须在 UI/查询层，**禁止**改数据层或删其它桶数据；chips 不含 category facet（用户无文档化手段切桶）。

#### 场景:页面只显 coding_plan
- **当** 用户访问比价页
- **那么** 仅 `category==='coding_plan'` 的 plan 可见；其它桶数据仍在库但本期 UI 不暴露

### 需求:比价页必须满足 WCAG 2.2 AA 可访问性（原生优先）

作为项目首个公开页，HTML 必须可被键盘与屏幕阅读器完整使用，**原生语义优先于 ARIA**：① 比价表必须是原生 `<table>` + `<caption>` + 列头 `<th scope="col">` + 行头（plan 名）`<th scope="row">`，**禁止** div-grid。② 行展开溯源必须键盘可达、无 JS 也可用——用原生 `<details>/<summary>` 或链接到展开态 URL；若用 JS toggle 则须 `<button aria-expanded aria-controls>`。③ 新鲜度/估算徽标**禁止仅靠颜色或 emoji**——必须含文字标签（今日核对/N 天前/待复核/⚠ 估算），emoji 作装饰（`aria-hidden`）。④ 排序经 query-param 链接：当前列 `<th aria-sort>`、排序控件有方向性可访问名（如「按价格升序」）。⑤ 筛选 chip 的已选态用 `aria-current`/`aria-pressed` + 文字标记、可键盘清除。⑥ 每个交互元素有**可见焦点指示**（焦点环对比 ≥3:1）。⑦ 文字对比 ≥4.5:1（含次级/估算/待核灰）。⑧ SSR 外壳：`<html lang="zh-Hans">`、描述性 `<title>`（随筛选反映当前态）、地标（`<nav>`/`<main>`/`<header>`）、跳到主内容 skip-link。⑨ 估算旋钮优先原生 `<input type="range">` 或 `<select>`（有 label、键盘可调、query-param 无 JS 回退）。⑩ **Reflow/Resize（1.4.10/1.4.4）**：宽比价表在 320px 宽下不得双向滚动、200% 文字 / 400% 缩放下无内容丢失/重叠——须给响应式策略（带键盘可滚的横向滚动容器或堆叠卡片，保留行/列头关联）。⑪ **目标尺寸（2.5.8，2.2 新增）**：chips / 排序控件 / `<summary>` 折叠 / range 拇指等交互目标 ≥24×24 CSS px（或满足间距例外）。⑫ **链接用途（2.4.4）**：`source_url` 的 `<a>` 须有描述性可访问名（如「查看来源」+ 站名），非裸 URL。⑬ **状态消息（4.1.3，仅 island 路径）**：若加无刷新重排 island，结果数/「无结果」变化须 `aria-live="polite"`/`role=status`；纯 SSR 整页刷新路径由 title/焦点承载、免此条。

#### 场景:屏幕阅读器可逐格读出比价表
- **当** 屏幕阅读器以表格模式浏览比价表
- **那么** 每格朗读出所属行头（plan）+ 列头（字段），徽标读出文字状态（如「待复核」）而非只读「圆圈」

#### 场景:键盘可达溯源与排序、有可见焦点
- **当** 用户仅用键盘 Tab 浏览
- **那么** 每个 chip / 排序控件 / 展开控件可聚焦（焦点可见）、可 Enter/Space 操作；禁用 JS 时溯源仍可达

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

