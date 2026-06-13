## 上下文

日报（`src/selection/top-n.ts` 的 `selectTopN`）与实时告警（`src/pipeline/alert-scan.ts` 的 `selectAlertCandidates`）的候选窗口都以 `ai_news_events.first_seen_at` 做「近 N 天」时效过滤。但 `first_seen_at` 在塌缩建事件时被赋值为 raw_item 入库时刻（`src/dedup/collapse.ts:129` `firstSeenAt: item.fetchedAt`，而 `fetchedAt` 走 schema `defaultNow()`），与文章真实发布时间无关。冷启动 / 新增源时，历史老文一被首次抓到，`first_seen_at` 即为「今天」，于是被误当「近 N 天新消息」推送。2026-06-13 日报 8 条全为 OpenAI 历史老文即此 bug。

关键事实：文章真实发布时间 `published_at` 其实已被 RSS 采集正确解析入库（`src/collectors/rss.ts:65` `parseDate` 读 `isoDate ?? pubDate`，缺失返回 `null` 而非 `new Date()`），塌缩时也已复制进 `ai_news_events.published_at`（`collapse.ts:131`），只是过滤逻辑从未使用它——`published_at` 当前仅作为 `compareForTopN` 的排序 tiebreaker（`top-n.ts:131-140`）。

约束（守第一架构原则）：最终「是否够新 / 是否推送」必须由程序 + DB 确定性保障，不交 LLM；LLM 仅可做语义抽取（这里是补 `published_at`）。窗口「今天」必须复用 `push-date.ts` 的 Asia/Shanghai 同源 `startOfDayInTimeZone`，禁止另起时区计算。

## 目标 / 非目标

**目标：**
- 两条候选窗口的时效闸由 `first_seen_at` 改为 `published_at`，复用现有窗口天数 env（`FIRST_SEEN_WINDOW_DAYS` / `ALERT_FIRST_SEEN_WINDOW_DAYS`，默认 3），不新增窗口配置项。
- 对 `published_at` 为 NULL 的事件，新增一道 AI 发布时间推断步骤回填；AI 仍判不出则排除出候选（不推送）。
- AI 推断步骤具备失败/超时降级（按 NULL 处理）、重试、错误日志，绝不阻塞流水线、绝不把失败误当「现在」。
- 修复后冷启动 / 新增源不再把历史老文当新消息推送。

**非目标：**
- 不改 `first_seen_at` 的塌缩语义（仍记录首次抓取时间，供调试 / 僵尸 claim 回收）。
- 不新增窗口配置项。
- 不改评分链（Value Judge）、去重分层、推送幂等模型（UNIQUE 四元组 + 一生一次 success）。
- 不把推送/时效的状态判断交给 LLM。

## 决策

### D1：时效闸改用 `published_at`，SQL 层确定性过滤（闭区间 `lowerBound <= published_at <= now`）
两处 `where` 把 `gte(firstSeenAt, lowerBound)` 改为对 `published_at` 的近 N 天过滤。`lowerBound` 仍由 `windowLowerBound(now, windowDays)` / `startOfDayInTimeZone(now, windowDays-1)` 算出（同源 push-date，不漂移）。

**时效闸必须是闭区间 `lowerBound <= published_at <= now`，不可只设下界（绝不可省）**：除下界外必须再加**未来日期上界** `published_at <= now`。原因：`gte(published_at, lowerBound)` 对**未来日期恒为真**，而 `published_at` 不止 AI 推断会出错——**确定性来源**（RSS feed `pubDate`、GitHub `pushed_at` 等）也可能给出错误的未来日期（源端 bug / 时区错配 / 恶意 feed），这些值经采集直接入库、不经 AI 的 refine 拦截。若只设下界，未来日期的事件会绕过时效闸被当「近期」推送/告警。故 D2 的 AI refine（拦 AI 未来值）+ D1 的过滤层 `<= now`（拦任何来源的未来值，含确定性来源）构成**双层防御**，缺一不可。「未发布的未来内容不算近期新闻」语义上也要求上界。

