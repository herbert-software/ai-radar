## 为什么

P0（bootstrap-walking-skeleton）已落地三张承重表、`push_records` 唯一约束、Value Judge Agent 骨架与一条 seed→判断→落库→读回的验证脚手架，但**没有任何真实数据流**：raw_items 靠 seed 假数据，没有采集、没有去重、没有摘要、没有推送、没有调度。

P1 是 ROADMAP 里的**首个真上线版本**：把脚手架接成端到端的每日情报流水线，用最简实现纵向打通「采集 → 规范化/去重 → 价值判断 → 中文摘要 → Telegram 推送」整条最小链路，并由 BullMQ 每日定时驱动。最难、最不确定的语义去重（embedding/LLM）刻意留到有真实数据积累之后的 P3，P1 只做确定性的硬去重，先把管道跑起来。

## 变更内容

- **三源 collector**（新增）：RSS、Hacker News、GitHub 三个确定性采集器，统一结构写入 `raw_items`，靠稳定 `source_item_id` 做源内幂等。
- **规范化 + 硬去重**（新增）：填充此前空置的 `canonical_url`（去 utm/ref/gclid/fbclid/spm 等追踪参数）；计算 `title_hash`（标题归一化）；以 `dedup_key = sha256(canonical_url ‖ title_hash)` 经 `ON CONFLICT` 把同一事件的多条 raw_item 塌缩为一条 `ai_news_events`。P1 仅做硬去重，不做 embedding/LLM 去重。
- **中文摘要 Agent**（新增）：与 Value Judge 同规格（`generateObject` + Zod 校验 + 有限重试 + 降级），为入选事件生成中文摘要 `summary_zh`。
- **Telegram 推送**（新增）：grammY 单通道，把每日 Top N 打包成一条日报消息；幂等按 event 粒度，经 `push_records` 唯一约束 + 显式「待发集合排除今日已 success」+ 全局单例锁保证「同一天同一条不重复」。
- **每日情报流水线**（新增）：BullMQ 单队列单 worker 顺序编排（定时触发 + 整 job 重试外壳）；组合分排序取 Top N；Value Judge 降级率熔断。
- **数据模型修正**（**BREAKING**，修改 platform-foundation）：`ai_news_events.event_id` 由内容哈希改为不透明 surrogate key（UUID），另加 `dedup_key UNIQUE` 与 `representative_raw_item_id`；`raw_items` 新增 `title_hash`。理由见 design.md——内容哈希当主键会让 P3 语义合并时历史引用无法迁移。P0 仅 seed 数据，迁移无生产数据负担。
- **Value Judge 演进**（修改 value-judge-agent）：从 seed 雏形演进为流水线内对真实 raw_item 的逐条判断，接入降级计数与熔断；输出契约保持 Zod 校验不变。

## 功能 (Capabilities)

### 新增功能
- `source-collectors`: RSS / Hacker News / GitHub 三源确定性采集，统一写入 raw_items，稳定 source_item_id 源内幂等，外部调用带重试与错误日志。
- `dedup-and-normalization`: URL 规范化生成 canonical_url、标题归一化生成 title_hash（均为版本化纯函数）、以 dedup_key 经 ON CONFLICT 塌缩为单一 ai_news_events 事件、URL 缺失且标题归一后为空串的条目标记 unprocessable 不入 event。
- `chinese-digest-agent`: 为入选事件生成中文摘要的 Agent，generateObject + Zod 校验 + 有限重试 + 降级（失败回退代表标题或剔除，绝不推半截输出）。
- `telegram-push`: Telegram 单通道推送 dispatcher，每日 Top N 打包单条日报；幂等状态机（待发集合 = 今日 Top N MINUS 今日已 success；单消息原子整批 success/failed）+ 全局单例锁防并发重发。
- `daily-intel-pipeline`: BullMQ 每日定时单队列顺序编排（collect→去重→判断→Top N 选择→摘要→推送），Top N 组合分排序 + 下限闸 + 确定性 tiebreaker，Value Judge 降级率熔断。

### 修改功能
- `platform-foundation`: 数据库 schema 演进——event_id 改 surrogate UUID 主键、新增 dedup_key(UNIQUE) 与 representative_raw_item_id、raw_items 新增 title_hash 列、canonical_url 由「建好不填」转为「采集即填值」的约定。
- `value-judge-agent`: 由 seed 验证脚手架演进为流水线内对真实 raw_item 的逐条价值判断，接入降级计数（熔断逻辑本身归属 daily-intel-pipeline 编排）；输出 Zod 契约与降级语义保持不变。

## 影响

