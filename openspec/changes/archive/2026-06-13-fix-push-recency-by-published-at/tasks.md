## 1. AI 发布时间推断模块（published-at-inference）

- [x] 1.1 新建 `src/agents/published-at-inference/`：定义 Zod 输出 schema `{ publishedAt: string | null, confidence?: number, basis?: string }`；以 `refine` 约束 `合理下限 <= publishedAt <= now`（拒未来日期与荒谬过早日期），越界视同 null（无法判定）
- [x] 1.2 实现推断函数：取事件 + 代表 raw_item（经 `representative_raw_item_id` 回指 raw_items，读 title / canonical_url / 正文或摘要 / 源），调 Vercel AI SDK `generateObject` 推断发布日期
- [x] 1.3 实现降级容错：调用失败 / 超时 / schema 校验失败 / 范围越界 → 返回「无法判定（NULL）」+ 错误日志，绝不回填 now()/fetchedAt，绝不抛断；重试复用项目既有 LLM 调用约定
- [x] 1.4 实现回填 CAS：`UPDATE ai_news_events SET published_at = ? WHERE event_id = ? AND published_at IS NULL AND ? <= now()`（DB 层 compare-and-set + 范围兜底），保证不覆盖已非 NULL；日报链/告警链并发回填同一事件时后写自动空操作
- [x] 1.5 实现回填防重复调用：推断前以**独立 Redis per-event 单例锁** `published-at-infer:{event_id}` 抢占——**复用** `alert-lock.ts:acquireAlertLock` 的获取/释放语义（`SET NX PX <ttl>` 原子获取、TTL 覆盖「单次推断+CAS 写」最坏时长、调用方 `finally` 经核对 token 的 `release()` 删除）、未抢到→跳过；并**在其外加一层降级**：`acquireAlertLock` 在 Redis SET 出错时会抛，新模块必须 try/catch 把该抛错降级为「跳过本事件回填」、不抛断（非 `acquireAlertLock` 本体行为）。**禁止复用 `judge_claimed_at` 列**（语义/条件冲突，见 design D2）
- [x] 1.5b 实现回填阶段失败降级：LLM 失败/超时/越界 → NULL；**回填 CAS 的 DB 写异常**（连接挂/死锁）→ catch、按「未回填」降级、记日志，遵 `score-events.ts` 既有「写库异常计降级不抛」口径，绝不冒泡中止流水线
- [x] 1.6 实现独立单次上限 + 超窗剪枝：新增 env `PUBLISHED_AT_INFERENCE_MAX_PER_RUN`（默认 20），回填查询 `... WHERE published_at IS NULL AND <候选条件> AND first_seen_at >= <时效窗口下界> ORDER BY first_seen_at DESC LIMIT <上限>`——超窗老 NULL 事件不纳入（推断出来也必出窗），超出上限者下轮补填
- [x] 1.7 单元测试：推断成功回填；无法判定保持 NULL 不臆造；未来/荒谬日期被拒（refine + SQL 兜底）；LLM 调用失败降级为 NULL 且不抛；**回填 CAS 的 DB 写异常按降级处理、不抛断**；**Redis 异常/未抢锁时跳过降级不抛、锁经 TTL+finally 释放不死锁**；不覆盖已有 published_at；并发两次回填同一事件经 Redis 锁仅一次调 LLM + CAS 仅一次落值；超出单次上限/超窗的事件本轮不回填

## 1b. 塌缩层确定性 published_at NULL-fill（D8，确定性优先于 AI）

- [x] 1b.1 `src/dedup/collapse.ts`：`onConflictDoUpdate` 的 `set` 增 `publishedAt: sql\`COALESCE(${aiNewsEvents.publishedAt}, EXCLUDED.published_at)\``（仅 NULL→已知单向补值，绝不覆盖已设值；身份/代表/first_seen_at 仍冻结）
- [x] 1b.2 单元测试：首建无日期 + 后到同 dedup_key 有确定日期 → COALESCE 补入；首建已有日期 + 后到不同日期 → 保持首建值不变；该事件补值后不再进 AI 推断域

## 2. 日报候选窗口改用 published_at（top-n.ts）

- [x] 2.1 `src/selection/top-n.ts:selectTopN`：`where` 中 `gte(aiNewsEvents.firstSeenAt, lowerBound)` 改为闭区间 `gte(aiNewsEvents.publishedAt, lowerBound)` **且** `lte(aiNewsEvents.publishedAt, now)`（未来日期上界，now 为同一参考时刻）；保留 windowLowerBound/startOfDayInTimeZone 同源逻辑不变
- [x] 2.2 更新该文件顶部不变量注释：候选窗口口径由「first_seen_at 近 N 天」改为「published_at 闭区间 lowerBound<=published_at<=now（NULL 经 AI 推断、仍 NULL 则排除；未来日期上界拦确定性来源/AI 的错误未来值）」
- [x] 2.3 单元/集成测试：published_at 旧的高分老文（first_seen_at=今天）不入候选；published_at 在窗口内的入候选；published_at 为 NULL 的不入候选（NULL 即排除）；**published_at 为未来日期（含来自确定性来源 RSS/GitHub）的不入候选（上界排除）**
- [x] 2.4 验证不破坏推送幂等与 Model B：已投递给所有通道的事件仍移出名单、缺通道的仍留名单（沿用现有 notDeliveredToAllChannels 测试，确认改字段后仍通过）

## 3. 告警候选窗口改用 published_at（alert-scan.ts）