- `top-n.ts:selectTopN`：`where` 中 `gte(aiNewsEvents.firstSeenAt, lowerBound)` → `gte(aiNewsEvents.publishedAt, lowerBound)` **且** `lte(aiNewsEvents.publishedAt, now)`（now 为同一参考时刻）。
- `alert-scan.ts:selectAlertCandidates`：`where` 中 `gte(aiNewsEvents.firstSeenAt, lowerBound)` → `gte(aiNewsEvents.publishedAt, lowerBound)` **且** `lte(aiNewsEvents.publishedAt, now)`；`orderBy(desc(aiNewsEvents.firstSeenAt))` → `orderBy(desc(aiNewsEvents.publishedAt))`（单次上限取「最新发布」）。

注意 Drizzle `gte`/`lte` 对 NULL 自然返回假——即过滤前所有 NULL `published_at` 的行会被排除。这正是我们想要的「最终过滤层 NULL 即排除」，配合 D2 的「先回填」：回填发生在过滤**之前**，能补的已补，过滤时剩下的 NULL 就是「AI 也判不出」，排除符合需求。

**时区比较口径（显式声明）**：`published_at` 是带时区的发布绝对时刻（schema `withTimezone: true`），`lowerBound` 由 `startOfDayInTimeZone`（Asia/Shanghai，与 push_date 同源）换算为 UTC 绝对时刻。时效闸 `published_at >= lowerBound` 是**两个绝对时刻**的比较（Postgres `timestamptz` 比较，非「裸日期 vs 带时区」混比，也不按发布地本地日历重算）。落在上海日界 UTC 前后一瞬的事件行为由此唯一确定。验收用边界断言固化（见 tasks 6.3）。

**`windowDays=0`（不限窗口）旁路的 NULL + 未来日期处理**：告警链现有 `ALERT_FIRST_SEEN_WINDOW_DAYS=0` 表示 `lowerBound=null`、旁路下界 `gte` 闸（向后兼容）。改字段后必须保证：旁路仅免除**下界**「近 N 天」gte，**不免除 NULL 排除、也不免除未来日期上界**——即 `windowDays=0` 时候选 where 仍须含 `isNotNull(aiNewsEvents.publishedAt) AND lte(aiNewsEvents.publishedAt, now)`。日报链 `FIRST_SEEN_WINDOW_DAYS` 为 `positive`（无 0 旁路），恒走闭区间 `gte+lte`（隐含非 NULL），不受影响。

**替代方案（否决）**：在 SQL 里写 `published_at >= bound OR (published_at IS NULL AND first_seen_at >= bound)` 做 NULL 回退到 first_seen——被用户否决（NULL 要走 AI 推断，判不出就排除，不回退到抓取时间）。

### D2：AI 发布时间推断作为独立 Agent 模块，在选题前回填
新增 `published-at-inference` 能力（建议 `src/agents/published-at-inference/`，与现有 `src/agents/value-judge/` 平行）。

