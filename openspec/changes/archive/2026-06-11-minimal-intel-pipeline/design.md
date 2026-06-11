## 上下文

P0 交付了 walking skeleton：三张表（`raw_items` / `ai_news_events` / `push_records`）、`push_records` 唯一约束、Value Judge Agent 骨架（`generateObject` + Zod + 重试 + 降级）、env 校验，以及一条 seed→判断→落库→读回的验证脚手架。但没有真实数据流。

P1 把脚手架接成端到端每日流水线。本文件记录在探索阶段（`/opsx:explore` + Backend Architect 评审）敲定的关键技术决策——尤其是几处「现在不堵、P3 流血」的修正。逐行实现细节见 tasks.md，需求级行为见各 spec。

当前 schema 关键事实（决策的约束）：
- `ai_news_events.event_id` 是 `VARCHAR(128)` 主键；P0 seed 用 `seed-<rawItemId>` 填充。
- `raw_items` 有 `UNIQUE(source, source_item_id)`、有 `canonical_url` 列（未填值）、**无 `title_hash` 列**。
- 未建 `item_event_relations`（P0 注释「留待各自期次」）。

## 目标 / 非目标

**目标：**
- 纵向打通「采集 → 规范化/硬去重 → 价值判断 → 中文摘要 → Telegram 推送」最小链路，BullMQ 每日定时驱动。
- 满足三条可观测退出标准：每日定时推 Top N；同一天同一条不重复；带 utm 的 URL 归一为同一条。
- 数据模型一次性修正到「P3 语义合并不返工」的形态。

**非目标：**
- embedding 语义去重、LLM 二次去重、跨源事件合并（P3）。
- 飞书通道、Product Hunt/Reddit/arXiv 源、产品发现（P2）。
- MCP 查询入口（P4）、知识库入库（P3）。
- 把任何确定性状态（去重判定、推送幂等、Top N 排序）交给 LLM。

## 决策

### D1：`event_id` 改不透明 surrogate key，去重靠独立 `dedup_key UNIQUE`（最关键）

**决策**：`ai_news_events.event_id` 由「内容哈希 / seed 字符串」改为不透明 surrogate key。列类型**保留 `VARCHAR(128)`**（与 `push_records.target_id` 一致，使 `target_id=event_id` 互引类型相容——不可改成 PG `uuid` 类型否则两列不兼容），默认值设 `gen_random_uuid()::text`。塌缩 `INSERT` **省略 `event_id`** 由 DB 默认生成；应用层禁止用内容派生值填充。另加 `dedup_key TEXT` 列并建 `UNIQUE(dedup_key)`；事件塌缩用 `INSERT ... ON CONFLICT (dedup_key) DO UPDATE`，且 `UPDATE` 分支**只**累加 `source_count`、更新 `last_seen_at`，禁止覆盖 `event_id`/`representative_raw_item_id`/`first_seen_at`/`published_at`（P0 `persistEventScores` 的全列覆盖式 `set` 是反面模板，实现时不可照抄）。P0 的 `seed-<id>` 落库路径（`persistence.ts`）与 roundtrip 测试由真实塌缩路径替换。

**理由 / 替代方案**：探索初稿想用 `event_id = sha256(canonical_url)` 当主键，靠主键 `ON CONFLICT` 自动塌缩——优雅但埋雷：主键编码了「身份来源」。P3 语义合并要把 event_A、event_B 合成一个事件时，两者主键各是自身 URL 的哈希，保留谁？另一个早被 `push_records.target_id`（及未来 `item_event_relations` 外键）引用，要么级联改主键（DB 噩梦），要么留 tombstone 重定向。surrogate key 把「事件身份」与「内容指纹」解耦：身份永不因内容变化，P3 合并时主键不动、历史引用全安全，而 P1 的幂等塌缩行为与「内容哈希当主键」**完全等价**（冲突点从 PK 移到 `dedup_key` 唯一键）。代价近零。

### D2：P1 用 1:1（raw_item ↔ event），不建 `item_event_relations`

**决策**：P1 一条去重后的事件对应一条 `ai_news_events`，多条同 `dedup_key` 的 raw_item 经 `ON CONFLICT DO UPDATE` 塌缩进同一行；不建关系表。塌缩首建时写入 `representative_raw_item_id BIGINT`（记录第一条命中的 raw_item，廉价回指供调试/摘要引用原文）与 `representative_title`（取该 raw_item 的原始 title，供摘要降级时回退展示）；`source_count` 累加命中条数。

