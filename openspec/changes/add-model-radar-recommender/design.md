## 上下文

5a–5d 已落地：只读快照 + `queryModelRadarSnapshot`（vetted money-path，按 `modelRadarQueryParamsSchema` = model `family:version`/tool/protocol/maxMonthlyPrice/currency/category 过滤 + 同桶同币种分组 + cheapest）、5d-B 的 `estimateRounds`（按 `monthly_tokens` 限额估中等任务轮次，**现落 `src/mr/web/render.ts`**）、5d-C 桶2 6 家 CNY 真月价。MCP server 在 `src/mcp/`（`server.ts` + `tools/*.ts` 各一工具 + `tools/index.ts` 注册 + `context.ts`/`db.ts`/`env.ts`），P4 模式，**进程只有 `DATABASE_URL`**（`mcp/env.ts` 宽松解析、`mcp/db.ts` 只 import `db/schema.ts` 避全局 `parseEnv`；`query-chain-env.test.ts` 钉死查询链不顶层 import `db/index.js`/`config/env.js`）。

tech-plan 已锁：**5e v1 = 规则硬筛 + 模板化解释**（不接 LLM/RAG），输出 schema =「规则选候选 + **可插拔解释层**」，v2 仅换解释层为 RAG+LLM、召回不动。架构红线：规则保「不离谱」、DB 保「事实」、模板保「讲明白」（v1）、RAG 保「有依据」（v2）；结构化 JSON + schema 校验；money-path 不手搓。

**现状校准（评审已证、约束设计）**：① 桶2 6 家 coding_plan 限额全 `rolling_5h_requests`/`credit`/`fast_pass` 且 `value:NULL`、**零 `monthly_tokens`** → 撞窗现数据全 `unknown`；② DTO 仅 `reviewStatus.pending` 布尔、**无** `discontinued` → 停售/待核不可分（已声明缺口）；③ `limitType` **6 arm**（含 `none`=不限）；④ `cache.ts:32`/`build.ts:31-32` 顶层 import `db/index.ts`+`config/env.ts` → 动态 import 它们只 **defer** `parseEnv` 崩溃、不避免；⑤ `query.ts:124` 传 `currency` 排除**所有** `priceStatus≠known` plan（同 `maxMonthlyPrice` 排除超预算）；⑥ seed 仅 `glm:4.6`（GLM Lite ¥49 / Pro ¥149，claude-code）、**无 `glm:5.2`**。下述决策据此如实约束。

## 目标 / 非目标

**目标：** 给定 `{model?, tool?, protocol?, currency?, maxMonthlyPrice?, usageProfile?}` → 经规则召回 + 撞窗判定 + 模板解释产出结构化「首选/备选/不推荐/待核 + 月成本 + 撞窗 + 依据」；MCP 单工具 `recommend_coding_subscription` 从 Claude/Cursor 直接用（**真正可用**、非仅 boot 不崩）。退出标准用例「重度用 Claude Code + **GLM-4.6** 最便宜可用」可答——含「撞窗口径已知则估、未知则如实标」。

**非目标：** v1 不接 LLM/RAG（解释层=模板、留可插拔缝）；不跨桶/跨币 FX；不做横切检索工具（`search_coding_plans` 归 compare-api 后续）；不为「已停售」加 DTO 字段（声明为已知缺口）；不做 rolling/weekly 窗换算；不多周期最优；不写事实/不 LLM 判价；不泛化 P6。

## 决策

**D1. 召回经既有 `queryModelRadarSnapshot`（money-path，不手搓），currency/budget 均不喂 query。**
向 query 只注入 `{category='coding_plan', model?, tool?, protocol?}` → 取**全部** groups（已知价各币种组 + `sortScope.currency=null` 未知价组）。**`currency` 与 `maxMonthlyPrice` 都不喂 query**：`query.ts:124` 传 currency 排除所有 `priceStatus≠known` plan（令 `insufficient_data` 候选召回前消失）、传 budget 排除超预算 plan（令 `not_recommended` 候选消失）——二者是同一反模式（提案已为 budget 规避，currency 须同样规避）。**币种选组 + FX 红线**：因召回会含他币种已知价组，推荐器**候选集** = 请求 `currency`(默认 CNY)已知价组 ∪ `currency=null` 未知价组；**他币种已知价 plan 一律剔除**（FX 非目标，绝不用裸数值 `maxMonthlyPrice` 跨币比 `currentPrice`），可附「另有 N 个他币种 plan 未比」。**预算判级**（数值比 `plan.currentPrice`，恒同币种内）+ **未知价归类**（`currency=null` 组 → `insufficient_data`）都在推荐器内做。`usageProfile`/`currency`/`maxMonthlyPrice` 是推荐层维度。

