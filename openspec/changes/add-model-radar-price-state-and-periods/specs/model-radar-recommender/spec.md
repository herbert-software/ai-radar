## MODIFIED Requirements

### 需求:规则硬筛召回经 vetted money-path、currency/budget 均不喂 query、未核/待核标 insufficient_data

推荐器的候选召回**必须**经既有 `queryModelRadarSnapshot`（按 `modelRadarQueryParamsSchema`：model `family:version` / tool / protocol 过滤 + 同桶同币种排序 + cheapest），**禁止**在裸快照上手搓过滤/cheapest（绕 vetted 守卫）。本期只向 query 注入 `{category='coding_plan', model?, tool?, protocol?}`。价格/兼容/额度是 DB 精确事实——**规则不离谱、DB 保事实**。

**`currency` 与 `maxMonthlyPrice`(预算)均不喂 query**——二者都是推荐器的**分类/判级**维度，喂给 query 会在召回前剔除候选、令对应 verdict 永空：
- `query.ts` 的 `currency` 过滤排除**所有** `priceStatus≠known` plan（`p.priceStatus!=='known'` 短路），故喂 currency 会令 `insufficient_data`（未核/待核）候选**召回前消失**；
- `maxMonthlyPrice` 过滤排除超预算 plan，故喂预算会令 `not_recommended`（超预算）候选**召回前消失**。

正确做法：query 只按 model/tool/protocol/category 硬筛「含目标模型/工具」的候选集（含已知价各币种组 + `sortScope.currency=null` 未知价组）；**币种选组**（取请求 `currency`、默认 `CNY` 的已知价组用于排名/cheapest）与**预算判级**（数值比对 `plan.currentPrice`）都在推荐器内做。

**候选集 + 预算判级须锁定单一币种组（FX 红线）**：因 currency 不喂 query、召回会含**他币种**已知价组，推荐器的候选集**必须**= 请求币种（默认 CNY）已知价组 ∪ `currency=null` 未知价组；**他币种已知价 plan 一律剔除**（FX「不跨币比较」非目标，绝不用裸数值 `maxMonthlyPrice` 跨币比 `currentPrice`），可附「另有 N 个他币种 plan（未比）」说明。预算判级 `currentPrice > maxMonthlyPrice` 因此恒在**同一币种**内做；`maxMonthlyPrice` 缺省 → 不施预算约束（不依赖 `> undefined→NaN→false` 隐式语义、显式判「无预算」）。`availability='discontinued'` 的候选仍可被召回并返回，但不得成为 primary。

#### 场景:按 model + tool 召回经 vetted 查询、currency/budget 不喂 query
- **当** 请求「含 GLM-4.6 且支持 Claude Code、currency=CNY、预算 ¥100」的 coding_plan 推荐
- **那么** 候选经 `queryModelRadarSnapshot`（仅 model=`glm:4.6`、tool=`claude-code`、category=coding_plan）取得；不把 `currency`/`maxMonthlyPrice` 喂给 query；推荐器从返回 groups 取 CNY 已知价组排名、对 `plan.currentPrice` 数值判预算

#### 场景:未核价 / 待核被召回并标 insufficient_data
- **当** 某候选 plan 价格未核（`priceStatus≠known`，落 `sortScope.currency=null` 未知价组）或带待复核 flag（`reviewStatus.pending=true`），且 `availability!='discontinued'`
- **那么** 因 currency 未喂 query，它**仍被召回**；推荐器标其 `insufficient_data`（待核态）、不参与「最便宜」首选；文案如实标待核，**不**冒充已核
- **且** 本变更已在快照 DTO 增加 `availability`，故停售不再靠 NULL 价占位暗示；`availability='discontinued'` 走明确停售规则

#### 场景:停售候选被召回但不作首选
- **当** 某候选 `availability='discontinued'`
- **那么** 因召回不按 availability 预过滤，它仍出现在 candidates 中；verdict 必须为 `not_recommended`，不参与 primary

### 需求:推荐输出 flat candidates + 四态 ordered-total verdict + stale、空结果按落选缘由各诚实返

推荐输出**必须**是结构化对象并经 Zod 校验：`{ query, candidates: RankedCandidate[], explanation }`——`candidates` 是**扁平数组**（每条带 `verdict` 字段，**非** `{首选,备选,...}` 分桶数组）。`RankedCandidate` 含 `planId`/`monthlyCost`(未核为 null)/`currency`(未核为 null)/`priceStatus`/`availability`(取自 snapshot plan)/`stale: boolean`(取自 snapshot plan 级 `freshness.stale`)/`fitsWindow`/`verdict`/`reasons`/`provenance`——**candidates 全由规则 + DB 事实定**。若 snapshot 提供已核季/年付，候选 `reasons` 必须能标最佳周期。

`verdict` 四态必须由有序全覆盖判定产出（每候选恰好一态、无重叠无空洞）：

