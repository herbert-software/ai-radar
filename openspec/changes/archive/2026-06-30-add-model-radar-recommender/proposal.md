## 为什么

Model Radar 的定位是**编程垂类选型顾问**，不是比价表——「重度用 Claude Code + GLM-4.6，最便宜可用是谁、会不会撞额度窗、月成本多少、依据是什么」这个**推荐**才是 P5 的终点价值（model 锚 `glm:4.6`：seed 真旗舰行、query 按 `family:version` 精确匹配）。5a–5d 已把地基铺齐：结构化目录（5a）、保鲜回路（5b）、比价/检索 API + 只读快照（5c）、SSR 比价页（5d-B），且 **5d-C 刚把真实价格灌进去**（桶2 6 家 CNY 官方真月价）——没真价的推荐器是空谈，现在正当时。

按 tech-plan 已锁决策：**5e v1 = 规则硬筛 + 模板化解释**（不接 LLM/RAG）。输出 schema 设计成「**规则选候选 + 可插拔解释层**」——v1 解释层 = 模板，v2 把解释层换成 RAG + LLM，**候选召回逻辑不动**。这既让推荐能力**现在就端到端跑通 + MCP 可用**，又为 v2 留好升级缝。

## 变更内容

- **规则硬筛召回（确定性，复用 vetted money-path）**：给定 `{model, tool/protocol}`，经既有 `queryModelRadarSnapshot` 取候选——按模型（`family:version`）/工具/协议精确匹配。**`currency` 与 `maxMonthlyPrice`(预算)均不喂 query**——`query.ts` 传 currency 会排除所有未核价 plan（令 `insufficient_data` 候选召回前消失）、传预算会排除超预算 plan（令 `not_recommended` 召回前消失）；二者是同一反模式，都改为**推荐器内**做。因不喂 currency、召回含他币种组 → 推荐器**锁请求币种组**（默认 CNY）作候选集、**剔他币种已知价 plan**（FX 非目标、绝不裸数值跨币比预算）、未知价组归 `insufficient_data`、预算判级恒同币种内。价格/兼容/额度是 DB 精确事实，**规则不离谱、DB 保事实**。
- **撞窗判定（确定性，落 snapshot 层纯数值原语）**：新建 `src/mr/snapshot/limits.ts` 的 `fitsWindow(limits, demandedRounds, tokensPerRound)`（纯数值入参、不含 `usageProfile` 词汇、不 import web 层；`usageProfile`→`{demandedRounds,tokensPerRound}` 映射归 `recommend/`），下沉 5d-B 估算核心（`estimateRounds`+`ESTIMATE_SPREAD`+`DEFAULT_TOKENS_PER_ROUND`，render 改 import）。**按 `limitType` 分派**（6 arm、`none` 先于 `value:NULL` 兜底命中）：`none`(不限)→`fits`；`monthly_tokens` 非 NULL→估算 fits/exceeds（带内→unknown）；`rolling_5h_requests`/`weekly_messages`/`credit`/`fast_pass`/真限额 `value:NULL`→**`unknown`**（不假装）。多限额取最紧、**空 `limits[]`→`unknown`**（不 vacuous fits）。**现数据如实**：桶2 限额全 `value:NULL`、零 `monthly_tokens` → 现状所有候选撞窗均 `unknown`，含非 NULL `monthly_tokens` 的 plan 入库后自动产出。撞窗是 **⚠ 估算**、绝不进哈希/事实。
- **结构化推荐输出（schema 校验、四态有序 verdict）**：`candidates: RankedCandidate[]`（**扁平数组**、每条带 verdict + `stale`，非分桶数组）；`verdict` 经**有序全覆盖判定**（`insufficient_data`(未核∨待核) > `not_recommended`(超预算∨exceeds) > `primary`(eligible 子集最低价、非裸 cheapest) > `alternative`，每候选恰一态）；每条带 `planId` / 月成本(未核为 null) / `stale` / 撞窗标记 / **依据**（规则原因 + per-fact `source_url`/`lastCheckedDate`/`source_confidence`）。空结果（eligible 集空 = `primary=null`）按已召回候选的落选缘由组合给信息（空召回→放宽 tool/protocol/model；0-eligible→据待核/超预算/exceeds 缘由组合，覆盖任意混合无空洞）。**解释层 = 模板**，接口 `ExplanationInput{query,candidates,evidence?:unknown}→Promise<explanation>`（规则原因在 `candidates[].reasons`、不另设顶层；`evidence` 不预钉 RAG 形状）。
- **MCP 暴露（复用现有 server，同 P4 进程模式）**：单工具 `recommend_coding_subscription({model?, tool?, protocol?, currency?, maxMonthlyPrice?, usageProfile?})` → 结构化推荐。**env-clean 取快照**——动态 import 仅 defer 不避免 `parseEnv` 崩溃（`build.ts` 顶层 import `db/index.ts`+`config/env.ts`，且 `tsconfig verbatimModuleSyntax` 使仅 `typeof` 用的 import 也运行期保留）；故须令 **`build.ts` env-clean**：`import { db }`→`import type`、删 `import { env }`+`thresholdDays` 改必填（`cache.ts` 改喂 threshold、其 4 个 app 调用方零改），handler 再动态 import env-clean `build.ts`、传 `getContext().db`+显式 threshold、**每次现 build**；并升级 `query-chain-env.test.ts`（7→8 + 加新工具 + 另写剪裁-env 实跑测，证「首次调用不崩」，装载期测抓不到运行期 import）。入参 native ZodRawShape + `.describe()` 枚举合法值 + `maxMonthlyPrice` `nonnegative().finite()`；输出 `structuredContent`+`content[].text`(含 `stale`)+`readOnlyHint`。**不**新增 `search_coding_plans`（与 `/model-radar/plans` 重复 + 抵触「检索横切」红线，归 compare-api 后续）。
- **诚实红线沿用**：只读快照/DB、不写事实；未核价不入推荐（priceStatus≠known 不参与「最便宜」、标 `insufficient_data`）；待核(含停售)不作首选——v1 DTO 仅 `reviewStatus.pending`、不区分「已停售」（停售专属文案 = DTO 后续增量，**已声明的已知缺口**）；撞窗/陈旧如实标（MCP 每次现 build、随调随新，数据陈旧由候选 `stale` 标暴露、不宣称含 5d-A 实时失效）；输出全程结构化 JSON + Zod 校验。