**D2. 撞窗判定 = snapshot 层纯数值原语 `fitsWindow(limits, demandedRounds, tokensPerRound)`。**
新建 `src/mr/snapshot/limits.ts`：下沉 5d-B 估算核心（`estimateRounds` + `ESTIMATE_SPREAD` + `DEFAULT_TOKENS_PER_ROUND`），render 页改 import 它（UI 旋钮 `TOKENS_PER_ROUND_OPTIONS`/`resolveTokensPerRound` 留在 `render.ts`）；新增 `fitsWindow(limits, demandedRounds: number, tokensPerRound: number) → 'fits'|'exceeds'|'unknown'`——**纯数值入参**（无 `usageProfile` 词汇、无 web import；`usageProfile`(轻/中/重)→`{demandedRounds, tokensPerRound}` 映射归 `src/mr/recommend/`，是两个正交旋钮）。按 `limitType` 分派（**先判 limitType、`none` 在任何 `value===null→unknown` 兜底前命中**）：
- `none`(不限) → **`fits`**（唯一据 NULL 报不撞窗的合法情形）；
- `monthly_tokens` 非 NULL → `额度÷tokensPerRound`(±50% 带) 比 `demandedRounds`：`≤low`→`fits`、`≥high`→`exceeds`、带内→`unknown`；
- `rolling_5h_requests`/`weekly_messages` → **`unknown`**（无诚实窗换算）；
- `credit`/`fast_pass` → **`unknown`**（口径异构）；
- 真限额 `value:NULL`（占位，非 `none`）→ **`unknown`**。

**多限额取最紧**：任一 `exceeds`→`exceeds`；否则任一 `unknown`→`unknown`；全 `fits`→`fits`。**空 `limits[]`→`unknown`**（聚合恒等元 = `unknown`、绝不 vacuous 判 `fits`）。结果 **⚠ 估算**、不进哈希/事实。现数据全 `unknown`（accepted-degraded）。

**D3. 输出 flat candidates + 四态有序全覆盖 verdict + stale。**
`RecommendationResult { query, candidates: RankedCandidate[], explanation }`——`candidates` **扁平数组**（每条带 verdict、**非**分桶数组）。`RankedCandidate { planId, vendorName, name, monthlyCost: number|null, currency: string|null, priceStatus, stale: boolean, fitsWindow: 'fits'|'exceeds'|'unknown', verdict, reasons: RuleReason[], provenance }`（`stale` 取 snapshot plan 级 `freshness.stale`、MCP 输出须含）。`verdict` 经**有序全覆盖判定**（每候选恰一态）：
1. `priceStatus≠known` **或** `reviewStatus.pending=true` → `insufficient_data`（待核态）；
2. 否则 已核 + (`currentPrice > maxMonthlyPrice`（`>`、含界、**同币种内**、缺省预算视为无约束）**或** `fitsWindow='exceeds'`) → `not_recommended`；
3. 否则（eligible = 已核+非待核+不超预算+`≠exceeds`）中**最低价** → `primary`（= 取请求币种组经 query 升序排好的首个 eligible（**不另手搓排序**）；裸 cheapest 若被淘汰则顺延次低 eligible、不致空首选）；
4. 其余 eligible → `alternative`（catch-all：eligible 非最低价者。**注** `fitsWindow=unknown` 属 eligible，故「更便宜但撞窗未知」者成 `primary`（带「口径未知」⚠ 警）、不降 `alternative`）。
`explanation` 接口 `ExplanationInput → Promise<explanation>`：`ExplanationInput { query, candidates, evidence?: unknown }`（规则原因在每条 `candidates[].reasons` 内、不另设顶层 `ruleReasons`；`evidence` 不预钉 RAG 形状）——v1 `renderTemplate` 忽略 `query`/`evidence`、同步 resolve；v2 `explainWithLlm` 经**同一接口**用 `evidence`，召回/候选 schema 不变。