- 输入：缺 `published_at` 的事件 + 其代表 raw_item（经 `representative_raw_item_id` 回指 `raw_items`，取 title / canonical_url / 正文或摘要 / 源）。
- 实现：Vercel AI SDK `generateObject` + Zod schema。输出形如 `{ publishedAt: string | null /* ISO date 或 null */, confidence?: number, basis?: string }`；`null` 表示「无法判定」。
- **合理范围校验（命门）**：Zod schema 以 `refine` 约束 `合理下限 <= publishedAt <= now`——拒绝未来日期与荒谬过早日期，越界即降级为「无法判定（NULL）」。理由：`gte(published_at, lowerBound)` 对未来日期恒为真，若放任未来/荒谬日期回填，被推错的事件会**绕过时效闸**反而放大本提案要堵的漏洞。
- **确定性优先于 AI（第一架构原则）**：DB 已有的确定 `published_at` 绝不交 LLM。本变更在塌缩层修复（见 D8）：`ON CONFLICT DO UPDATE` 以 `published_at = COALESCE(ai_news_events.published_at, excluded.published_at)` 做 identity-preserving NULL-fill——首条 raw_item 无日期、后到同 dedup_key raw_item 有日期时确定值自动补入。**关键推论（AI 已是稳态下的真正最后手段）**：因 COALESCE 在**每次** sibling 塌缩时把确定日期填入，故 backfill 阶段仍 `published_at IS NULL` ⟺「至此所有已塌缩的 raw_item 都无发布时间」。因此进入 AI 推断的事件，必是**所有**关联 raw_item 均无发布时间者——无需在 backfill 内另跑 sibling 查询 pass。
- 回填：仅对 `published_at IS NULL` 行 `UPDATE`，且只在返回通过范围校验的明确日期时回填。
- **回填并发安全（Redis 锁 + CAS）**：回填写为 `UPDATE ai_news_events SET published_at = ? WHERE event_id = ? AND published_at IS NULL AND ? <= now()`（DB 层 compare-and-set + 范围兜底）。先写者落值、后写者 `WHERE` 不命中空操作，**绝不覆盖**已非 NULL 值（来自采集 / 塌缩 COALESCE / 另一链路先一步回填）。为避免日报链/告警链对同一事件**重复调 LLM**，推断前以**独立 Redis per-event 单例锁** `published-at-infer:{event_id}` 抢占。该锁**复用** `alert-lock.ts:acquireAlertLock` 的获取/释放语义并在其外加一层降级（不落库），职责分层：`acquireAlertLock` 本体 = `SET key <token> NX PX <ttl>` 原子获取（TTL 覆盖「单次推断 + 单次 CAS 写」最坏时长，崩溃后经 TTL 自动释放；锁键无时间、无 TTL 会永久死锁）+ 返回 handle 的 `release()`（核对 token 的脚本删除）；调用方职责 = `finally` 中调 `release()`（防误删他人锁）、未抢到 → 跳过。**新增降级层**：`acquireAlertLock` 在 SET 出错时**会抛**（现有 `runAlertScan` 不 catch），故新模块必须 try/catch 把该抛错**降级**为「跳过本事件回填」、记日志、不抛断流水线（不得因 Redis 挂导致整条 workflow 崩）——这是新模块在 `acquireAlertLock` 之外额外加的，非其本体行为。**绝不复用评分链 `judge_claimed_at` 列**：该列条件 `importance_score IS NULL`、语义为「未评分 claim」，与「回填发生在评分后（importance_score 已非 NULL）」语义冲突、会争用同列；新建 claim 列又违反 D3「不加列、无迁移」。故回填防重复一律走 Redis 锁、不碰 DB claim 列（与 D3 自洽）。
- 降级（覆盖 LLM 与 DB 两类失败）：LLM 调用失败 / 超时 / schema 校验失败 / 范围越界 / 未抢到 Redis 锁 → 视为「无法判定（NULL）」或跳过；**回填 CAS 的 DB 写异常**（连接挂 / 死锁等）→ 同样 catch 降级、按该事件「未回填」处理，遵 `score-events.ts` 既有「写库异常计降级、不抛」口径。两类失败都**记录错误日志、不抛断流水线、不得中止 `runDailyWorkflow()` 其余阶段、绝不**回填 `now()` / `fetchedAt`。
- **回填阶段不计入降级熔断**：回填「判不出」是预期高比例的安全失败方向，禁止产生熔断阶段或计入 `DEGRADE_ABORT_RATIO` 分母（分母只含 Value Judge + 中文摘要两阶段），否则冷启动高判不出率会误中止正常日报（见 daily spec「每日定时单队列顺序编排」）。
- 重试：复用项目既有外部调用重试约定（与 Value Judge 同口径）。

