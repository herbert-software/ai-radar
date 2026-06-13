## 为什么

日报与实时告警的候选窗口把**抓取时间**（`first_seen_at`）当作时效依据来过滤，而 `first_seen_at` 在塌缩建事件时被赋值为 raw_item 的入库时刻（`item.fetchedAt`，schema `defaultNow()`），与文章真实发布时间无关。后果：冷启动或新增源时，大量历史老文（例如 OpenAI 博客 2020–2022 的 ChatGPT / Scaling laws / Codex 等）一被首次抓到，`first_seen_at` 即为「今天」，于是被当成「近 N 天新消息」推送，直接违反时效性策略（`policy-push-timeliness`：禁止上线新功能后批量推送旧消息）。文章的真实发布时间其实已被 RSS 采集正确解析并写入 `published_at`，只是过滤逻辑从未使用它。

现在修复，是因为该 bug 已在生产环境造成日报刷屏（2026-06-13 日报 8 条全部为历史老文）。#7/#8 给告警链补的「时间窗口」加在了同一个错误字段（`first_seen_at`）上，并未根治。

## 变更内容

- **BREAKING（口径变更）**：日报候选窗口的时效闸从「`first_seen_at` 在近 N 天」改为「**`published_at` 在近 N 天**」。复用现有窗口天数 `FIRST_SEEN_WINDOW_DAYS`（默认 3），不新增窗口配置项。
- **BREAKING（口径变更）**：实时告警候选窗口同样从 `first_seen_at` 改为 `published_at` 时效闸，复用现有 `ALERT_FIRST_SEEN_WINDOW_DAYS`（默认 3）。
- 新增一道 **AI 发布时间推断**步骤：对 `published_at` 为 NULL 的事件，由 Agent 从代表 raw_item 的标题 / URL / 正文 / 源等线索语义推断发布日期，输出结构化 JSON 并做 Zod schema 校验。推断成功则回填 `published_at` 供过滤；AI 仍判不出（保持 NULL）则该事件**排除出候选**（不推送）。推断调用失败 / 超时按「判不出（NULL）」降级处理，不阻塞流水线、绝不把失败误当「现在」。
- 最终候选过滤仍为 DB 层确定性 query（基于 `published_at`）。LLM 只负责填补 `published_at` 这一语义空缺（定位等同现有 Value Judge 评分 Agent），**不参与**「是否够新 / 是否推送」的状态判断。

## 功能 (Capabilities)

### 新增功能
- `published-at-inference`: 对缺失发布时间的事件做 AI 语义推断的独立能力——输入代表 raw_item 的标题/URL/正文/源，输出结构化、经 schema 校验的发布日期或「无法判定」；含失败/超时降级（按 NULL 处理）、重试与错误日志。供日报与告警两条候选链在过滤前调用以回填 `published_at`。

### 修改功能
- `daily-intel-pipeline`: Top N 候选窗口的时效条件由 `first_seen_at 在近 N 天` 改为 `published_at 在近 N 天`；`published_at` 为 NULL 的事件先经 `published-at-inference` 回填，仍 NULL 则排除。其余候选条件（`should_push`、未投递给所有已配置通道、importance 下限闸、Asia/Shanghai 同源「今天」）不变。
- `realtime-alerts`: 告警候选窗口的时效条件由 `first_seen_at 在近 N 天` 改为 `published_at 在近 N 天`（并相应调整排序口径），NULL 处理同上；`windowDays=0` 旁路仍须排除 NULL。其余不变量（评分后判阈值、一生一次 success、UNIQUE 兜底）不变。
- `dedup-and-normalization`: 「基于 dedup_key 的硬去重塌缩」的 `ON CONFLICT DO UPDATE` 增加 `published_at = COALESCE(ai_news_events.published_at, excluded.published_at)` identity-preserving NULL-fill——首条 raw_item 无日期、后到同 dedup_key raw_item 有确定日期时补入（确定性事实优先于 AI，见 design D8）；仍冻结身份/代表/`first_seen_at`、绝不覆盖已设 `published_at`。

## 影响