0. `availability='discontinued'` → `not_recommended`（reason=「已停售」，优先于未核/价/撞窗；停售是确定不可订，不是数据不足）；
1. 否则 `priceStatus≠known` 或 `reviewStatus.pending=true` → `insufficient_data`（待核态：未核/待核，不含停售占位）；
2. 否则已核价但 `plan.currentPrice > maxMonthlyPrice`（**同币种内比、含界 `>`、缺省预算视为无约束**）或 `fitsWindow='exceeds'` → `not_recommended`；
3. 否则（已核 + 非待核 + 非停售 + 不超预算 + `fitsWindow≠exceeds` = **eligible**）中**最低 canonical 月价**者 → `primary`（= eligible 子集里 cheapest——取请求币种组经 query 升序排好的首个 eligible；**不另手搓排序**；裸 query cheapest 若被预算/exceeds/停售淘汰则顺延次低 eligible，不致 candidates 中无 `verdict='primary'` 者而有可选）；
4. 其余 eligible → `alternative`（catch-all：eligible 非最低价者，如次低 / 不撞窗但更贵；**注意** `fitsWindow=unknown` 仍属 eligible，故「更便宜但撞窗未知」者会成 `primary`（带「口径未知」警示），**不**降为 `alternative`）。

候选若有最佳周期（在 canonical 月价与已核季/年有效月价中取最低），推荐文案/`reasons` 必须标该 plan 的最佳周期，并标「含预付/锁期」；最佳周期是附加信息，不改 cheapest/月价排名。Token Plan 不生成最佳周期。

**空结果（candidates 中无 `verdict='primary'` 者，条件 = eligible 集为空、各诚实不空手不编候选）**——按已召回候选的**落选缘由组合**给信息：
- **空召回**（无 plan 含目标 model/tool/protocol）→ 按 **tool→protocol→model** 维度二次 query（**不**含预算/currency——二者本就不是召回过滤器）得「放宽 X 有 N 个」；
- **0 eligible 且有候选**（含「全停售」「全 `insufficient_data`」「全 `not_recommended`」及任意**混合**）→ candidates 中无 `verdict='primary'` 者 + 据落选缘由组合给说明：有停售 → 列「N 个已停售」；有 `insufficient_data` → 列「N 个待核」；有「超预算」not_recommended → 「放宽预算到 ¥X 有 N 个」（对已召回集**数值重核**、非二次 query）；有「`exceeds`」not_recommended → 「降低用量档 / 额度不足」（**不**误导为放宽预算）。涵盖任意混合，不留未定义空洞。

#### 场景:推荐输出 flat candidates 经 schema 校验、四态有序全覆盖、含 availability/stale
- **当** 推荐器对一组候选产出结果
- **那么** 输出 `candidates: RankedCandidate[]`（扁平、每条带 verdict + availability + stale + monthlyCost 可空）经 Zod 校验；verdict 经有序判定（停售 > 待核 > 不推荐 > 首选 > 备选）每候选恰一态；未核价候选标 `insufficient_data`（非 `not_recommended`）

#### 场景:已停售明确不荐、不冤为未核
- **当** 某候选 `availability='discontinued'`（无论其价已核否、是否 pending）
- **那么** 该候选 verdict=`not_recommended` + reason=「已停售」，不标 `insufficient_data`

#### 场景:候选标最佳周期、不改月价排名
- **当** 某 eligible 候选月付 ¥49、年付 ¥468（有效月价 ¥39）
- **那么** 其 `reasons`/文案标「最佳周期=年付，有效月价 ¥39（含预付锁期）」；该候选在排名中仍按月价 ¥49 参与 primary/alternative 判定

#### 场景:空结果各诚实返不空手（含停售混合落选）
- **当** ① 无候选含目标 model/tool；或 ② 召回非空但 eligible 集为空，且候选混合包含已停售、待核、超预算或 exceeds
- **那么** ① 返「放宽 tool/protocol/model → N 个」（不放宽预算/currency）；② explanation 按组合列出「已停售 N 个 / 待核 N 个 / 超预算→放宽预算到 ¥X / exceeds→降用量档」，覆盖任意混合；皆不返空、不编候选

### 需求:解释层 v1 为模板、带规则依据 + provenance、LLM 不参与、接口对 v2 留证据缝

v1 解释层**必须**是**模板**（固定话术填候选事实 + 命中/落选的规则原因 + per-fact `source_url`/`lastCheckedDate`/`source_confidence`）；**LLM/RAG 不参与 v1**（tech-plan 已锁）。每条首选/备选/不推荐/待核**必须**给「为什么」的规则依据（如「含 GLM-4.6 ✓、Claude Code ✓、¥49/月、额度口径未知不保证不撞窗」、若 `discontinued` 则明确「已停售」、若有最佳周期则明确「最佳周期=年付/季付，有效月价 ¥X，含预付锁期」）+ 可溯源链接。

解释层接口**必须**为 `ExplanationInput → Promise<explanation>`，其中 `ExplanationInput { query, candidates: RankedCandidate[], evidence?: unknown }`（规则原因已在每条 `RankedCandidate.reasons` 内、**不**另设顶层 `ruleReasons` 冗余字段；`evidence` 槽 v1 类型 `unknown`、不预钉 RAG 形状）——v1 模板**忽略** `query`/`evidence`、同步 resolve 字符串；v2 LLM 经**同一接口**消费 `evidence`(RAG 证据)、**召回与候选 schema 不变**。即 v1 接口 = v2 接口，杜绝换层重构。

#### 场景:停售与最佳周期话术含规则原因 + 可溯源、无 LLM
- **当** 模板解释层渲染已停售候选或带年付最佳周期的候选
- **那么** 话术含 `RankedCandidate.reasons` 中的「已停售」或「最佳周期」原因 + 月成本 + 撞窗结论（估算则标警）+ `source_url`/`lastCheckedDate` 依据；不调用任何 LLM；接口签名 `ExplanationInput{query,candidates,evidence?:unknown} → Promise<explanation>`（v1 忽略 query/evidence）
