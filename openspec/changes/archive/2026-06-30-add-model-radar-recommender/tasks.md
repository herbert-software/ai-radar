## 1. 撞窗原语 + env-clean 化（snapshot 层；design D2/D5；行为等价）

- [x] 1.1 **下沉估算核心至 `src/mr/snapshot/limits.ts`**：把 `estimateRounds` + `ESTIMATE_SPREAD` + `DEFAULT_TOKENS_PER_ROUND` 从 `src/mr/web/render.ts` 移至此（纯函数、行为等价）；更新真实消费方 import——`src/mr/web/components.tsx`（现 estimateRounds 调用方）+ `render.test.ts`；UI 旋钮 `TOKENS_PER_ROUND_OPTIONS`/`resolveTokensPerRound` **留在 `render.ts`**（`<select>` 专属）
- [x] 1.2 **`fitsWindow(limits, demandedRounds: number, tokensPerRound: number) → 'fits'|'exceeds'|'unknown'`**（纯数值入参、无 `usageProfile` 词汇、不 import `src/mr/web/`）：按 `limitType` 分派（**先判 limitType，`none` 在任何 `value===null→unknown` 兜底前命中**）：`none`→`fits`；`monthly_tokens` 非 NULL→`额度÷tokensPerRound`(±50%) 比 `demandedRounds`（`≤low`→fits/`≥high`→exceeds/带内→unknown）；`rolling_5h_requests`/`weekly_messages`/`credit`/`fast_pass`/真限额 `value:NULL`→`unknown`
- [x] 1.3 **多限额取最紧 + 空限额诚实**：聚合 = 任一 `exceeds`→`exceeds`；否则任一 `unknown`→`unknown`；全 `fits`→`fits`；**空 `limits[]`→`unknown`**（聚合恒等元 = `unknown`，绝不 vacuous 判 `fits`）
- [x] 1.4 **env-clean 化 `build.ts`**（令快照读路径可在仅 `DATABASE_URL` 的 MCP 进程动态 import；`tsconfig verbatimModuleSyntax:true` → 仅 `typeof` 用的 import 也运行期保留、tsc 静默）：① `build.ts:31` `import { db as defaultDb }`（仅 `type DbLike=typeof defaultDb` 用）→ 改 **`import type`**（或仿 `src/mcp/db.ts` 把 `DbLike` 重定义为 `McpDb`、彻底不 import db/index）；② `build.ts:32` `import { env }`（仅 `thresholdDays=env.MR_STALENESS_THRESHOLD_DAYS` 默认用、`dbh:96` 本已必填）→ 删 import、`thresholdDays` 改必填参；③ `SnapshotBuildFn`(`cache.ts:40`) 增 `thresholdDays` 参、`cache.ts:100` 调 `buildFn(dbh,now,env.MR_STALENESS_THRESHOLD_DAYS)`（cache 只 app 进程跑、import env 无妨）；**cache.ts 4 个 app 调用方（`model-radar-page.tsx:43`/`api/model-radar.ts:24`/`background.ts:34`/`rebuild.ts:68` 链）签名不变零改**；④ 更新 build-stub 测（`cache.test.ts`/`background.test.ts` 的 stubBuild 等传 3 参）；⑤ `MR_STALENESS_THRESHOLD_DAYS` 加入 `mcpEnvSchema`（与 app 同口径、不硬编码）

## 2. 推荐器核心（`src/mr/recommend/`，纯函数可单测；design D1/D3/D4）