**触发位置**：在两条链各自「选候选」之前插入一个回填阶段——
- 日报 `run-daily`：在 Value Judge 之后、`selectTopN` 之前，对「`published_at IS NULL` 且 `should_push=true`」的事件回填（受 D4 独立上限约束）。注意 `should_push` 由 Value Judge 写，故回填须在评分阶段之后；评分尚未跑的事件本轮 `should_push` 非 true、不进回填域，下一轮评分后再补，最终一致。
- 告警 `runAlertScan`：在 `selectAlertCandidates` 之前、对评分后达阈值且 `published_at IS NULL` 的事件回填（受 D4 独立上限约束）。

**替代方案（否决）**：在采集 `rss.ts` parseDate 缺失时即用 LLM 补——否决，因为采集阶段量大（每条 raw_item 都调 LLM 浪费），且很多条目根本不会进入候选；把推断挪到「选题前、已收窄的候选域」更省成本。

### D3：`published_at` 回填的 provenance — 本期不加列（定稿）
**决策：本期不加 provenance 列**。AI 推断结果直接写 `published_at`，与采集解析值同列、不可区分。理由：最小改动、不动 `platform-foundation` schema 单一事实来源；当前无审计「哪些发布时间是 AI 推断的」的硬需求。若后续需审计，再以独立 forward-only 迁移加布尔列 `published_at_inferred`（届时须同步 `platform-foundation` spec 的 schema 增量）。`basis`/`confidence` 字段仅用于运行期日志，不落库。

**「AI 写后才到的确定日期不被覆盖」是可接受残留（非缺陷）**：不加 provenance 列的代价是——若某事件在 backfill 时所有已塌缩 raw_item 都无日期（AI 因此写了推断值），之后又有带确定日期的新 raw_item 塌缩进同一事件，则 COALESCE 因 `published_at` 已非 NULL 而保留 AI 值、不被该确定值覆盖。判定为**可接受**且**非新缺陷**，理由：① 它与本提案为 `published_at` 新设的「`NULL`-fill 一次后即冻结」语义**一致**（不是沿用基线——基线对 `published_at` 本是更严的**全冻结**；但「时间列先写即定、不被后到改写」这一**设计取向**与既有 `first_seen_at`/`representative_*` 的全冻结同源，本提案只是把 `published_at` 从全冻结放宽为「NULL-fill 后冻结」，仍守同一取向）；② 触发条件罕见——要求同一事件先有「全部无日期」的 raw_item、AI 写值、再有确定日期 raw_item 后到；③ AI 值已过合理范围校验（`下限<=date<=now`），是受约束的近似而非任意值。若将来认定需「确定值始终压倒 AI」，再走 provenance 列方案。
**历史（部署前）数据**：COALESCE 仅对**部署后**发生的塌缩生效；部署前已 `collapsed=true` 的 sibling 不会重跑塌缩，其确定日期不会回填到当时 NULL 的事件——这类历史 NULL 事件由 AI 推断兜底，或按需做一次性历史回填（独立后续，非本期范围）。

### D4：回填规模必须有独立上限（修正先前「候选上限自然限流」的错误声称）
**修正**：回填阶段在「选 Top N / 应用 `ALERT_MAX_PER_SCAN`」**之前**执行，其作用域由 `should_push=true`（日报，可能数百条）/ 达阈值（告警）+ `published_at IS NULL` 决定，**远大于** Top N 条数或单次告警上限——故 Top N / `ALERT_MAX_PER_SCAN` **限不住**回填的 LLM 调用量。先前 design 称「成本受候选域/单次上限自然限流」**不成立**，冷启动存量 NULL 老事件会触发 LLM 成本尖峰。

**决策**：为回填设**独立单次上限** `PUBLISHED_AT_INFERENCE_MAX_PER_RUN`（新增 env，默认保守如 20，须进 `env.ts` 的 `envSchema` 以 `z.coerce.number().int().positive().default(20)` 校验、非法值启动即报错，守 env 全局不变量）。回填查询 `... WHERE published_at IS NULL AND <候选条件> AND first_seen_at >= <时效窗口下界> ORDER BY first_seen_at DESC LIMIT <上限>`（优先最近首见），超出者下轮补填。新增的是**推断成本闸**、非窗口配置项，不违反「不新增窗口 env」非目标。

