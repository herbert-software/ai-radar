## 修改需求

### 需求:重大发布事件级实时告警

系统必须提供一条独立于每日日报的实时告警路径：当一个**已完成 Value Judge 评分**的事件达到「重大发布」阈值时，比每日 08:xx 日报更早推送告警。判定必须由**确定性程序阈值**决定，**绑定 `ai_news_events.importance_score`**：默认阈值 `importance_score >= 85`（严于日报候选 `should_push` 的 `importance >= 75` 与 Top N 下限闸 `>= 60`——实时门槛应更高以防告警刷屏），阈值经环境配置可调。禁止由 LLM 决定是否触发告警。

**告警候选必须带基于发布时间 `published_at` 的时效窗口（绝不可基于 `first_seen_at`）**：仅对 `published_at` 在近 N 天内的事件告警，复用现有窗口天数配置（`ALERT_FIRST_SEEN_WINDOW_DAYS`，默认 3）。时效闸**禁止基于抓取时间 `first_seen_at`**——`first_seen_at` 是 raw_item 入库时刻，冷启动/新增源时历史老文的 `first_seen_at` 恰为「今天」，以它做窗口会把老文误当重大发布刷屏告警。`published_at` 为 NULL 的事件必须先经 `published-at-inference` 能力的 AI 推断回填：推断成功则以回填后的 `published_at` 判定，AI 仍无法判定（保持 NULL）则**排除出告警候选**。单次扫描上限内的取序须以 `published_at` 衡量「最新」（不再以 `first_seen_at` 排序）。`first_seen_at` 语义不变，仅不再用于告警时效过滤。

**告警时效闸同为闭区间 `lowerBound <= published_at <= now`，未来日期上界绝不可省**：与日报同口径，除下界外必须加未来日期上界 `published_at <= now`，拦住确定性来源（RSS/GitHub 等）与 AI 的任何未来值（未来值 `>= 下界` 恒真会绕过下界闸被当「重大发布」刷屏告警）。

**`published_at IS NULL` 与未来日期的排除不依赖窗口大小（绝不可省）**：`ALERT_FIRST_SEEN_WINDOW_DAYS=0` 表示「不限时效窗口」（旁路 `published_at >= 下界` 的下界 `gte` 闸）。即便处于该旁路，告警候选仍必须满足 `published_at IS NOT NULL AND published_at <= now`——`windowDays=0` 只免除**下界**「近 N 天」gte，**不免除** NULL 排除与未来日期上界（否则旧 NULL/未推断成功/未来日期的事件会绕过修复在告警链刷屏）。即：`windowDays>0` 时候选条件为 `下界 <= published_at <= now`（已隐含非 NULL）；`windowDays=0` 时候选条件为 `published_at IS NOT NULL AND published_at <= now`。

**时区比较口径与日报同源**：`published_at` 为带时区发布绝对时刻，时效下界由 `startOfDayInTimeZone`（Asia/Shanghai，与日报 `push_date` 同源）换算为 UTC 绝对时刻，时效闸为两绝对时刻比较（见 daily-intel-pipeline「Top N 组合分选择」同口径说明）。

**判定时点与评分先后必须明确**：`importance_score` 由 Value Judge 写入，采集后、评分前该列为 NULL（`NULL >= 85` 恒假），故阈值判定必须在评分**之后**。但若告警只被动等日报链评分，则告警退化为「日报后才触发」、失去实时性。因此实时告警由一个**更高频的轻量工作流**承载（频率 env 可配，默认保守如 15–30 分钟），按纯顺序确定性流执行：采集 → 规范化/硬去重塌缩 → **对新塌缩的未评分事件执行 Value Judge 评分** → 在**评分后**对 `importance_score IS NOT NULL AND >= 阈值` 且 `published_at` 在近 N 天（NULL 经 AI 推断、仍 NULL 则排除）且尚未告警者推送。禁止把各阶段拆成相互投递的复杂队列图。所有外部推送调用必须带重试与错误日志。

**高频链路的采集源子集必须显式裁剪（绝不可省）**：高频链路**不得复用日报的完整 registry**——它必须只采集**实时性新闻类源 `{rss, hacker_news, github}`**，**显式排除 arXiv**（非实时源，source-collectors 已禁其接入实时告警路径；且 ≥3s 串行节流不适合高频）与 **Product Hunt**（产品源、GraphQL 复杂度配额受限，高频会与日报链争抢配额打满）。否则高频链路每 15–30min 跑一次 arXiv/PH 会违反 arXiv 非实时约束并耗尽 PH 配额。