**D4. 模板解释（v1）+ 空结果（`primary=null`）按落选缘由组合。**
话术：每条 首选/备选/不推荐/待核 带 `candidates[].reasons` 规则原因（如「含 GLM-4.6 ✓、Claude Code ✓、¥49/月、额度口径未知不保证不撞窗」）+ per-fact `source_url`/`lastCheckedDate`/`source_confidence`。**LLM 不参与**。**空结果**（eligible 集为空、不空手）按已召回候选的落选缘由组合给信息（覆盖任意混合、无空洞）：
- **空召回**（无 plan 含目标 model/tool/protocol）→ 按 **tool→protocol→model** 二次 query（**不**放宽预算/currency——非召回过滤器）得「放宽 X 有 N 个」；
- **0 eligible 且有候选**（全 `insufficient_data` / 全 `not_recommended` / **二者混合**统一处理）→ `primary=null` + 据缘由组合：有待核→列「N 个待核」；有「超预算」→「放宽预算到 ¥X 有 N 个」（对已召回集**数值重核**、非二次 query）；有「`exceeds`」→「降用量档 / 额度不足」（**不**误导为放宽预算）。

**D5. MCP 单工具，env-clean 动态取快照（仅 boot 不崩不够、须每次调用真取到）。**
- `recommend_coding_subscription({model?, tool?, protocol?, currency?, maxMonthlyPrice?, usageProfile?})` → `RecommendationResult`。**不**加 `search_coding_plans`。
- **env-clean 仅改 `build.ts`（不改 cache.ts 签名）**：`tsconfig` 开 `verbatimModuleSyntax:true` → 非 `import type` 语句即便仅 `typeof` 用也运行期保留（tsc 静默不报）。故 `build.ts:31` `import { db as defaultDb }`（仅 `type DbLike=typeof defaultDb` 用）→ 改 **`import type`**（或仿 `mcp/db.ts` 把 `DbLike` 重定义为 `McpDb`、彻底不 import db/index）；`build.ts:32` `import { env }`（仅 `thresholdDays=env.MR_STALENESS_THRESHOLD_DAYS` 默认用、`dbh:96` 本已必填）→ 删 import、`thresholdDays` 改必填。
- **cache.ts 仅多喂 threshold、不改对外签名**：`SnapshotBuildFn`(`cache.ts:40`) 增 `thresholdDays` 参、`cache.ts:100` 调 `buildFn(dbh,now,threshold)`、cache 从 `env.MR_STALENESS_THRESHOLD_DAYS` 取（cache 只 app 进程跑、import env 无妨）。**cache.ts 的 4 个 app 调用方（`model-radar-page.tsx:43`/`api/model-radar.ts:24`/`background.ts:34`/`rebuild.ts:68` 链）签名不变、零改**。
- MCP handler 动态 import **env-clean 的 `build.ts`**、传 `getContext().db` + 显式 `thresholdDays`、**每次调用现 build**（不经 cache）；`MR_STALENESS_THRESHOLD_DAYS` **加入 `mcpEnvSchema`**（与 app 同口径、不硬编码）。
- **纪律守护升级**：`query-chain-env.test.ts` 既有 `allTools.length===7` + 7-file 静态 grep 只验**装载期** → 第 8 工具须 **7→8** + 加 `recommend-coding.ts` 进 grep 清单；装载期测**抓不到** handler 运行期 `await import('build.js')` 的崩溃 → 另写**剪裁 env(仅 DATABASE_URL)子进程实跑 getter** 的测证「首次调用不崩」。
- 入参 native ZodRawShape + 每参 `.describe()` **枚举合法值**（model=`family:version`、clientId 大小写敏感、currency=`mrCurrencySchema` 集、usageProfile=`light|medium|heavy`），handler `.parse()`；`maxMonthlyPrice` = `z.number().nonnegative().finite()`（纯数值判级、同币种比、不格式化任何 money-path 串）。输出 `CallToolResult`（`outputSchema`+`structuredContent`+`content[].text`、含 `stale`）、`readOnlyHint`。
- **陈旧如实**：MCP **每次现 build**（不缓存）→ 无 frozen-until-restart、随调随新；唯一陈旧源是数据 `last_checked`，由候选 plan 级 `stale` 标如实暴露。**不**宣称「含 5d-A 实时失效」（订阅器未装配、亦无需）。

