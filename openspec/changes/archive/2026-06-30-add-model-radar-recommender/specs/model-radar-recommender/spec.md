## 新增需求

### 需求:规则硬筛召回经 vetted money-path、currency/budget 均不喂 query、未核/待核标 insufficient_data

推荐器的候选召回**必须**经既有 `queryModelRadarSnapshot`（按 `modelRadarQueryParamsSchema`：model `family:version` / tool / protocol 过滤 + 同桶同币种排序 + cheapest），**禁止**在裸快照上手搓过滤/cheapest（绕 vetted 守卫）。本期只向 query 注入 `{category='coding_plan', model?, tool?, protocol?}`。价格/兼容/额度是 DB 精确事实——**规则不离谱、DB 保事实**。

**`currency` 与 `maxMonthlyPrice`(预算)均不喂 query**——二者都是推荐器的**分类/判级**维度，喂给 query 会在召回前剔除候选、令对应 verdict 永空：
- `query.ts` 的 `currency` 过滤排除**所有** `priceStatus≠known` plan（`p.priceStatus!=='known'` 短路），故喂 currency 会令 `insufficient_data`（未核/待核）候选**召回前消失**；
- `maxMonthlyPrice` 过滤排除超预算 plan，故喂预算会令 `not_recommended`（超预算）候选**召回前消失**。

正确做法：query 只按 model/tool/protocol/category 硬筛「含目标模型/工具」的候选集（含已知价各币种组 + `sortScope.currency=null` 未知价组）；**币种选组**（取请求 `currency`、默认 `CNY` 的已知价组用于排名/cheapest）与**预算判级**（数值比对 `plan.currentPrice`）都在推荐器内做。

**候选集 + 预算判级须锁定单一币种组（FX 红线）**：因 currency 不喂 query、召回会含**他币种**已知价组，推荐器的候选集**必须**= 请求币种（默认 CNY）已知价组 ∪ `currency=null` 未知价组；**他币种已知价 plan 一律剔除**（FX「不跨币比较」非目标，绝不用裸数值 `maxMonthlyPrice` 跨币比 `currentPrice`），可附「另有 N 个他币种 plan（未比）」说明。预算判级 `currentPrice > maxMonthlyPrice` 因此恒在**同一币种**内做；`maxMonthlyPrice` 缺省 → 不施预算约束（不依赖 `> undefined→NaN→false` 隐式语义、显式判「无预算」）。

#### 场景:按 model + tool 召回经 vetted 查询、currency/budget 不喂 query
- **当** 请求「含 GLM-4.6 且支持 Claude Code、currency=CNY、预算 ¥100」的 coding_plan 推荐
- **那么** 候选经 `queryModelRadarSnapshot`（仅 model=`glm:4.6`、tool=`claude-code`、category=coding_plan）取得；**不**把 `currency`/`maxMonthlyPrice` 喂给 query；推荐器从返回 groups 取 CNY 已知价组排名、对 `plan.currentPrice` 数值判预算

#### 场景:未核价 / 待核（含停售）被召回并标 insufficient_data
- **当** 某候选 plan 价格未核（`priceStatus≠known`，落 `sortScope.currency=null` 未知价组，如腾讯混元停售占位 NULL 价）或带待复核 flag（`reviewStatus.pending=true`）
- **那么** 因 currency 未喂 query，它**仍被召回**；推荐器标其 `insufficient_data`（待核态）、不参与「最便宜」首选；文案如实标待核，**不**冒充已核
- **且** v1 快照 DTO 仅暴露 `reviewStatus.pending` 布尔、**不区分**「已停售」与普通「待核价」（无 `discontinued`/flag-reason 字段）；故 v1 一律按「待核(含停售)不作首选、如实标待核」处理，「停售专属文案」是 compare-api DTO 后续增量（本期**已声明的已知缺口**）

### 需求:撞窗判定经 snapshot 层纯数值原语、按 limitType 分派、空限额/口径未知不假装

