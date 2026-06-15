## 上下文

P3 在既有确定性流水线上补语义层。当前事实：

- **管道顺序**（`src/pipeline/run-daily-workflow.ts`）：采集 → **阶段2 硬去重塌缩** `collapseUncollapsedRawItems`（按 `collapsed` 标记驱动、幂等）→ value-judge `scoreUnscoredEvents` → digest → push。语义层须插在**阶段2 之后、value-judge 之前**。
- **raw_item↔event 链接现状**：无 `item_event_relations` 表（QA §8 列了但尚未建）。事件只在 `ai_news_events.representative_raw_item_id` 记**首条**命中 raw_item，其余同 `dedup_key` 的 raw_item 仅令 `source_count += 1` 并置 `raw_items.collapsed=true`，**不存在逐条 raw_item→event 指针**。
- **零向量不变量**：`platform-foundation` spec + `schema.ts` 显式禁 vector 列 / `CREATE EXTENSION vector`，镜像已是 `pgvector/pgvector`（无需换镜像）。
- **`long_term_value` 不存在**：KB 准入闸所需的长期价值分尚无列、无产出者（QA §10.7 的 Knowledge Ingestion Agent 未建）。
- **文本净化现状**：仅 `sitemap` 采集器在自己那层净化 NUL/C0/lone surrogate；其余 6 源与 `store.ts`（唯一 text sink）未净化；store 逐条 INSERT 无 per-item try/catch（一条坏文本 throw 即中止整批，见 memory `store-layer-text-sanitization-followup`）。
- **并发**：日报链持 `push_date` 单例锁；实时告警链每 20min 跑、也做 collapse。既有"仅日报链"模式（熔断）可借鉴。

## 目标 / 非目标

**目标：**
- 分层去重补齐第三层（embedding 相似度）+ 第四层（LLM 二次判断）+ 确定性事件合并，让"标题不同/中英文/多源"的同一事件收敛为一条。
- 精选内容（`long_term_value >= 70`）沉淀进**本地表知识库**，幂等可查。
- store 层统一文本净化 + per-item 入库隔离，单条坏文本不再中止整批。
- 全程守住：去重身份/合并落库/幂等/唯一约束由**程序 + DB** 保障，LLM 只产语义判断。

**非目标：**
- 相似度阈值（0.88/0.82）的真实数据实测调优——仅作可配置起点。
- Dify/RAGFlow HTTP 外接、长文档/PDF 入库。
- 实时告警链的语义去重（本期语义层**仅日报链**，告警链保持硬去重快路径）。
- `ai_products` 产品语义合并（仍沿用 P2 硬规则）。
- 把"是否合并/是否重复"的**最终落库决定**交给 LLM。

## 决策

### D1：embedding 模型与向量维度
- 默认 `text-embedding-3-small`（1536 维，多语种、含中英文，便宜），经 Vercel AI SDK `embed`/`embedMany` 调用。模型名由 env 配置（`EMBEDDING_MODEL`）。
- **向量列维度在迁移中钉死为 1536**（pgvector `vector(1536)` 必须定长）。更换不同维度模型属**新的 forward-only 迁移**（ADD 新列或重建），不在本期支持热切。
- 备选：`text-embedding-3-large`(3072) 精度更高但贵且列更宽；本地 bge sidecar 留逃生舱（config.yaml 已述）。选 small 作起点，阈值/模型均可配。

### D2：embedding 文本（dedup 阶段 summary 尚不存在）
- QA §9.2 字面为 `title + summary + key_entities`，但语义层在 value-judge/digest **之前**运行，`summary_zh`/`main_entities` 此时尚未产出。
- **决策**：embedding 文本 = `representative_title` ‖ 代表 raw_item 的 `content` 摘录（截断到 N 字符，默认 2000）‖（`main_entities` 若已存在则附加）。代表 raw_item 的 `content` 在 dedup 阶段已落库可用，比纯标题信息量足。记此为对 QA 字面的有据偏离（summary 不可得），不破坏"同事件收敛"目标。
- **空文本兜底**：`content` 列可空（QA §8.1）、`representative_title` 可能为空串；拼接后 trim 为空/纯空白时**跳过 embedding 与合并**（保留独立、记日志），绝不对空文本求 embedding——空文本产生退化向量，会让彼此无关的空文本事件呈高相似度而被错误合并（过合并危险方向，spec「空文本兜底」为权威）。