**理由**：P1 没有任何读路径需要「从 event 反查构成它的全部 raw_item」（日报只展示代表标题 + 摘要）。N:1 关系表在 P1 是 YAGNI。P3 引入语义合并时再建 relations 表回填——D1 已保证 event_id 稳定，回填无碍。

### D3：`dedup_key` 构造与 fallback 链；unprocessable 兜底

**决策**：
- `dedup_key = sha256(canonical_url)`（canonical_url 存在时）；否则 `sha256(title_hash)`；两者皆缺（空标题且空 URL）→ 拒绝入 event，对应 raw_item 标记 `unprocessable`（不塌缩进「全空哈希」垃圾桶 event）。
- 硬去重分两层落地：① 源内幂等由 `raw_items UNIQUE(source, source_item_id)` 保障；② 跨源/跨抓取去重由 `ai_news_events UNIQUE(dedup_key)` 保障。P1 到此为止，不做第三层 embedding 及以上。

**理由**：退出标准③（utm 归一为同一条）= 两条 raw_item 经 URL 规范化得到同一 `canonical_url` → 同一 `dedup_key` → 塌缩为一条 event。去重判定全程是程序 + DB 唯一键，无 LLM 参与。

### D4：URL 规范化与标题归一化为「版本化纯函数」

**决策**：
- URL 规范化（生成 `canonical_url`）：移除 `utm_*/ref/gclid/fbclid/spm` 等追踪参数 + 去 fragment + query 参数排序 + host 小写 + 去尾斜杠。纯函数，带 `normalizer_version`。
- 标题归一化（生成 `title_hash = sha256(normalized_title)`）：小写、去标点、去 emoji、去站点名、繁简转换、去「快讯/重磅/刚刚」等噪声词。纯函数，带 `normalizer_version`。
- 版本号写入 `raw_items.metadata`。

**理由**：归一规则一旦演进，新旧 hash 不可比 → 去重静默失效（最隐蔽的 bug）。版本化使「这条 hash 是按哪版规则算的」可追溯；P3 回填/重算时能识别版本差异。`canonical_url` P0 建了列没填，P1 **必须真正填值**，否则 D1/D3 整个塌缩逻辑悬空、退出标准③不成立。

### D5：Top N 选择 = LLM 产候选 + 程序排序（职责切分）

**决策**：
- Value Judge 的 `should_push` 与各项 score 只产生**候选**；**程序**按组合分排序取 Top N（5–10 条，N 进 config）。
- 组合分 `rank_score = 0.45*importance + 0.25*developer_relevance + 0.20*novelty − 0.10*hype_risk`（权重进 config 可调，初值如此）。
- 确定性 tiebreaker：`published_at DESC NULLS LAST, event_id ASC`。`published_at` 是本期为 `ai_news_events` 新增的列（塌缩首建时从代表 raw_item 写入）——P0 事件表无此列，不加则排序字段不存在。最终 tiebreaker `event_id ASC` 虽是随机 UUID，但同一已落库事件的 UUID 一经首建即固定（后续 UPDATE 不重生成），故「对同一批已落库事件多次排序」结果可复现（同 published_at 时按 UUID 字典序，顺序任意但确定）。
- importance 下限闸（如 `>= 60`）：宁可某天少于 N 条也不凑数推垃圾。
- 「今日候选」窗口 = `should_push=true AND first_seen_at 在近 N 天 AND 该 event 从未被任何 push_date 以该 channel success 推送过`。用「从未 success」而非「今天未 success」：否则常青高分事件跨天天天上榜重复推送。`first_seen_at` 必须在塌缩时写入，否则恒 NULL 使窗口恒空、候选为零、退出标准①挂。窗口的「今天」与 push_date 同源 Asia/Shanghai，禁止两处时区漂移。

**理由**：铁律「Agent 控语义 / Workflow 控流程」。让 LLM 决定「今天发哪几条」会引入不可复现、不可解释的排序。组合分而非单一 importance：避免「重要但人尽皆知」（高 importance 低 novelty）挤掉「小而新、对开发者有用」——developer_relevance 是 ai-radar 的产品差异点。hype_risk 用减项降权而非一票否决。

### D6：推送状态机（Telegram 单通道，单消息打包，幂等按 event 粒度）