### 非目标

- **v1 不接 LLM / 不接 RAG 解释层**（tech-plan 已锁 v1=规则+模板；RAG 证据 + LLM 解释是 v2，仅换可插拔解释层、不重构召回）。
- **不做跨桶 / 跨币种 FX 比较**（沿 5c 同桶同币种红线）；不做多周期（月/季/年）最优周期推荐（属独立后续，需 schema 改）。
- **不做横切检索 MCP 工具**（`search_coding_plans` 与 `/model-radar/plans` 检索重复、「桶2 gate」又抵触「检索横切所有桶」红线；横切检索归 compare-api 后续）。
- **不为「已停售」加快照 DTO 字段**（v1 DTO 仅 `reviewStatus.pending`、不区分停售 vs 待核 → 一律「待核(含停售)不作首选」；停售专属判定 = compare-api DTO 后续增量，本期**已声明的已知缺口**）。
- **不做 rolling_5h / weekly 窗换算**（月总量→突发 5h 速率 / 月→周无诚实换算，类别错误；v1 一律标 `unknown`）。
- **不写任何事实 / 不碰 LLM 判价**（价格/兼容/额度由 DB；推荐器只读 + 规则 + 模板）。
- **不泛化到「任意工具/任意任务」**（那是 P6 通用顾问；本期仅编程订阅垂类）。
- 不引重运行时依赖（复用既有 query/snapshot/MCP；模板是字符串拼装）。

## 功能 (Capabilities)

### 新增功能
- `model-radar-recommender`: 编程订阅选型推荐器 v1——规则硬筛召回（经 vetted `queryModelRadarSnapshot`、预算不喂 query）+ 撞窗判定（snapshot 层 `fitsWindow` 原语、按 limitType 分派、口径未知不假装）+ 结构化「首选/备选/不推荐/待核 + 月成本 + 撞窗 + 依据」输出（四态 verdict、模板解释层 `ExplanationInput→Promise`、schema 校验、可插拔留 v2）+ MCP 单工具 `recommend_coding_subscription`。

### 修改功能
- `model-radar-compare-api`: **两处行为等价的内部重构**——① 把 5d-B `estimateRounds`(+`ESTIMATE_SPREAD`/`DEFAULT_TOKENS_PER_ROUND`) 从 `src/mr/web/render.ts` 下沉至 `src/mr/snapshot/limits.ts`（render/components 改 import、撞窗逻辑可被推荐器复用而不反向依赖 web 层；UI 旋钮 `TOKENS_PER_ROUND_OPTIONS`/`resolveTokensPerRound` 留 render）；② 令 **`build.ts` env-clean**——`import { db }`→`import type`（`verbatimModuleSyntax` 下仅 `typeof` 用的 import 也运行期保留）、删 `import { env }` + `thresholdDays` 改必填，`SnapshotBuildFn`/`cache.ts` 多喂 `env.MR_STALENESS_THRESHOLD_DAYS`（**cache.ts 对外签名与其 4 个 app 调用方零改**），令快照可在仅 `DATABASE_URL` 的 MCP 进程动态 import 现 build；快照只读契约/分组/cheapest/哈希语义不变（无对外行为变更）。

## 影响

- 代码：新增 `src/mr/snapshot/limits.ts`（下沉估算核心 + 新增 `fitsWindow`，纯函数）+ `src/mr/recommend/`（规则召回 + 撞窗 + 模板解释 + 输出 schema + 空结果按缘由组合）；**env-clean 化 `build.ts`**（`import type` + `thresholdDays` 必填 + `SnapshotBuildFn`/cache 内部线 + build-stub 测；cache.ts 4 个 app 调用方零改）；MCP server 加 **1** 个工具（动态 import env-clean `build.ts`、native raw-shape 入参、每次现 build）。
- 复用：`queryModelRadarSnapshot`（money-path）+ 只读快照 + 下沉后的 5d-B 估算；不改 DB schema、不新增 BullMQ 链。**MCP 每次现 build（不缓存）**→ 无 frozen-until-restart、随调随新（候选带 `stale` 标暴露数据陈旧，不宣称实时）。
- 契约：读路径只读、fail-closed；推荐输出 Zod 校验（四态有序 verdict + stale）；MCP 工具同 P4 进程/鉴权模式、**env-clean 动态 import 真正可用**（非仅 boot 不崩）；`query-chain-env.test.ts` 升级（7→8 + 加新工具 + 另写剪裁-env 实跑测）。
- 测试：limits 原语（6-arm + 取最紧 + 空→unknown + render 等价）+ env-clean 取快照（query-chain-env 纪律 + 剪裁-env 子进程实跑「首次调用不崩」）+ 规则召回（按 model/tool 返候选、currency/budget 不喂 query、锁币种组剔他币种、未核价标 `insufficient_data`、空结果按缘由）+ verdict 四态有序全覆盖 + 模板解释（含依据/provenance）+ 退出标准用例「重度用 Claude Code + **GLM-4.6**」（首选 GLM Lite ¥49、撞窗 unknown 如实答）。