- [x] 2.1 输出 schema（Zod）：`RankedCandidate { planId, vendorName, name, monthlyCost: number|null, currency: string|null, priceStatus, stale: boolean, fitsWindow: 'fits'|'exceeds'|'unknown', verdict: 'primary'|'alternative'|'not_recommended'|'insufficient_data', reasons, provenance }` + `RecommendationResult { query, candidates: RankedCandidate[], explanation }`（candidates **扁平**、由规则+事实定；`stale` 取 snapshot plan 级 `freshness.stale`）
- [x] 2.2 **规则硬筛召回**：入参 `{model?, tool?, protocol?, currency?, maxMonthlyPrice?, usageProfile?}` → 向 query **只注入** `{category='coding_plan'(与 render 共享常量), model?, tool?, protocol?}` → `queryModelRadarSnapshot`（**不手搓 money-path**）取全部 groups；**`currency` 与 `maxMonthlyPrice` 都不喂 query**（currency 会排除所有未核价、budget 会排除超预算 → 召回前消失）；推荐器内**锁币种组**：候选集 = 请求 currency(默认 CNY)已知价组 ∪ `sortScope.currency=null` 未知价组，**他币种已知价 plan 一律剔除**（FX 非目标、绝不裸数值跨币比预算），可附「另有 N 个他币种 plan 未比」
- [x] 2.3 **撞窗判级**：`usageProfile`(`light`/`medium`/`heavy`) 映射 `{demandedRounds, tokensPerRound}`（recommender 自持、两正交旋钮）→ 对每候选调 `fitsWindow`（task 1.2）；标 **⚠ 估算**；**现数据全 `unknown`** 如实标「额度口径未知、不保证不撞窗」（不伪造）
- [x] 2.4 **四态有序全覆盖 verdict**（每候选恰一态）：① `priceStatus≠known` **或** `reviewStatus.pending=true` → `insufficient_data`；② 否则 已核 + (`currentPrice > maxMonthlyPrice`（`>`、含界、**同币种内**、缺省预算显式视为无约束、不依赖 `>undefined→NaN`）**或** `fitsWindow='exceeds'`) → `not_recommended`；③ 否则 eligible 中**最低价** → `primary`（= 取请求币种组经 query 升序排好的首个 eligible（**不另手搓排序**）、裸 cheapest 被淘汰则顺延次低 eligible、不致空首选）；④ 其余 eligible → `alternative`（**注** `fitsWindow=unknown` 属 eligible，「更便宜但撞窗未知」者成 `primary`+「口径未知」⚠ 警、不降 alternative）
- [x] 2.5 **空结果（candidates 中无 `verdict='primary'` 者 = eligible 集空）按落选缘由组合**（皆不空手、覆盖任意混合无空洞）：空召回（无 model/tool/protocol 匹配）→ 按 **tool→protocol→model** 二次 query（**不**放宽预算/currency）得「放宽 X 有 N 个」；0 eligible 且有候选（全 insufficient / 全 not_recommended / **二者混合**统一）→ candidates 中无 `verdict='primary'` 者 + 据缘由组合：有待核→列 N 个待核；有「超预算」→「放宽预算到 ¥X 有 N 个」（已召回集**数值重核**、非二次 query）；有「`exceeds`」→「降用量档/额度不足」（**不**误导为放宽预算）
- [x] 2.6 **模板解释层（v1）**：`renderTemplate(input: ExplanationInput) => Promise<explanation>`——固定话术填事实 + `candidates[].reasons` 规则原因 + per-fact `source_url`/`lastCheckedDate`/`source_confidence`；**无 LLM**；接口 `ExplanationInput{query,candidates,evidence?:unknown}→Promise<explanation>`（v1 忽略 `query`/`evidence`、同步 resolve；规则原因在 `candidates[].reasons`、不另设顶层 `ruleReasons`；`evidence` 不预钉 RAG 形状）

## 3. MCP 工具（`src/mcp/tools/`，复用既有 server 模式；design D5）