**决策**：
- 推送主键四元组：`target_type='event'`、`target_id=event_id`、`channel='telegram'`、`push_date`。
- `push_date` 以 **Asia/Shanghai** 时区算「今天」（钉死时区，防跨 UTC 零点把一份日报算成两天而重复推送——与退出标准②直接挂钩）。
- **待发集合** = 今日 Top N 中 `status ∈ {无记录, pending, failed}` 的（= 今日 Top N MINUS 今日已 success；failed 与崩溃残留的僵尸 pending 自动纳入重试）。
- 流程：事务内为待发集合中「无记录者」`INSERT push_records(status=pending) ON CONFLICT DO NOTHING` → 把整个待发集合拼成**一条** Telegram 消息发送 → 单消息原子：成功则整批置 `success`，失败则整批置 `failed`（留 `error_message` 可重试）。
- **全局单例锁**：日报任务用 Redis `SETNX daily-digest:{date}`（或 BullMQ job id 去重）保证某一天的 digest 全局只有一个实例在跑。锁**必须带 TTL 或 finally 释放**——无 TTL 的 `SETNX` 崩溃未释放会使当日永远拿不到锁，与「僵尸 pending 下次重试」需求直接冲突（死锁）。崩溃后同 push_date 须能重新获取锁完成重试。**TTL 取值须显著大于最坏 `runDailyWorkflow` 时长（几百条 LLM 调用可能十几分钟），或用可续租/看门狗锁**——固定小 TTL 提前过期会让第二实例拿锁双发，破坏单例性（经典分布式锁陷阱）。

**理由 / 替代方案**：探索初稿是「整批 success + 冲突跳过」，有重复推送 bug——`push_records` 唯一键只保「记录不重复插」，不保「内容不重复发」，今天已 success 的条目下次又会被拼进消息。故待发集合必须**显式排除今日 success**。单条 Telegram 消息原子送达，不存在部分成功，N 条 push_record 状态同生共死。唯一键挡不住并发（两个 worker 都读到同批 pending、各发一条），故需单例锁——日报是天然单例任务，锁比在 push_records 上较劲简单可靠。

### D7：BullMQ 单队列单 worker 顺序编排，不拆阶段队列

**决策**：BullMQ 只当「定时触发器 + 整 job 重试外壳」。一个 cron 触发的 `daily-digest` job 调用 `runDailyWorkflow()`——纯顺序 async 函数：collect（`Promise.allSettled` 并发抓三源）→ 硬去重塌缩 → Value Judge 逐条 → 排序取 Top N → 中文摘要 → Push Dispatcher。

**理由 / 替代方案**：把五个阶段拆成五个队列消息驱动会带来乱序、中间态散落各队列、失败恢复要追 5 处、本地复现困难——违背「确定性工作流」原则，且 P1 每天几百条根本不需要队列削峰。collector 的外部抓取（网络慢、要并发）用 `Promise.allSettled` 在阶段内并发即可，不为它单拆队列。何时才拆：某阶段需独立伸缩/独立重试节奏/削峰时（P2/P3 抓取量大、embedding 慢）。

### D8：降级语义——逐条容错 + 降级率熔断

**决策**：
- Value Judge / 中文摘要单条失败 → 跳过该条 + 记错误日志 + `degraded_count++`，整批继续（局部容错；该 event 今天不进候选，raw_item 已 upsert，明天重判）。
- Value Judge 阶段只处理**尚未评分**的事件（`*_score IS NULL`，含本轮新建与此前降级未评分者），已评分事件跳过不重判——避免重复 LLM 调用、避免覆盖旧分。
- **降级率按阶段分别计算、各自独立熔断**（不合并）：Value Judge 阶段分母 = 本轮实际送判（未评分）事件数；中文摘要阶段分母 = 进入摘要的事件数（Top N）。两阶段分母量级差一两个数量级，合并会让摘要的少量失败被 judge 大分母稀释致熔断失灵，故必须分开。任一阶段分母 > 0 且其降级率严格 `> ratio`（如 `> 0.5`）→ 中止 + 告警（系统级故障：key 失效 / 限流），**不推残缺日报**。
- 某阶段分母为 0（无未评分事件、或 Top N 为空）→ 禁止按 `0/0` 计算（`NaN > 阈值` 恒假）；但**分母 0 不是错误、不中止**：judge 分母=0 直接进 Top N（已评分常青事件仍可推），摘要分母=0 正常不推。**禁止把「judge 分母=0」误判为「今日无候选」中止**（否则漏推常青事件，违反 D5 跨天可推目标）。
- 「系统级故障」告警以**采集/规范化层**为准（非以 judge 分母为准）：①本轮采集返回条数=0（三源全挂）；②采集返回>0 但可处理条目数=0（全 unprocessable，提示采集器采空/归一函数故障）——两者都告警。「可处理条目数」含塌缩进既有事件者，故「全命中既有事件、无新事件」是正常无新闻、不告警；唯「全 unprocessable」告警。这与「judge 分母=0」是三回事。