- [x] 3.1 `src/pipeline/alert-scan.ts:selectAlertCandidates`：`gte(firstSeenAt, lowerBound)` → 闭区间 `gte(publishedAt, lowerBound)` 且 `lte(publishedAt, now)`（未来日期上界）；`orderBy(desc(firstSeenAt))` → `orderBy(desc(publishedAt))`（单次上限取最新发布）
- [x] 3.2 处理 `windowDays=0`（不限窗口）旁路：`lowerBound===null` 时 where 仍须含 `isNotNull(aiNewsEvents.publishedAt)` 且 `lte(aiNewsEvents.publishedAt, now)`（旁路只免下界 gte、不免 NULL 排除与未来上界）
- [x] 3.3 更新该文件顶部不变量注释与窗口语义说明（含闭区间上界 + windowDays=0 的 NULL/未来排除口径）
- [x] 3.4 单元/集成测试：达阈值但 published_at 过旧的事件不告警；published_at 在窗口内且达阈值的告警；published_at 为 NULL 的不告警；**published_at 为未来日期的不告警（上界排除）**；`windowDays=0` 时 NULL 与未来 published_at 仍被排除
- [x] 3.5 验证告警幂等不破坏：一生一次 success、UNIQUE(alert,event_id,channel,push_date) 兜底、failed 跨天可重试；显式断言 distinct-channel-count 子查询与四元组不依赖时效字段、改字段后语义零变化（沿用现有测试 + 新增针对性断言）

## 4. 两条链编排接入回填阶段（选题前）

- [x] 4.1 日报 run-daily：在 Value Judge 之后、`selectTopN` 之前插入回填阶段——对「should_push=true 且 published_at IS NULL」的收窄候选域调 published-at-inference 回填（受 1.6 上限/超窗剪枝约束）
- [x] 4.2 告警 runAlertScan：在 `selectAlertCandidates` 之前、对「评分后达阈值且 published_at IS NULL」的事件调回填（受 1.6 约束，与日报链回填经 1.4 CAS + 1.5 Redis 锁并发安全）
- [x] 4.3 回填阶段**不计入降级率熔断**：回填的「判不出/失败」绝不产生新熔断阶段、不进 `DEGRADE_ABORT_RATIO` 分母（分母仍只含 Value Judge + 中文摘要两阶段）
- [x] 4.4 集成测试：NULL published_at 事件经回填后能进入候选并被推送 / 告警；AI 判不出的被排除；回填失败不阻塞后续阶段；回填阶段确在 Value Judge 之后、Top N 之前；**回填高「判不出」率不触发 `DEGRADE_ABORT_RATIO` 误熔断**（构造高判不出批，断言日报正常产出不被中止）

## 5. 配置与文档口径同步

- [x] 5.1 `src/config/env.ts`：更新 `FIRST_SEEN_WINDOW_DAYS` / `ALERT_FIRST_SEEN_WINDOW_DAYS` 注释——天数复用、变量名保留，但语义由「抓取近 N 天」改为「发布近 N 天」；在 `envSchema` 新增 `PUBLISHED_AT_INFERENCE_MAX_PER_RUN: z.coerce.number().int().positive().default(20)`（推断成本闸，进 zod 校验、非法值启动即报错，守 env 全局不变量）
- [x] 5.2 校验/同步口径：确认 `daily-intel-pipeline` spec「Top N 组合分选择」需求正文已由本变更 daily delta 把「候选窗口键于 first_seen_at」改写为「键于 published_at（NULL 经 AI 推断、仍 NULL 则排除）」；同步 `top-n.ts`/`alert-scan.ts` 顶部注释（已在 2.2/3.3）。注：OpenSpec 内无内容为此的 design D 编号文档，勿引向幽灵文档
- [x] 5.3 provenance 定稿：本期**不加** `published_at_inferred` 列、不动 platform-foundation schema（见 design D3）；无需 DB 迁移
- [x] 5.4 weekly-report 跟踪项：在代码/跟踪处显式标注 `weekly-report.ts:249-250` 仍用 first_seen_at、启用前必须改 published_at（本期 scope-out，见 design D6），勿静默遗忘

## 6. 验收与回归

- [x] 6.1 全量 `pnpm test`（或项目测试命令）通过，类型检查通过；**额外断言** `PUBLISHED_AT_INFERENCE_MAX_PER_RUN` 经 `envSchema` 读取（非裸读 `process.env`）——构造非法值（负数/NaN）启动即 throw（类型检查抓不到裸读绕过，须运行期断言固化 design D4 意图）
- [x] 6.2 端到端验证：构造「新增源含历史老文」场景（seed 老 published_at + first_seen=今天），确认日报与告警都不再推送 published_at 过旧的老文；并构造「AI 回填出未来/荒谬日期」反向用例，确认被拒、不被误推
- [x] 6.3 时区边界可判定断言：① 下界——构造 `published_at = 上海今天 00:00 前 1 秒(UTC)` 与 `后 1 秒` 两条事件，断言前者出窗、后者入窗；② 上界——构造 `published_at = now` 与 `now + 1ms` 两条，断言前者入窗（`<=` 含等于）、后者出窗（未来排除）；并确认窗口「今天」与 push_date 同源 `startOfDayInTimeZone`（无第二套时区计算）、上下界共用同一 `now` 参考时刻
- [x] 6.4 幂等交互测试：NULL→回填→入候选→首推 success→次日同事件仍在窗口但已全通道 success→移出名单、不重推（验证回填不破坏「一生一次 success」跨天去重与 UNIQUE 四元组）
- [x] 6.5 并发互不干扰测试：评分链对某事件 claim（写 `judge_claimed_at`）期间，回填链对同一事件走独立 Redis 锁、不触 `judge_claimed_at`、不致漏评分；回填与评分并发时各自正确完成（证明 1.5 的锁隔离）