### D3：语义阶段位置 —— 仅日报链，collapse 之后
- 新增阶段 `semanticMergeEvents`，在 `collapseUncollapsedRawItems` 之后、`scoreUnscoredEvents` 之前调用，**仅日报链**（实时告警链不调，保持硬去重快路径，对齐既有"仅日报链"熔断模式）。
- embedding 生成对象 = 候选时间窗内（`first_seen_at >= now - SEMANTIC_WINDOW_DAYS`）**所有** `embedding IS NULL AND merged_into IS NULL` 的新闻事件（**不只本轮 collapse 的新事件**）——跨天去重要把今日新事件与历史存活者比对，历史行（含 P3 前入库、embedding 仍 NULL 者）须先补 embedding 才能作 KNN 候选被检索到，否则跨天合并静默失效（spec「候选窗口 bootstrap」）。已嵌入的不重嵌（幂等）。首部署 backlog 受 `EMBEDDING_BOOTSTRAP_MAX_PER_RUN`（默认 500）单轮上限约束；嵌入顺序**先本轮新事件、再 `first_seen_at` 升序填补余量嵌历史存活者**（保今日新事件本轮即可作查询对象，spec「嵌入顺序」为权威），防一次性嵌满窗口撑爆调用/拖住锁。
- **合并闭环**：合并把被吞事件置 `merged_into` tombstone 后，下游所有「把行当独立事件用」的读点（value-judge / Top N / 回填 / 周报 / 告警 / KB 候选 / MCP 查询 / source-quality 统计）必须排除 `merged_into IS NOT NULL`，否则被吞事件在 value-judge 处复活、被 Top N 重复推送，使合并比不合并更糟（spec「tombstone 对所有下游消费者不可见」为权威）。

### D4：候选检索与阈值
- 对每个待判 event：在**时间窗内**（`first_seen_at >= now - SEMANTIC_WINDOW_DAYS`，默认 14）、排除自身、按 pgvector 余弦距离 `embedding <=> $q` 取最近 K（默认 10），`cosine_sim = 1 - distance`。
- `sim > SEMANTIC_DEDUP_HIGH`（默认 0.88）→ 直接判同事件、合并；`SEMANTIC_DEDUP_LLM`（默认 0.82）< sim ≤ 0.88 → 交 LLM 二次判断；≤0.82 → 不合并（边界含义显式钉死，避免浮点 `==` 歧义）。
- **偏离登记**：QA §9.2 把 `>0.88` 字面写作「高度疑似重复」（建议），未要求「直接合并、跳过 LLM」；本期对 `>0.88` 直接合并是有意偏离，靠两条安全约束控过合并——① 合并为 tombstone 可回溯/可恢复；② 必记合并 provenance（被吞/存活 `event_id`、`cosine_sim`、档位、LLM reason），误并可审计可回滚（spec「偏离登记 + 风险闸」为权威）。
- 索引：本期数据量小，用**窗口内精确检索**即可；HNSW（cosine）索引留作数据量上来后的单独优化（log 提示，不在本期建以免小数据下劣化）。

### D5：事件合并机制（确定性，程序 + DB）
- 判定同事件的 A、B 两 event：**存活者 = `first_seen_at` 较早者**（并列取 `event_id` 字典序小者），吞并较新者。
- 合并操作（单事务、对两行 `FOR UPDATE`，**按 `event_id` 字典序升序加锁**防 AB-BA 死锁纵深防御）：存活者 `source_count += 被吞 source_count`（**一次性**吸收；被吞 tombstone 的 `source_count` 此后冻结，塌缩改投只对真正新到的 raw_item `+1`，不重加）、`published_at = COALESCE(存活, 被吞)`（单向 NULL-fill，沿用 collapse 不变量）、`first_seen_at = least`、`last_seen_at = greatest`；**冻结**存活者 `event_id`/`representative_raw_item_id`/`representative_title`/`dedup_key`；被吞 event **置 `merged_into=存活event_id`（tombstone，不物理删除）**，保留其 `dedup_key` 唯一占位（无 `item_event_relations` 需重指——当前不建该表）。
  - **链式合并**：存活者后续可能再被吞（A 吞 B 后 A 又被吞入 C）；任何「据 `merged_into` 找存活者」必须递归到终态（`merged_into IS NULL`）、带环路保护，不得停在仍是 tombstone 的中间行（spec「链式合并」为权威）。
  - **合并 vs 塌缩并发（关键）**：塌缩入口为日报链与告警链共用，告警链塌缩**不持日报锁**、每 20min 跑，会与日报合并并发触碰同一被吞行。靠冲突 `dedup_key` 行锁串行化：tombstone 改投的 `source_count+1` 只落链解析后的存活者（`DO UPDATE` 加 `WHERE merged_into IS NULL` 守卫 + 事务内改投），绝不加到 tombstone；合并先/塌缩先两序皆不丢不重（spec「改投的并发原子性」/「并发与锁序」为权威）。
  - **D5a**：被吞 event 删除后，其 `dedup_key` 不再占用；为防后续同 `dedup_key` 的 raw_item 重新 INSERT 出一个新 event（与存活者再次成为语义重复），合并时把被吞 event 的 `dedup_key` 以"别名"记录关联到存活者（新增轻量 `event_dedup_aliases(dedup_key UNIQUE, event_id)` 或在 collapse 的 ON CONFLICT 目标前先查别名表）。**简化方案**：合并时**不删被吞行而置 `merged_into=存活event_id`（tombstone）**，保留其 `dedup_key` 唯一占位，collapse 命中 tombstone 时改投 `merged_into` 指向的存活者。采纳 tombstone 方案（避免唯一键释放竞态，且保留可观测/可回溯）。