**`first_seen_at >= 下界` 界（活性修复）**：`first_seen_at` 已超出时效窗口的存量 NULL 老事件——推断出发布时间也必被时效闸排除——不再纳入回填，避免冷启动积压老事件每轮占满 LIMIT 配额、饿死近期 NULL 并做无效 LLM 推断。窗口内仍判不出的事件随 `first_seen_at` 滑出窗口（N 天后）自然停止重试：retry 有界，无需持久 attempt 状态列（契合 D3「不加列」）。**成本封顶的诚实拆解**：①「每轮」总量由独立上限 `PUBLISHED_AT_INFERENCE_MAX_PER_RUN` 硬封；②「跨轮重复推断」（同一判不出事件在窗口内被多轮重选）由「每轮上限 + N 天后滑出窗口」封顶，**不**由 Redis 锁封（Redis 锁 TTL（秒级）≪ 轮间隔（告警 20min），只防**同一轮跨链路**重复、不防**跨轮**重复）。窗口内对同一判不出事件的跨轮有限次重试是已知、有界的成本，可接受。

### D5：注释与 spec 口径同步
`top-n.ts` / `alert-scan.ts` 顶部大段不变量注释中「候选窗口键于 `first_seen_at`」的口径，必须改为「键于 `published_at`（NULL 经 AI 推断、仍 NULL 则排除）」。规范层面该不变量陈述在 `daily-intel-pipeline` spec 的「Top N 组合分选择」需求正文（**非**某个编号 design 决策——OpenSpec 内无内容为「候选窗口键于 first_seen_at」的 design D 编号文档），已由本变更的 `daily-intel-pipeline/spec.md` delta 改写承载。`env.ts` 中 `FIRST_SEEN_WINDOW_DAYS` / `ALERT_FIRST_SEEN_WINDOW_DAYS` 的注释需说明：天数复用，但语义已从「抓取近 N 天」变为「发布近 N 天」（变量名保留以免破坏配置兼容）。

### D6：weekly-report 同维度 bug — 本期显式 scope-out（带理由与跟踪）
`src/pipeline/weekly-report.ts:249-250` 的 `selectWeeklyEvents` 同样以 `first_seen_at` 作汇总窗口键（`gte/lt(firstSeenAt, windowStart/End)`），属**同一根因**：周报启用后，冷启动/新增源的历史老文 `first_seen_at` 落进本周窗口会重演刷屏。

**决策：本期不改 weekly-report，显式 scope-out**。理由：① 周报当前默认禁用（`WEEKLY_REPORT_ENABLED=false`）、P2 已归档，非生产在跑路径；② 周报有自己的窗口语义（ISO 周边界 `[windowStart, windowEnd)`）与是否需要独立回填阶段的设计分支，纳入本提案会扩大变更面、拖慢这次生产 hotfix。**强制约束**：weekly-report **重新启用前必须**先把窗口键改为 `published_at`（同口径 NULL 处理），否则会重蹈本 bug——记入本提案非目标与跟踪项，不得静默遗忘。

### D7：GitHub 源 `published_at` 语义反例 — 记为已知局限
`src/collectors/github.ts:119` 写 `publishedAt: toDate(repo.pushed_at ?? repo.created_at)`——对 `github` 源 `published_at` 实为「仓库最后 push 时间」而非「首次发布时间」。改用 `published_at` 作时效闸后，活跃老仓被新 commit 推动会使其 `published_at` 变新、落进近 N 天窗口（被当「近期活跃」推送）。