**理由**：单条语义判断失败是预期常态（LLM 偶发 / 限流 / 单条内容异常），为一条烂数据中止整个日报是把局部失败放大成全局失败。但高降级率说明系统坏了，此时推残缺日报比不推更糟。区分「个别坏数据」（继续）与「系统坏了」（中止）是关键。

### D9：中文摘要 Agent 与 Value Judge 同规格

**决策**：新 `chinese-digest-agent` 复用 value-judge 的结构：`generateObject` + Zod 校验 + 有限重试 + 降级。输出含 `summary_zh`（中文摘要正文）等结构化字段。摘要失败的 event 回退用 `representative_title` 或剔除出当日日报，绝不把未校验/半截输出推给用户。

**理由**：铁律「所有 Agent 输出必须结构化 JSON + 校验」。P0 已验证此模式，直接复用降低实现与认知成本。

## 风险 / 权衡

- **[同 canonical_url 被改写内容 → 漏推]** 新闻站偶尔改写同一 URL 的内容，`dedup_key` 会把「旧闻」与「改写后」判为同一 event（`ON CONFLICT` 更新而非新建）→ 可能漏推。→ **缓解：P1 接受此低概率漏报，记入已知限制**。刻意不在 `dedup_key` 掺 `published_at`（那会削弱跨天去重）。后续期次再处理。
- **[哈希碰撞]** sha256 碰撞概率可忽略。→ 不处理。
- **[Telegram 假失败双发]** 消息已送达但 API 响应在网络层丢失 → dispatcher 判失败 → 下次重试 → 双发；push_records 唯一键拦不住（同 push_date 同 event 记录已存在为 failed，重试是 UPDATE 同行后重发）。→ **缓解：P1 接受此低概率双发（at-least-once），记入已知限制**；后续可加 Telegram 端幂等。
- **[归一规则演进致去重失效]** → 缓解：D4 的 `normalizer_version` 落 metadata，使版本差异可追溯。
- **[时区误算致重复推送]** → 缓解：D6 钉死 Asia/Shanghai 算 push_date。
- **[并发重发]** → 缓解：D6 全局单例锁。
- **[外部源鉴权/限流]** Product Hunt/Reddit 在 P2，但 GitHub API 有速率限制。→ 缓解：collector 外部调用带重试 + 错误日志；GitHub 用 token 提额；单源失败不拖垮整批（`Promise.allSettled`）。

## 迁移计划

- 单次 Drizzle migration：`ai_news_events` 改 `event_id` 为 `VARCHAR(128)` + `DEFAULT gen_random_uuid()::text`、新增 `dedup_key`（+`UNIQUE`）、`representative_raw_item_id`、`published_at`；`raw_items` 新增 `title_hash`、`unprocessable`（`BOOLEAN NOT NULL DEFAULT false`）。
- **无生产数据迁移负担**：P0 库内仅 seed 数据。迁移必须采取 **drop 并按新定义重建**（而非对既有 `seed-<id>` 行顺序 ALTER），以免遗留不符 surrogate 约定的脏 event_id 行。P0 的 seed 落库路径（`persistEventScores` 用 `seed-<id>` 当 event_id）与 roundtrip 测试将被真实塌缩路径替换（删除 seed 专用代码，改测真实 dedup_key 塌缩往返）。
- 回滚：down migration 还原列；因无生产数据，回滚无数据损失。

## 待解决问题

- 具体 RSS 源清单（哪几个 feed）与 GitHub 采集口径（trending? 指定 topic? starred 增量?）—— 留到 tasks/config 落地，不影响架构。
- Telegram 日报消息的具体排版（Markdown vs HTML、单条长度上限、超 N 条折叠策略）—— 实现细节，tasks 内定。
- `normalizer_version` 的编码形式（整数递增 vs 语义串）—— 实现细节。