**D6. 桶2 gate + 只读 + fail-closed（沿 5c/5d-B 红线）。**
强注入 `category='coding_plan'`（与 render 共享常量、不重复定义）；只读、不写事实；快照不可用 → fail-closed；未核价不入「最便宜」、待核(含停售)不作首选。

## 风险 / 权衡

- **撞窗现数据全 `unknown`**（桶2 全 `value:NULL`、零 `monthly_tokens`）→ 标 **⚠ 估算**、如实标「口径未知」，不伪造；空限额亦 → `unknown`（不 vacuous fits）。accepted-degraded。
- **「已停售」不可判**（DTO 仅 `reviewStatus.pending`）→ 「待核(含停售)不作首选」（`insufficient_data`）；停售专属 = DTO 后续增量、**已声明缺口**。
- **env-clean 仅改 `build.ts`**（`import type` + `thresholdDays` 必填）+ `SnapshotBuildFn`/`cache.ts` 多喂 threshold + build-stub 测；**cache.ts 对外签名与其 4 个 app 调用方零改**（blast radius 收窄到 build/类型/cache 内部线/测桩）。回滚见迁移。
- **跨币 FX**：currency 不喂 query → 召回含他币种已知价组；推荐器锁请求币种组、剔他币种已知价（绝不裸数值跨币比预算）。数据现状全 CNY、此为 forward-fragility 防护。
- **退出用例 model**：seed 仅 `glm:4.6`（非 `glm:5.2`，query 精确版本匹配）→ 退出用例锚 `glm:4.6`（真旗舰行），首选 = GLM Lite ¥49 claude-code（`fitsWindow=unknown`）。
- **模板僵硬/覆盖不全** → v1 接受；`ExplanationInput→Promise`（含 `evidence` 槽）让 v2 换 LLM 不重构召回。
- **MCP 快照陈旧** → 每次现 build（不缓存）、无 frozen-until-restart；数据陈旧由候选 `stale` 标暴露，accepted-degraded（不宣称实时）。

## 迁移计划

1. `src/mr/snapshot/limits.ts`：下沉 `estimateRounds`+`ESTIMATE_SPREAD`+`DEFAULT_TOKENS_PER_ROUND`（`render.ts`+`components.tsx`+`render.test.ts` 改 import）+ 新增 `fitsWindow`（6-arm + 取最紧 + 空→unknown，纯函数可单测）。
2. **env-clean 化 `build.ts`**：`import { db }`→`import type`（verbatimModuleSyntax）、删 `import { env }`、`thresholdDays` 必填；`SnapshotBuildFn`(`cache.ts:40`) 增 `thresholdDays`、`cache.ts:100` 调 `buildFn(dbh,now,env.MR_STALENESS_THRESHOLD_DAYS)`；更新 build-stub 测（`cache.test.ts`/`background.test.ts` 等传 3 参）。**cache.ts 4 个 app 调用方零改**。`MR_STALENESS_THRESHOLD_DAYS` 加入 `mcpEnvSchema`。
3. `src/mr/recommend/`：规则召回（调 query、currency/budget 不喂、锁币种组剔他币种）+ 调 `fitsWindow`（自持 `usageProfile→{demandedRounds,tokensPerRound}`）+ 输出 schema（Zod，四态有序）+ 模板解释层（`ExplanationInput→Promise`）+ 空结果按缘由组合。
4. `src/mcp/tools/recommend-coding.ts` + `index.ts` 注册；动态 import env-clean `build.ts`、native raw-shape + describe；`query-chain-env.test.ts` 7→8 + 加 `recommend-coding.ts` + 另写剪裁-env 子进程实跑 getter 测。
- 回滚：MCP 工具可摘；推荐器纯读；`limits.ts` 下沉与 `build.ts` env-clean 化均**行为等价**（同函数移位 / `import type` 擦除 + threshold 由 cache 显式喂同值）。

## 待解问题

- `usageProfile` 粒度：枚举 `light`/`medium`/`heavy` 足够 v1，还是允许传具体轮次/tokens？（倾向枚举 + 可选 override。）
- MCP 现 build 频次：每调用现 build（无缓存、随调随新、对低频顾问工具可忽略 DB 读成本）够 v1，还是加一层 MCP 侧轻缓存？（倾向无缓存——既最新又免 frozen-until-restart，需缓存再说。）