- **数据库**：新增一次 Drizzle migration（surrogate event_id、dedup_key、representative_raw_item_id、title_hash）。因 P0 仅 seed 数据，无生产数据迁移负担。
- **依赖**：新增 grammY（Telegram）、RSS 解析库、BullMQ 重复任务（Redis 已在 docker-compose）。
- **配置（.env）**：新增 Telegram bot token / chat id、Top N 与组合分权重、importance 下限、push_date 时区（Asia/Shanghai）、降级率熔断阈值、collector 源清单。
- **代码**：复用 P0 的 value-judge 落库路径；seed 脚手架被真实流水线替换。
- **非目标（不在本期，明确不做）**：embedding 语义去重、LLM 二次去重、跨源事件合并（均 P3）；**基于 `source_count` 的多源印证重评分（QA §11.1 `multi_source_signal`）——P1 事件只评分一次，重评分留待 P3 与语义合并共用设施**；飞书通道、Product Hunt/Reddit/arXiv 源、产品发现（P2）；MCP 查询入口（P4）；知识库入库（P3）。**确定性状态（去重、幂等、唯一约束、Top N 排序）一律由程序与 DB 保障，绝不交给 LLM。**
- **已知限制（P1 接受）**：
  - 同一 canonical_url 被改写内容会被判为同一 event 而漏推（dedup_key 刻意不掺 published_at，否则削弱跨天去重）；后续期次再处理。
  - Telegram 推送为 at-least-once：若消息已送达但 API 响应在网络层丢失，dispatcher 会判失败并在下次重试，可能导致同一日报双发。push_records 唯一键拦不住此假失败。P1 接受此低概率双发，后续可加 Telegram 端幂等手段。
  - Top N 排序 tiebreaker 最终落到 `event_id ASC`（随机 UUID）：当多个事件 `rank_score` 与 `published_at` 全等时，「哪条压线入选」由随机 UUID 决定。对同一批已落库事件多次排序结果一致（UUID 落库即固定），但「同一篇新闻的两次独立流水线运行」可能给出不同入选边界。P1 接受（单跑、rank_score 精确相等概率低）。
  - 无 canonical_url 的条目（source_item_id 走内容哈希兜底）若标题被改写至归一后不同，会被判为新 event 而可能重复推送——这是「同 canonical_url 改写漏推」的对偶限制，P1 同样接受。
  - **事件只评分一次**：Value Judge 只判未评分事件（`*_score IS NULL`），已评分事件后续被新来源塌缩（`source_count++`）时不重判。这有两面后果，P1 都接受：①首判分够格者可能以**首判旧分**进入候选（内容已变但分未更新）；②首判 `should_push=false` 者即便后续多源印证增强（QA §11.1 的 `multi_source_signal>=2` 本应触发推送），也因不重判而 `should_push` 永为 false → **该推的被永久漏推**。多源印证重评分属 P3（与语义合并共用设施），P1 明确不做（见非目标）。
  - **Top N 连续为空不告警**：当某天所有候选都已 success 推过（常青事件被「从未 success」窗口排除），或全部候选低于 importance 下限闸 → Top N 为空 → 正常不推。系统无法区分「真的没有新内容」与「采集源已死但仍吐缓存旧条目」（后者每天仍返回可处理的旧条目、不触发采集层告警）。区分二者需「连续 K 天 Top N 空」之类启发式监控，超出 P1 确定性范围，留待 P2+ 可观测性增强。
  - **QA §11.1 推送 OR 条件由 should_push 表达，程序侧不建离散规则闸**：QA §11.1 把 `importance>=75`/`developer_relevance>=80`/`multi_source_signal>=2`/`category 属重点范围` 列为推送的离散 OR 条件。P1 不在程序侧实现这些离散规则闸——推送候选统一由 Value Judge 的 `should_push` 表达（LLM 综合各语义维度判断得出，符合「Agent 控语义判断」铁律），程序侧只做 Top N 组合分排序 + importance 下限闸。逐维度去向（如实记录，避免「算了丢弃」被掩盖）：
    - `importance` / `developer_relevance` / `novelty` / `hype_risk`：进 rank_score 组合分（importance 另设下限闸）。
    - `multi_source_signal`：因「事件只评分一次」不生效（见上），归 P3。
    - `category`：Value Judge 按 QA §10.4 契约仍产出该字段并经 Zod 校验，但 P1 **不落库**（`ai_news_events` 不设 category 列）、**不做任何程序消费**（不进 rank_score、不与 should_push 程序联动）；其推送语义是否被 LLM 内化进 should_push 取决于 LLM 内部、无程序保证或验证。P1 不为「category 属重点范围必推」建确定性兜底闸（留待后续按需）。
    - `source_quality`：P1 不计算来源质量分（Value Judge 输出 schema 无此字段、rank_score 不含它），归 P2+/后续。
    - `is_ai_related` / `type` / `reason`（§10.4 的其余 Value Judge 输出字段）：按契约产出并经 Zod 校验，但 P1 **不落库、不做程序消费**——`ai_news_events.event_type` 列在 P1 不接 `type`、保持为空；`reason`（判断理由）仅可用于错误日志/调试，不入库。后续期次按需再消费，本期保留输出契约即可。
  - **unprocessable 率告警仅在 100% 触发**：采集/规范化层告警只在「可处理条目数为 0（全 unprocessable）」时触发；中间高失败率（如归一函数部分退化致 50%–99% unprocessable）不触发，留待 P2+ 可观测性增强。
  - representative_title 取代表 raw_item 的原始 title；极个别条目原始 title 为空串（`title` 列 `NOT NULL` 但允许 `''`）时，摘要降级回退会退化为以 canonical_url 兜底展示。低概率，P1 接受。
  - 日报为单条 Telegram 消息，受消息长度上限约束：当日 Top N 摘要总长超限时按事件块截断，**被截断的尾部事件不丢失**（保持 `pending`、跨天因 never-success 仍在候选、下次运行重发），仅顺延；发生截断时记可观测告警。默认 `TOP_N`=8 × 短中文摘要远低于上限、正常不触发；若 Top N 摘要总长持续超限，尾部可能延迟多日。后续可加分批多消息 / 老化提权。另：单条消息原子发送下，若前缀含一条导致整条发送失败的事件，该批会反复失败、尾部轮不到——MarkdownV2 已对全部保留字符完整转义、正常不触发。P1 接受。