- [x] 3.1 `recommend-coding.ts`：`recommend_coding_subscription({model?, tool?, protocol?, currency?, maxMonthlyPrice?, usageProfile?})` → 调推荐器核心 → `RecommendationResult`；**入参 native ZodRawShape** + 每参 `.describe()` **枚举合法值**（model=`family:version`、clientId 大小写敏感、currency=`mrCurrencySchema` 集、usageProfile=`light|medium|heavy`），handler 内 `.parse()`；`maxMonthlyPrice` = `z.number().nonnegative().finite()`（纯数值判级、**不**格式化任何 money-path 串）；非法→结构化错误
- [x] 3.2 **env-clean 动态取快照（每次现 build）**：handler 内 `await import` task 1.4 的 **env-clean `build.ts`**（`import type` 化后**不**触 `db/index.ts`/`config/env.ts` 的 `parseEnv`），传 `getContext().db` + **显式** `thresholdDays`（取自 task 1.4 已加入 `mcpEnvSchema` 的 `MR_STALENESS_THRESHOLD_DAYS`、不硬编码），**每次调用现 build**（不经 cache.ts、无 frozen-until-restart）；输出 `CallToolResult`（`outputSchema`+`structuredContent`+`content[].text`、**含 `stale`**、`readOnlyHint`）；陈旧如实（数据陈旧由 `stale` 标暴露、不宣称含 5d-A 实时失效——现 build 本就最新）
- [x] 3.3 在 `src/mcp/tools/index.ts` 注册**单工具**（**不**加 `search_coding_plans`）；同 P4 进程/鉴权；快照不可用 → fail-closed 返结构化错误（不编推荐）

## 4. 测试

- [x] 4.1 limits 原语测：`fitsWindow` 6-arm 分派（`none`→fits / `monthly_tokens` 非 NULL→fits·exceeds / 异构口径·真限额 NULL→unknown）+ 多限额取最紧 + **空 `limits[]`→unknown（非 vacuous fits）**；下沉后 `estimateRounds` 与 render/components 行为等价
- [x] 4.2 env-clean 取快照测：① **升级 `query-chain-env.test.ts`**——`allTools.length` 断言 **7→8** + 把 `recommend-coding.ts` 加入静态 grep 禁顶层 import（`cache.js`/`build.js`/`db/index.js`/`config/env.js`）的文件清单；② **另写剪裁 env（仅 `DATABASE_URL`）子进程实跑 getter** 的测，证 handler 运行期 `await import('build.js')` 首次调用不崩（既有装载期测**抓不到**运行期 import、必须实跑 getter）
- [x] 4.3 召回测：按 model/tool 返合格候选、**currency/budget 都不喂 query**（未核价候选被召回标 `insufficient_data`、超预算候选被召回标 `not_recommended`）；**锁币种组**（他币种已知价 plan 被剔除、不跨币比预算）；空结果按缘由返（空召回放宽 tool/protocol/model、0-eligible 据待核/超预算/exceeds 缘由组合给说明）
- [x] 4.4 verdict 测：四态**有序全覆盖**（每候选恰一态、无重叠无空洞）——已核+pending→insufficient_data、已核+超预算/exceeds→not_recommended、eligible 最低→primary（裸 cheapest 被淘汰顺延次低）、其余 eligible→alternative；`price==budget` 含界 eligible
- [x] 4.5 撞窗测：现数据（桶2 全 `value:NULL`）→ 所有候选 `unknown`「不保证不撞窗」不假装；合成 `monthly_tokens` 非 NULL plan → fits/exceeds（⚠ 估算）
- [x] 4.6 输出/模板测：结果经 Zod 校验（四态 verdict、monthlyCost/currency 可空、含 stale）；模板话术含 `candidates[].reasons` + provenance + 撞窗结论、**无 LLM 调用**；解释层接口 `ExplanationInput→Promise` 可插拔
- [x] 4.7 MCP 测：`recommend_coding_subscription` 返结构化推荐（注入合成快照、不触 DB）、只读、`structuredContent`(含 stale)+`readOnlyHint`；快照不可用 fail-closed
- [x] 4.8 **退出标准用例**：「重度用 Claude Code + **GLM-4.6** 最便宜可用」→ 首选 GLM Lite ¥49（claude-code）+ 月成本 + 依据 + 撞窗（现数据 `unknown`，如实标「额度口径未知」不假装）

## 5. 验证

- [x] 5.1 `openspec-cn validate add-model-radar-recommender --strict` 通过
- [x] 5.2 `npx tsc --noEmit` 0 + `npm run lint` 干净
- [x] 5.3 `npx vitest run src/mr/snapshot src/mr/recommend src/mcp src/mr/web`（limits/env-clean/召回/verdict/撞窗/模板/MCP 全绿；既有红线：未核价不入、只读、fail-closed、render 等价、query-chain-env 纪律）
