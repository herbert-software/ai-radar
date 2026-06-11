## 新增需求

### 需求:重大发布事件级实时告警

系统必须提供一条独立于每日日报的实时告警路径：当一个**已完成 Value Judge 评分**的事件达到「重大发布」阈值时，比每日 08:xx 日报更早推送告警。判定必须由**确定性程序阈值**决定，**绑定 `ai_news_events.importance_score`**：默认阈值 `importance_score >= 85`（严于日报候选 `should_push` 的 `importance >= 75` 与 Top N 下限闸 `>= 60`——实时门槛应更高以防告警刷屏），阈值经环境配置可调。禁止由 LLM 决定是否触发告警。

**判定时点与评分先后必须明确**：`importance_score` 由 Value Judge 写入，采集后、评分前该列为 NULL（`NULL >= 85` 恒假），故阈值判定必须在评分**之后**。但若告警只被动等日报链评分，则告警退化为「日报后才触发」、失去实时性。因此实时告警由一个**更高频的轻量工作流**承载（频率 env 可配，默认保守如 15–30 分钟），按纯顺序确定性流执行：采集 → 规范化/硬去重塌缩 → **对新塌缩的未评分事件执行 Value Judge 评分** → 在**评分后**对 `importance_score IS NOT NULL AND >= 阈值` 且尚未告警者推送。禁止把各阶段拆成相互投递的复杂队列图。所有外部推送调用必须带重试与错误日志。

**高频链路的采集源子集必须显式裁剪（绝不可省）**：高频链路**不得复用日报的完整 registry**——它必须只采集**实时性新闻类源 `{rss, hacker_news, github}`**，**显式排除 arXiv**（非实时源，source-collectors 已禁其接入实时告警路径；且 ≥3s 串行节流不适合高频）与 **Product Hunt**（产品源、GraphQL 复杂度配额受限，高频会与日报链争抢配额打满）。否则高频链路每 15–30min 跑一次 arXiv/PH 会违反 arXiv 非实时约束并耗尽 PH 配额。

**与日报链的并发评分必须原子 claim（绝不可省）**：高频告警链路与日报链路可能**同时**对同一未评分事件跑 Value Judge。仅靠「只处理未评分」不防并发双评分，必须用 daily-intel-pipeline「降级逐条容错」定义的**原子 claim**（`UPDATE ... SET judge_claimed_at WHERE *_score IS NULL AND (judge_claimed_at IS NULL OR judge_claimed_at < now() - interval 'T') RETURNING` / `FOR UPDATE SKIP LOCKED`，含超时回收防僵尸 claim 永久漏评），只有 claim 成功的链路送 LLM——保证「一事件只评一次分、永不覆写、崩溃不致永久漏评」跨两链路成立。

**高频链路不套用日报的「全源返回 0」系统级告警**：高频轮询全源返回 0 / 无新内容是常态，若套用日报的全失败告警会每天数十次误告警刷屏；故高频告警链路的全源 0 / 无新事件按正常空轮处理、不告警（见 daily-intel-pipeline）。

> 此设计同时满足：① 阈值判定永远在 `importance_score` 写入之后（不 `NULL >= 85` 误判）；② 告警由高频小链路提前评分触发、不等日报，保留实时性；③ 原子 claim 防与日报链双评分。

**P2 局部不变量声明**：本能力的「一事件对每个通道一生只 success 告警一次」依赖「`importance_score` 一经评分即稳定（Value Judge 不重判已评分）」。这是 **P2 局部不变量**；P3 若引入事件合并/重评分（分数可回填重算），必须重新评估告警幂等口径（届时「跨天再次达阈值」可能变为可达，需重新设计 alert 候选窗口）。

#### 场景:高频小链路评分后达阈值的事件被实时告警
- **当** 高频告警工作流采集/塌缩新事件并经 Value Judge 评分后，某事件 `importance_score IS NOT NULL AND >= 阈值`（默认 85）且尚未告警
- **那么** 系统不等每日 08:xx 日报，在该高频链路内即通过配置通道推送该事件告警

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