**与日报链的并发评分必须原子 claim（绝不可省）**：高频告警链路与日报链路可能**同时**对同一未评分事件跑 Value Judge。仅靠「只处理未评分」不防并发双评分，必须用 daily-intel-pipeline「降级逐条容错」定义的**原子 claim**（`UPDATE ... SET judge_claimed_at WHERE *_score IS NULL AND (judge_claimed_at IS NULL OR judge_claimed_at < now() - interval 'T') RETURNING` / `FOR UPDATE SKIP LOCKED`，含超时回收防僵尸 claim 永久漏评），只有 claim 成功的链路送 LLM——保证「一事件只评一次分、永不覆写、崩溃不致永久漏评」跨两链路成立。

**高频链路不套用日报的「全源返回 0」系统级告警**：高频轮询全源返回 0 / 无新内容是常态，若套用日报的全失败告警会每天数十次误告警刷屏；故高频告警链路的全源 0 / 无新事件按正常空轮处理、不告警（见 daily-intel-pipeline）。

> 此设计同时满足：① 阈值判定永远在 `importance_score` 写入之后（不 `NULL >= 85` 误判）；② 告警由高频小链路提前评分触发、不等日报，保留实时性；③ 原子 claim 防与日报链双评分；④ 时效窗口基于 `published_at`，冷启动/新增源不把历史老文误当重大发布告警。

**P2 局部不变量声明**：本能力的「一事件对每个通道一生只 success 告警一次」依赖「`importance_score` 一经评分即稳定（Value Judge 不重判已评分）」。这是 **P2 局部不变量**；P3 若引入事件合并/重评分（分数可回填重算），必须重新评估告警幂等口径（届时「跨天再次达阈值」可能变为可达，需重新设计 alert 候选窗口）。

#### 场景:高频小链路评分后达阈值的事件被实时告警
- **当** 高频告警工作流采集/塌缩新事件并经 Value Judge 评分后，某事件 `importance_score IS NOT NULL AND >= 阈值`（默认 85）、`published_at` 在近 N 天窗口内且尚未告警
- **那么** 系统不等每日 08:xx 日报，在该高频链路内即通过配置通道推送该事件告警

#### 场景:发布时间过旧的高分事件不告警
- **当** 某事件 `importance_score >= 阈值`，但 `published_at` 早于近 N 天窗口（如历史老文因新增源今日才首次抓到，`first_seen_at` 为今天）
- **那么** 该事件不触发实时告警（按 `published_at` 判定不在近 N 天），不被误当重大发布刷屏

#### 场景:发布时间为未来的事件不告警
- **当** 某达阈值事件 `published_at` 晚于当前时刻（未来日期，无论来自确定性来源还是 AI）
- **那么** 该事件被时效闸上界 `published_at <= now` 排除、不触发告警

#### 场景:不限窗口时仍排除发布时间为空或未来的事件
- **当** `ALERT_FIRST_SEEN_WINDOW_DAYS=0`（不限时效窗口），某达阈值事件经推断后 `published_at` 仍为 NULL，或 `published_at` 为未来日期
- **那么** 该事件仍被排除出告警候选（候选条件退化为 `published_at IS NOT NULL AND published_at <= now`，`windowDays=0` 只免下界 gte、不免 NULL 排除与未来上界）

#### 场景:告警候选发布时间缺失经 AI 推断或排除
- **当** 某达阈值事件 `published_at` 为 NULL
- **那么** 系统先经 `published-at-inference` AI 推断：推断出明确日期则以回填后的 `published_at` 判定时效窗口；AI 仍无法判定则该事件被排除出告警候选（不告警）

#### 场景:评分前不以 NULL 误判为不达标
- **当** 事件在告警工作流的 Value Judge 评分阶段之前 `importance_score` 仍为 NULL
- **那么** 阈值判定发生在评分之后、不以 `NULL >= 阈值` 恒假误判为「不达标」，确保达阈值事件不被漏告警

#### 场景:低于阈值的已评分事件不触发告警
- **当** 某已评分事件 `importance_score` 低于实时告警阈值（如 80 < 85）
- **那么** 该事件不触发实时告警，仅按常规进入日报候选流程

#### 场景:高频链路只采实时新闻源排除 arXiv 与 PH
- **当** 高频告警工作流执行采集阶段
- **那么** 只采集 `{rss, hacker_news, github}` 实时新闻源，不采 arXiv（非实时、≥3s 节流）与 Product Hunt（产品源、配额受限），避免违反 arXiv 非实时约束与耗尽 PH 配额

#### 场景:是否告警由程序阈值决定
- **当** 判定某事件是否触发实时告警
- **那么** 判定完全依据程序阈值与确定性规则，禁止由 LLM 决定是否触发