- **跨天幂等正确性（两侧都须覆盖）**：合并发生在 value-judge/push 之前。**存活者侧**：存活者取较早 event（通常前日已 push），push 候选"从未以该 channel success"因其已 success 而跳过 → A 不重推。**被吞者侧（关键，原设计遗漏）**：今日新事件 B 被吞为 tombstone（`merged_into=A`），B 此刻 `importance_score` 为 NULL，**必须靠下游读点排除 `merged_into IS NOT NULL`** 才不会被 value-judge 复活评分、被 Top N 选中独立推送——否则重复事件经 B 漏推。两侧合起来才闭环（spec「tombstone 对所有下游消费者不可见」）。

### D6：LLM 二次判断（语义灰区）
- Vercel AI SDK `generateObject` + Zod schema `{ same_event: boolean, same_product: boolean, reason: string }`（QA §9.2 第四层）；带重试 + 错误日志。
- **降级 = 不合并**（保守）：LLM 失败/校验不过时**视为不同事件、不合并**——欠合并（漏并）安全（最多重复一条），过合并会丢失独立事件。降级不计入 judge/digest 熔断分母（语义层独立）。
- 最终是否合并由程序据 `same_event` + DB 事务执行；LLM 仅建议。

### D7：知识库入库（本地表 + 准入闸）
- 新增 **Knowledge Ingestion Agent**（QA §10.7，LLM + Zod）：对高价值候选 event 产 `{ kb_title, summary_zh, tags[], entities[], long_term_value }`；带重试，校验不过则跳过该条不入库（不污染 KB）。
- **准入闸（程序）**：仅 `long_term_value >= 70` 入库（QA §13.1 知识库不是垃圾桶），不入原文/转载/营销稿/标题党。
- **候选范围（钉死）**：日报链 push **之后**，候选 = 当日**实际推送成功**（该 `event_id` 产生 `push_records.status='success'`）**且** `merged_into IS NULL`（非 tombstone）的 event；以「已推送成功」单一界定（不用「importance≥某档」二义口径，消除 design/spec 歧义），控成本、对齐 config 流水线 `Push → KB Ingestion`。
- **存储**：新增本地表 `kb_documents`（`id`、`target_type`、`target_id`、`kb_title`、`summary_zh`、`tags jsonb`、`entities jsonb`、`source_urls jsonb`、`event_date`、`long_term_value`、`embedding vector(1536)` 供未来检索、`created_at`）。`kb_ingestion_records`（QA §8.7）记入库日志，`kb_provider='custom'` 指向本地表，`kb_document_id` 回指 `kb_documents.id`。
- **幂等 + 两表原子性**：`UNIQUE(target_type, target_id, kb_provider)` 在 `kb_ingestion_records` 上——同一 event 对同一 provider **最终只成功一次**。认领须**状态感知**（对齐 value-judge 的 claim CAS；push dispatcher 同为状态感知但用预算 pending-set + DO NOTHING，范式不同）：`INSERT(pending) ON CONFLICT DO UPDATE SET status='pending' WHERE status<>'success' RETURNING`——`success` 跳过、`failed`/僵尸 `pending` 重新抢到重试；**绝不用 `DO NOTHING`**（否则一条 `failed` 行永久挡死该 event 的重试，与「失败可重试」矛盾）。认领成功后「插 `kb_documents` + 置 `success` + 回指」同一事务，失败则回滚（不留文档）再独立置 `failed`——并发（单例锁内单实例）/崩溃都不产生重复或孤儿 `kb_documents`（spec「状态感知的认领」+「两表写入原子性」为权威）。