### 需求:实时告警独立幂等口径

系统必须以 `push_records` 唯一约束保障实时告警不重复推送。告警四元组必须为 `target_type='alert'`、`target_id=event_id`、`channel`、`push_date=告警触发当日（Asia/Shanghai，与日报 push_date 时区同源）`。独立 `target_type='alert'` 使其与日报推送（`target_type='event'`）在 `push_records` 中互不挤占——禁止复用日报四元组，否则「当日日报已 success 推过该事件」会使实时告警因唯一键冲突被静默吞掉（漏告警），反之亦然。

**幂等语义为「一个事件对每个通道一生只 `success` 告警一次」**（统一模型 Model B：选题与通道解耦 + 各通道可靠补发）：`ai_news_events.importance_score` 一经 Value Judge 评分即稳定（Value Judge 不重判已评分事件），故告警分数不会跨天变化，「跨天再次达阈值」在本系统结构上不会发生、不设此行为。告警候选（channel-blind 选一份）必须满足「该 `event_id` **尚未 alert-success 投递给所有已配置通道**」（alert-success 覆盖的 distinct 已配置通道数 < 配置通道数）——只要还差任一通道未 alert-success 就留在候选；选出的告警事件**同份发放给所有已配置通道**（通道只投递、不参与选题）。**各通道可靠补发（不丢告警）**：各通道经 dispatcher `computePendingSet` 按 **per-channel 跨天**（该 channel 从未 alert-success）独立投递——某通道（如飞书）告警失败时该事件在该 channel 无 success → 跨次扫描仍在该通道待发 → 可靠补发，已 alert-success 的通道（如 telegram）被排除、不重发；同日并发由 `UNIQUE(alert, event_id, channel, push_date)` 兜底。一旦所有已配置通道都 alert-success → 该事件移出告警候选（不再重选）。

告警推送必须**复用 telegram-push/feishu-push 的同一套「待发→`pending`→原子送达→`success`/`failed`」状态机核心**（仅 `target_type` 与幂等键口径不同），禁止另写一套漂移的状态机。告警事件在高频链路评分后可能尚无中文摘要（`headline_zh`/`summary_zh` 为 NULL），故告警消息渲染必须**复用 telegram-push 的 headline 回退链**（`headline_zh` → `summary_zh` 截断 → `representative_title` → 仅标题），不因摘要缺失报错或漏告警。告警推送路径必须带**独立单例锁** `alert:{event_id}`（**per-event，覆盖该事件向所有通道的分发**）或 DB 原子 claim，防两并发实例对同一告警事件重复分发（唯一约束挡不住并发双读双发）；单通道发送失败隔离、不拖垮该事件的其余通道。该锁必须为 job 级短时持有 + 完成/崩溃后可靠释放（带 TTL 或 `finally` 释放）——锁键含 `event_id` 但不含时间，若无 TTL 且崩溃未释放会使该事件告警永久死锁，故释放语义不可省（同 telegram-push 单例锁的 TTL/释放要求）。

#### 场景:日报已推同一事件仍可发实时告警
- **当** 某事件当日已作为日报（`target_type='event'`）success 推送
- **那么** 该事件的实时告警（`target_type='alert'`）不因日报记录而被唯一键冲突吞掉，仍可独立推送

#### 场景:已告警给所有通道的事件不再重复告警
- **当** 同一已评分达阈值事件已 alert-success 投递给所有已配置通道，后续轮询再次扫到
- **那么** 该事件因「尚未 alert-success 投递给所有已配置通道」候选条件不满足（已全部告警）而被排除，不再重复告警；同日并发重复触发亦由 `UNIQUE(alert, event_id, channel, push_date)` 兜底跳过

#### 场景:某通道告警失败后跨次可靠补发
- **当** 某达阈值事件 telegram 告警 success、飞书告警失败（飞书无 alert-success），已配置 telegram + feishu
- **那么** 该事件仍在告警候选（飞书尚缺）；后续扫描其飞书 `computePendingSet` 纳入它（飞书从未 alert-success）可靠补发，telegram 被排除不重发——不丢告警