撞窗判定**必须**落在 snapshot 层原语 `src/mr/snapshot/limits.ts` 的 `fitsWindow(limits, demandedRounds: number, tokensPerRound: number) → 'fits' | 'exceeds' | 'unknown'`——**纯数值入参**（不含 `usageProfile` 等推荐器词汇、不 import `src/mr/web/`），`usageProfile`(轻/中/重) → `{demandedRounds, tokensPerRound}` 的映射归 `src/mr/recommend/` 自持。原语由 render 页与推荐器**同消费**（推荐器**不**反向依赖 web 层）。把 5d-B `estimateRounds` 的估算核心（含 `ESTIMATE_SPREAD`/`DEFAULT_TOKENS_PER_ROUND`）下沉至此；render 页保留 UI 旋钮（`TOKENS_PER_ROUND_OPTIONS`/`resolveTokensPerRound`）、改 import 估算核心。

判定**按 `limitType` 分派**（6 arm 全枚举，**先判 `limitType`、`none` 在任何 `value===null→unknown` 兜底之前命中**）：

- `limitType==='none'`（恰一行 `{value:NULL, window:'none'}` = 不限）→ **`fits`**（唯一可判「不撞窗」的 NULL 值情形）；
- `monthly_tokens` 且 `value` 非 NULL → 估算 afforded 轮次（`额度 ÷ tokensPerRound`，±50% 带）比对 `demandedRounds` → `demandedRounds ≤ low`→`fits`、`≥ high`→`exceeds`、落带内→**`unknown`**；
- `rolling_5h_requests` / `weekly_messages` → v1 **`unknown`**（月用量→突发 5h 速率窗 / 月→周无诚实换算，类别错误）；
- `credit` / `fast_pass`（口径异构）→ **`unknown`**；
- 任意真限额 `value` 为 NULL（占位/未录入，**非** `none`）→ **`unknown`**（绝不据 NULL 报「不撞窗」）。

**多限额取最紧**：plan 带多条限额时 `fitsWindow` 聚合 = 任一 `exceeds`→`exceeds`；否则任一 `unknown`→`unknown`；全 `fits`→`fits`。**空 `limits[]`（零限额事实）→ `unknown`**（聚合恒等元为 `unknown`、**绝不**因「无 exceeds 无 unknown」而 vacuous 判 `fits`）。撞窗结论是 **⚠ 估算**（非官方事实），文案明示、绝不进任何哈希/事实。

> **v1 现状如实**：5d-C 桶2 6 家 coding_plan 限额全为 `rolling_5h_requests`/`credit`/`fast_pass` 且 `value:NULL`（无 `monthly_tokens`），故**现数据下 `fitsWindow` 对所有候选均为 `unknown`**。这是 accepted-degraded：能判则估、不能判则如实标「额度口径未知、不保证不撞窗」，**绝不**伪造 fits/exceeds。含非 NULL `monthly_tokens` 的 plan 入库后同一原语自动产出。

#### 场景:monthly_tokens 非 NULL 按用量档估撞窗
- **当** 候选带 `monthly_tokens`（`value` 非 NULL）限额、请求「重度用」（recommender 映射为 `{demandedRounds, tokensPerRound}`）
- **那么** `fitsWindow` 经 `额度 ÷ tokensPerRound`(±50%) 比对 `demandedRounds`，标 `fits`/`exceeds`（⚠ 估算）；落带内→`unknown`；撞窗候选降级或标警

#### 场景:异构口径 / NULL 值 / 空限额 / rolling·weekly 不假装能判
- **当** 候选限额为 `credit`/`fast_pass`、或真限额 `value` 为 NULL、或 `rolling_5h_requests`/`weekly_messages`、或 `limits[]` 为空
- **那么** `fitsWindow` 输出 `unknown`、文案标「额度口径未知、不保证不撞窗」，**不**伪造 fits/exceeds（空限额亦绝不 vacuous 判 `fits`）；仅 `limitType==='none'` 才报 `fits`