**决策：本期接受为已知局限、不改采集器**（采集器口径属 source-collectors 职责，且「最近活跃的老仓」被纳入未必算误推）。在 spec 与本节记录：`published_at` 在 GitHub 源语义为「最近活跃」而非「首次发布」；若后续判定为问题，再评估对 repo 类事件改用 `created_at` 或排除出时效闸。不得在任何 spec 把「published_at = 真实首次发布时间」当全局不变量陈述。

### D8：塌缩层确定性 NULL-fill（确定性事实优先于 AI 推断）
**问题**：现有去重塌缩（`collapse.ts` / dedup-and-normalization spec）的 `ON CONFLICT DO UPDATE` 只累加 `source_count` / 更新 `last_seen_at`，**冻结** `published_at`。故首条 raw_item 无发布时间、后到的同 dedup_key raw_item 有确定发布时间时，事件 `published_at` 仍为 NULL——若直接交 AI 推断，等于把 **DB 已有的确定事实**交给 LLM 臆测，违反第一架构原则「DB 控事实、不交 LLM」，且可能误排除。

**决策**：给 dedup-and-normalization 的「基于 dedup_key 的硬去重塌缩」加一条窄 MODIFIED——`ON CONFLICT DO UPDATE` 用 `published_at = COALESCE(ai_news_events.published_at, excluded.published_at)` 做 **identity-preserving NULL-fill**：仅当事件当前 `published_at IS NULL` 时用后到 raw_item 的非 NULL 值补入，`COALESCE` 保证**已设值绝不被覆盖**（只允许 `NULL → 已知` 单向）、身份/代表/`first_seen_at` 仍冻结。这把确定性事实留在确定性层，AI 推断只兜底「所有关联 raw_item 都无日期」者。

**并发塌缩的确定性预期（显式声明）**：`excluded` 为「本次 proposed insertion row」。多条同 `dedup_key` 但日期不同的 raw_item 并发塌缩时，`UNIQUE(dedup_key)` 使仅一条 INSERT 成功、其余转 `ON CONFLICT DO UPDATE`；NULL-fill 最终取**先抢到行锁那条**的确定日期——取哪一条依到达序、非全序确定，但**始终是某条真实 raw_item 的确定发布时间**（不丢、不臆造）。这与现有「首建代表 = 第一条命中的 raw_item」的到达序语义一致；契约只承诺「填入某个确定发布时间」（任一确定值都满足时效闸语义），不承诺「选最早/最晚」。如此无需 per-dedup 序列化锁或聚合子查询。

**替代方案（否决）**：在 published-at-inference 模块内查询兄弟 raw_items（按 `sha256(canonical_url)/sha256(title_hash)=dedup_key` 匹配）取确定值——否决，比塌缩层 COALESCE 多一次 join/grep、且与塌缩天然时机错位；COALESCE 在塌缩当刻一步到位、更简更对。

## 风险 / 权衡