### D8：store 层加固（统一收口）
- 新增纯函数 `sanitizeText`（剔 NUL/C0 控制符，保留 `\t\n\r`；剔 lone surrogate，保留合法 emoji 代理对），在 `store.ts` 对每条目 `title`/`content`/`url`/`metadata` 字符串值统一净化后再 INSERT——**对所有源生效**（sitemap 采集器自身净化保留作纵深防御，行为不变）。
- 逐条 INSERT 包 `try/catch`：单条抛错被捕获、记错误日志、`skippedError += 1`，循环继续；`StoreResult` 加 `skippedError` 字段。`received/processableCount` 等既有口径不变（净化不改变可处理性判定）。

## 风险 / 权衡

- **过合并（误并不同事件）** → LLM 降级=不合并 + 仅 >0.88 自动合并 + 0.82–0.88 才上 LLM；阈值可配，保守起步。
- **embedding 模型维度变更致迁移返工** → 默认钉死 1536、文档写明换维度=新迁移；不支持热切。
- **dedup 阶段无 summary，embedding 信息量略减** → 用 title+content 摘录补足；目标是"同事件收敛"非"最精排序"，可接受（D2）。
- **合并发生在 push 之后会导致同事件重推** → 强制语义合并在 push **之前**、存活者取较早事件（D5 跨天幂等）。
- **pgvector 精确检索随数据增长变慢** → 窗口内检索 + K 限制；HNSW 索引留数据量上来后单独加（D4）。
- **告警链不做语义去重，可能同事件以两 event_id 各告警一次** → 告警一生一次按 event_id 幂等本就接受此粒度；语义告警去重列为非目标、留后续。
- **KB Agent 增加 LLM 成本** → 候选限当日推送 success event（排除 tombstone）+ 准入闸≥70 + 幂等不重入。
- **语义层独立于熔断 → 100% 失败可能静默无并**（降级=不合并是安全方向、退回硬去重态，不致数据损坏；但全失效无人知）→ 记可观测健康信号（持续高失败/零合并高失败时 log/告警），列为可观测增强（非阻断，欠合并安全）。
- **tombstone 行无界累积 + 全表 `merged_into IS NULL` 扫描无索引** → 数据量上来后单独加 partial index `WHERE merged_into IS NULL`（与 D4 的 HNSW 同属「数据量上来再优化」，本期不建以免小数据劣化）；并确认 tombstone 不进 14 天 reclaim、不被重嵌。
- **精确 KNN 随数据增长变慢且无触发器** → 加事件行数/耗时 log tripwire，达阈值提示加 HNSW（D4）。

## 迁移计划

- **forward-only 迁移**（drizzle-kit，CI 连跑两次验证幂等）。注：幂等是 **drizzle journal 级**（已应用迁移按 journal 跳过），并非每条 SQL 自幂等——`ADD COLUMN` 非 `IF NOT EXISTS`，绕过 journal 裸跑两次会报错；幂等验证须经 `drizzle-kit migrate`（走 journal），非手工重放 SQL。
  1. `CREATE EXTENSION IF NOT EXISTS vector;` + `ALTER TABLE ai_news_events ADD COLUMN embedding vector(1536);` + `ADD COLUMN merged_into varchar(128);`（tombstone 指针，D5a）。
  2. `CREATE TABLE kb_documents (...)`（含 `embedding vector(1536)`）+ `CREATE TABLE kb_ingestion_records (...)` + `UNIQUE(target_type, target_id, kb_provider)`。
- 解除 `schema.ts` 与 `platform-foundation` spec 的零向量不变量文字（改为"P3 起按需启用，仅 ai_news_events / kb_documents"）。
- 回滚：embedding/merged_into 列与 KB 表均为新增，旧链路不读则不受影响；语义阶段可由 env 开关 `SEMANTIC_DEDUP_ENABLED`（默认 on）一键停用退回硬去重。

## 待解问题

- embedding 默认模型最终定 `text-embedding-3-small`（1536）是否 OK，还是直接上 large(3072)？（本设计取 small，可配。）
- ~~KB 候选范围取"已 push event"还是"importance≥某档的全部 event"？~~ **已定**：取「当日推送 success 且 `merged_into IS NULL`」单一口径（D7），控成本、消除二义。
- `event_dedup_aliases` 独立表 vs `merged_into` tombstone 列——本设计取 tombstone 列（更简、无新表、可回溯）。