### 需求:推荐输出 flat candidates + 四态 ordered-total verdict + stale、空结果按落选缘由各诚实返

推荐输出**必须**是结构化对象并经 Zod 校验：`{ query, candidates: RankedCandidate[], explanation }`——`candidates` 是**扁平数组**（每条带 `verdict` 字段，**非** `{首选,备选,...}` 分桶数组）。`RankedCandidate` 含 `planId`/`monthlyCost`(未核为 null)/`currency`(未核为 null)/`priceStatus`/`stale: boolean`(取自 snapshot plan 级 `freshness.stale`)/`fitsWindow`/`verdict`/`reasons`/`provenance`——**candidates 全由规则 + DB 事实定**。

`verdict` 四态**必须**由**有序全覆盖判定**产出（每候选恰好一态、无重叠无空洞）：

1. `priceStatus≠known` **或** `reviewStatus.pending=true` → **`insufficient_data`**（待核态：未核/待核/含停售占位；不冤判「不推荐」、沿用比价页「数据不足」诚实）；
2. 否则 已核价但 `plan.currentPrice > maxMonthlyPrice`（**同币种内比、含界 `>`、缺省预算视为无约束**）**或** `fitsWindow='exceeds'` → **`not_recommended`**；
3. 否则（已核 + 非待核 + 不超预算 + `fitsWindow≠exceeds` = **eligible**）中**最低价**者 → **`primary`**（= eligible 子集里 cheapest——取请求币种组经 query 升序排好的首个 eligible（**不另手搓排序**）；裸 query cheapest 若被预算/exceeds 淘汰则顺延次低 eligible，不致 candidates 中无 `verdict='primary'` 者而有可选）；
4. 其余 eligible → **`alternative`**（catch-all：eligible 非最低价者，如次低 / 不撞窗但更贵；**注意** `fitsWindow=unknown` 仍属 eligible，故「更便宜但撞窗未知」者会成 `primary`（带「口径未知」⚠ 警），**不**降为 `alternative`）。

**空结果（candidates 中无 `verdict='primary'` 者，条件 = eligible 集为空、各诚实不空手不编候选）**——按已召回候选的**落选缘由组合**给信息：
- **空召回**（无 plan 含目标 model/tool/protocol）→ 按 **tool→protocol→model** 维度二次 query（**不**含预算/currency——二者本就不是召回过滤器）得「放宽 X 有 N 个」；
- **0 eligible 且有候选**（含「全 `insufficient_data`」「全 `not_recommended`」及二者**混合**）→ candidates 中无 `verdict='primary'` 者 + 据落选缘由组合给说明：有 `insufficient_data` → 列「N 个待核」；有「超预算」not_recommended → 「放宽预算到 ¥X 有 N 个」（对已召回集**数值重核**、非二次 query）；有「`exceeds`」not_recommended → 「降低用量档 / 额度不足」（**不**误导为放宽预算）。涵盖任意混合，不留未定义空洞。

#### 场景:推荐输出 flat candidates 经 schema 校验、四态有序全覆盖、含 stale
- **当** 推荐器对一组候选产出结果
- **那么** 输出 `candidates: RankedCandidate[]`（扁平、每条带 verdict + stale + monthlyCost 可空）经 Zod 校验；verdict 经有序判定（待核 > 不推荐 > 首选 > 备选）每候选恰一态；未核价候选标 `insufficient_data`（非 `not_recommended`）

#### 场景:空结果各诚实返不空手（含混合落选）
- **当** ① 无候选含目标 model/tool；或 ② 召回非空但 eligible 集为空（任意 `insufficient_data` / `not_recommended` 组合，含二者混合）
- **那么** ① 返「放宽 tool/protocol/model → N 个」（不放宽预算/currency）；② 返 candidates 中无 `verdict='primary'` 者 + 据落选缘由组合给说明（待核 N 个 / 超预算→放宽预算到 ¥X / exceeds→降用量档），覆盖任意混合无空洞；皆不返空/不编候选