- [AI 推断不准 → 回填错误发布时间，可能放行真老文或误杀新文] → schema 校验 + **合理范围 refine（拒未来/荒谬，越界即 NULL，见 D2）** + 「判不出即 NULL 排除」的保守缺省；推断只在收窄候选域生效，错误影响面有限；`basis` 入日志便于事后排查。
- [AI 推断返回未来/荒谬日期绕过时效闸] → D2 双层防御：Zod `refine`（`下限<=date<=now`）+ 回填 SQL `WHERE date <= now()` 兜底；越界降级为 NULL 排除。
- [日报链/告警链并发回填同一事件 → 重复 LLM 调用或覆盖] → D2 CAS（`UPDATE ... WHERE published_at IS NULL`）防覆盖 + **独立 Redis per-event 锁**（不复用 judge_claimed_at 列）防重复调用。
- [回填「判不出」高比例被误计入降级率 → 误熔断中止正常日报] → D2/daily spec 显式声明回填不产生熔断阶段、不入 `DEGRADE_ABORT_RATIO` 分母（只含 Value Judge + 摘要两阶段）。
- [塌缩冻结 published_at → DB 已有确定日期被交给 LLM 推断] → D8 塌缩层 `COALESCE` identity-preserving NULL-fill，确定性事实优先、AI 仅兜底无日期者。
- [冷启动积压超窗老 NULL 占满回填配额、饿死近期 NULL + 无效推断] → D4 回填域加 `first_seen_at >= 下界`，超窗老事件不纳入；窗口内重试有界（N 天后滑出）。
- [新 env 裸读绕过校验 → 非法值不报错] → 进 `envSchema` 以 `z.coerce.number().int().positive().default(20)` 校验，非法即启动失败（守 env 全局不变量）。
- [AI 推断增加 LLM 调用成本与延迟] → D4 范围收窄（仅候选域 + 仅 NULL）+ **独立单次上限 `PUBLISHED_AT_INFERENCE_MAX_PER_RUN`**；失败降级不阻塞。
- [变量名 `FIRST_SEEN_WINDOW_DAYS` 语义已变但名未改 → 误读] → 注释显式说明语义迁移；本期不改名以保配置兼容（改名属破坏性，留待后续）。
- [冷启动存量 NULL `published_at` 老事件，AI 集中推断成本尖峰] → D4 独立单次上限 + `ORDER BY first_seen_at DESC LIMIT` 分轮补填封顶（不再误以为靠 N/告警上限限流）。
- [Drizzle `gte` 对 NULL 返回假，依赖此行为做「过滤即排除」] → 是预期语义，加测试固化（NULL published_at 不入候选）。**告警 `windowDays=0` 旁路须额外 `isNotNull(publishedAt)`**（D1），否则旁路时 NULL 不被排除。
- [weekly-report 同维度 first_seen_at bug 未改] → D6 显式 scope-out + 启用前必改的强制约束 + 跟踪项，不静默遗漏。
- [GitHub 源 published_at = pushed_at 非首次发布] → D7 记为已知局限；不在 spec 把「published_at=真实发布」当全局不变量。
- [`ai_news_events` 无 `published_at` 索引，三处过滤 + 回填扫描全表] → 当前数据量小可接受；量级增长时补 partial index `on (published_at)` / `on (event...) where published_at is null`，记入迁移计划与影响清单。

## 迁移计划

1. 实现 AI 推断模块（含范围 refine + CAS + Redis 锁 + 独立上限 + first_seen 下界）+ 塌缩层 `COALESCE` NULL-fill（D8）+ 两条链回填阶段（不计入熔断）+ 两处候选窗口改字段 + 告警 `windowDays=0` 补 `isNotNull`；同步注释与 spec/design 口径。
2. 无 DB schema 迁移（D3 定稿不加 provenance 列；D8 仅改 `ON CONFLICT` 的 `set` 子句、不动表结构）。仅新增 env `PUBLISHED_AT_INFERENCE_MAX_PER_RUN`（进 `envSchema` 校验）。
3. 单元/集成测试覆盖：老文（published 旧）不入候选、NULL 经推断回填入候选、AI 判不出被排除、未来/荒谬日期被拒、并发回填 CAS 不覆盖、回填受独立上限、推断失败降级不阻塞、窗口时区边界（上海日界 ±1s）、`windowDays=0` 仍排除 NULL、幂等四元组改字段后不变。
4. 部署后观察一两个日报周期与告警轮次，确认不再推历史老文。
5. 回滚：纯代码回滚（revert PR）即恢复旧行为；无 DB 迁移需回滚。

## 待解决问题（已收敛，非阻塞）

- AI 推断的开关 / 超时 / 重试：**复用现有 LLM 调用配置**（不新增除 `PUBLISHED_AT_INFERENCE_MAX_PER_RUN` 外的 env），定稿。
- AI 推断正文线索来源：实现时确认 raw_item 是否存全文/摘要还是仅 title+url；线索过少时推断「判不出」比例升高——这是**安全失败方向**（判不出即排除、不误推），不阻塞设计，apply 期实测「判不出」率并据此决定是否需要补全文抓取（独立后续优化）。