- 代码：
  - `src/selection/top-n.ts`（`selectTopN` 候选窗口 + 注释口径）
  - `src/pipeline/alert-scan.ts`（`selectAlertCandidates` 候选窗口与排序 + `windowDays=0` 补 `isNotNull` + 注释口径）
  - 新增 `published-at-inference` Agent 模块（`src/agents/...`，Vercel AI SDK `generateObject` + Zod，含范围 refine / 重试 / 降级 / 日志 / Redis per-event 锁 / 独立上限 / first_seen 下界）
  - `src/dedup/collapse.ts`（`ON CONFLICT DO UPDATE` 增 `published_at = COALESCE(...)` identity-preserving NULL-fill，确定性事实优先，见 design D8）
  - 两条流水线编排（`run-daily` 在 Value Judge 后/Top N 前、`runAlertScan` 在选候选前）插入回填步骤，且回填阶段不计入降级率熔断
- 数据：`ai_news_events.published_at` 写入路径新增两个来源——塌缩层 `COALESCE` NULL-fill（确定性）与 AI 推断回填（兜底）；不改 `first_seen_at` 语义（仍记首次抓取时间，供调试 / 僵尸 claim 回收）。**不新增 provenance 标记列**（design D3 定稿）、不动表结构（D8 仅改 `ON CONFLICT` 的 `set` 子句）。
- 配置：复用现有 `FIRST_SEEN_WINDOW_DAYS` / `ALERT_FIRST_SEEN_WINDOW_DAYS`（不引入新窗口 env）；**新增一个推断成本闸 env `PUBLISHED_AT_INFERENCE_MAX_PER_RUN`**（非窗口配置项）；AI 推断的开关/超时复用现有 LLM 调用配置。
- 告警 `ALERT_FIRST_SEEN_WINDOW_DAYS=0`（不限窗口）旁路：改字段后须补 `published_at IS NOT NULL` 排除（旁路只免时效 gte、不免 NULL 排除，见 design D1）。
- 已知局限：GitHub 源 `published_at = pushed_at ?? created_at`（最近活跃时间，非首次发布），改时效闸后活跃老仓可能被当近期推送——本期接受、不改采集器（见 design D7）。
- 文档：`daily-intel-pipeline` spec 的「Top N 组合分选择」需求正文中「候选窗口键于 first_seen_at」改为「键于 published_at（NULL 经 AI 推断，仍 NULL 则排除）」（已由本变更 daily delta 承载；OpenSpec 内无内容为此的 design D 编号文档）；同步 `top-n.ts`/`alert-scan.ts` 顶部注释口径。`daily-intel-pipeline`「每日定时单队列顺序编排」需求需插入「发布时间回填」阶段（Value Judge 之后、Top N 之前）。

## 非目标

- 不改去重塌缩中 `first_seen_at` 的语义本身——它仍记录首次抓取时间，用于调试、僵尸 claim 回收等。
- 不引入新的**窗口**配置项（复用现有天数 env）；仅新增一个推断成本闸 `PUBLISHED_AT_INFERENCE_MAX_PER_RUN`（非窗口项）。
- 不改评分链（Value Judge）、不改去重分层（硬去重→title_hash→embedding→LLM 的层次不变；D8 仅给塌缩 `ON CONFLICT` 增 `published_at` 的 NULL-fill，不触判定层次与身份/代表列）、不改推送幂等模型。
- 不把「是否够新 / 是否推送」的状态判断交给 LLM——LLM 仅做 `published_at` 语义抽取，最终过滤与状态仍由程序和 DB 确定性保障（守第一架构原则）。
- **不改 weekly-report**（`weekly-report.ts` 同样以 `first_seen_at` 作窗口键、属同一根因）：周报当前默认禁用（`WEEKLY_REPORT_ENABLED=false`）、P2 已归档，本期 scope-out 以聚焦生产 hotfix；但**强制约束**：weekly-report 重新启用前必须先把窗口键改为 `published_at`（同口径 NULL 处理），否则会重演本 bug（见 design D6，记为跟踪项）。
- 不改采集器对 GitHub 源的 `published_at` 口径（见上「已知局限」/ design D7）。
- 不加 `published_at` provenance 列、不动 `platform-foundation` schema（design D3 定稿）。