### 需求:解释层 v1 为模板、带规则依据 + provenance、LLM 不参与、接口对 v2 留证据缝

v1 解释层**必须**是**模板**（固定话术填候选事实 + 命中/落选的规则原因 + per-fact `source_url`/`lastCheckedDate`/`source_confidence`）；**LLM/RAG 不参与 v1**（tech-plan 已锁）。每条首选/备选/不推荐/待核**必须**给「为什么」的规则依据（如「含 GLM-4.6 ✓、Claude Code ✓、¥49/月、额度口径未知不保证不撞窗」）+ 可溯源链接。

解释层接口**必须**为 `ExplanationInput → Promise<explanation>`，其中 `ExplanationInput { query, candidates: RankedCandidate[], evidence?: unknown }`（规则原因已在每条 `RankedCandidate.reasons` 内、**不**另设顶层 `ruleReasons` 冗余字段；`evidence` 槽 v1 类型 `unknown`、不预钉 RAG 形状）——v1 模板**忽略** `query`/`evidence`、同步 resolve 字符串；v2 LLM 经**同一接口**消费 `evidence`(RAG 证据)、**召回与候选 schema 不变**。即 v1 接口 = v2 接口，杜绝换层重构。

#### 场景:首选话术含规则原因 + 可溯源、无 LLM
- **当** 模板解释层渲染首选候选
- **那么** 话术含 `RankedCandidate.reasons` 规则原因 + 月成本 + 撞窗结论（⚠ 估算）+ `source_url`/`lastCheckedDate` 依据；不调用任何 LLM；接口签名 `ExplanationInput{query,candidates,evidence?:unknown} → Promise<explanation>`（v1 忽略 query/evidence）

### 需求:经 MCP 单工具暴露、env-clean 动态取快照、native raw-shape、只读 fail-closed、stale 下游可见

推荐器**必须**经既有 MCP server（`src/mcp/`，同 P4 进程/鉴权模式）暴露**单工具** `recommend_coding_subscription({model?, tool?, protocol?, currency?, maxMonthlyPrice?, usageProfile?})`（v1**不**新增 `search_coding_plans`：与 `/model-radar/plans` 检索重复、且「桶2 gate」抵触架构红线「检索横切所有桶」；横切检索归 compare-api 后续）。

**env-clean 取快照（避 parseEnv 装载崩溃，真正可用非仅 boot 不崩）**：MCP 进程只有 `DATABASE_URL`（`src/mcp/env.ts` 宽松解析），而 `buildModelRadarSnapshot`(`build.ts`) **顶层 static-import** `db/index.ts`(→`config/env.ts:491` `parseEnv`，require `TELEGRAM_*`/`PRODUCT_HUNT`) 与 `config/env.ts`；`await import` 它会在**首次调用时**跑全局 `parseEnv` 抛错 → 工具每次 fail-closed（**仅 defer 崩溃、不避免**）。故**必须**令 **`build.ts` env-clean**（仿 `src/mcp/db.ts` 只 import `db/schema.ts` 的纪律），具体两处（**`tsconfig` 开 `verbatimModuleSyntax: true`：非 `import type` 语句即便仅用于 `typeof` 也运行期保留、tsc 静默不报**）：
- `build.ts:31` `import { db as defaultDb }`（仅 `type DbLike = typeof defaultDb` 用）→ 改 **`import type`**（运行期擦除），或仿 `src/mcp/db.ts` 把 `DbLike` 重定义为 `McpDb`（彻底不 import `db/index.ts`）；
- `build.ts:32` `import { env }`（仅 `thresholdDays = env.MR_STALENESS_THRESHOLD_DAYS` 默认用，`dbh` 本已必填）→ 删 import、`thresholdDays` **改必填参**。

**`cache.ts` 不动其对 `db/index.ts` 的 `defaultDb` 默认**（它只在 app 进程跑、MCP 不 import 它）——只须把 `env.MR_STALENESS_THRESHOLD_DAYS` 显式喂给 `buildFn`：`SnapshotBuildFn`(`cache.ts:40`) 增 `thresholdDays` 参、`cache.ts:100` 调 `buildFn(dbh, now, threshold)`。故 cache.ts 的 app 调用方（`model-radar-page.tsx:43` / `api/model-radar.ts:24` / `background.ts:34` / `rebuild.ts:68` 链）**签名不变、零改动**。MCP handler **动态 import env-clean 的 `build.ts`**、传 `getContext().db` + 显式 `thresholdDays`，**每次调用现 build**（不经 cache.ts 的每进程缓存）。`MR_STALENESS_THRESHOLD_DAYS` 须**加入 `mcpEnvSchema`**（与 app `config/env.ts` 同口径/同默认、不硬编码常量、防 stale 口径漂移）。

**纪律守护须升级**（既有 `src/mcp/__tests__/query-chain-env.test.ts` 只验 `tools/index.ts` **装载期**顶层 import、`allTools.length === 7`）：① 第 8 个工具使 `length !== 7` 断言变红 → 须 **7→8** 并把 `recommend-coding.ts` 加入静态 grep 禁顶层 import（`cache.js`/`build.js`/`db/index.js`/`config/env.js`）的文件清单；② 装载期测**抓不到** handler 运行期 `await import('build.js')` 的 parseEnv 崩溃 → 须另写一个**剪裁 env（仅 DATABASE_URL）子进程实跑 getter**的测，证「首次调用不崩」。

读路径**只读**、**不写任何 `mr_*`**；冷启动/快照不可用 → **fail-closed**（返结构化错，**绝不**编推荐）。

工具入参用 **native ZodRawShape**（**非**透传 `modelRadarQueryParamsSchema`，那不是 raw shape 且会把 HTTP-query 串如「"100 CNY"」漏给客户端），每参带 `.describe()` **并枚举合法值**（`model`=`family:version`、`tool`/`protocol`（其值为 clientId，大小写敏感精确匹配）、`currency`=`mrCurrencySchema` 枚举集、`usageProfile`=`light|medium|heavy`），handler 内 `.parse()`；`maxMonthlyPrice` 为 `z.number().nonnegative().finite()`（纯数值判级、与 `plan.currentPrice` **同币种**比对，**不**格式化为任何 money-path 串）。输出走 `CallToolResult`（声明 `outputSchema` + 回 `structuredContent` + `content[].text`、含 `stale`），声明 `readOnlyHint`。

**陈旧如实**：因 MCP **每次调用现 build**（不缓存）→ 无 frozen-until-restart 之忧，快照随调随新；唯一陈旧来源是底层数据 `last_checked`，由每条候选带的 plan 级 `stale` 标如实暴露（下游 agent 据此不把陈旧价当现价）。**不**宣称「含 5d-A 实时失效」（订阅器未装配、亦无需——现 build 本就最新）。

#### 场景:recommend_coding_subscription env-clean 取快照返结构化推荐
- **当** 从 MCP 客户端（Claude/Cursor）调 `recommend_coding_subscription`（model=glm:4.6, tool=claude-code, currency=CNY, usageProfile=heavy）
- **那么** handler 动态 import **env-clean 的 `build.ts`**（传 `getContext().db` + 显式 thresholdDays、`import type` 化后**不**触 `db/index.ts`/`config/env.ts` 的 parseEnv）现 build 快照，返结构化「首选/备选/不推荐/待核 + 月成本 + 撞窗 + stale + 依据」（`structuredContent`+`content[].text`、`readOnlyHint`）；只读、不写库

#### 场景:快照不可用 fail-closed
- **当** 冷启动快照构建失败、推荐请求到达
- **那么** MCP 工具返结构化错误（如 snapshot unavailable），**不**返编造/降级的假推荐
