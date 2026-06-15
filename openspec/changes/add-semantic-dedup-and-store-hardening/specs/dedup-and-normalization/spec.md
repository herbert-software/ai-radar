## 修改需求

### 需求:基于 dedup_key 的硬去重塌缩

系统必须为每条可处理的**新闻类** `raw_item` 计算 `dedup_key`，并以 `ai_news_events.dedup_key` 的 `UNIQUE` 约束 + `INSERT ... ON CONFLICT (dedup_key) DO UPDATE` 把同一事件的多条 `raw_item` 塌缩为同一条 `ai_news_events`。`dedup_key` 构造必须遵循 fallback 链：`canonical_url` 存在时 `dedup_key = sha256(canonical_url)`；否则 `dedup_key = sha256(title_hash)`。

**类型路由（P2 新增，绝不可省）**：自 P2 起 `raw_items` 含非新闻类型条目（`raw_type='product'` 来自 Product Hunt、`raw_type='paper'` 来自 arXiv）。事件塌缩（→ `ai_news_events`）必须**排除产品与论文条目**，排除条件须用 **`raw_type IS DISTINCT FROM 'product' AND raw_type IS DISTINCT FROM 'paper'`**（而非 `raw_type NOT IN (...)`）——因 `raw_type` 列可空（QA §8.1 `raw_type VARCHAR(64)`），`NULL NOT IN (...)` 求值为 `NULL` 会**放行** NULL 条目；用 `IS DISTINCT FROM` 使 `NULL` 被当作新闻类纳入塌缩，保持 P1「现有三源（含 GitHub `repo` 等非 product/paper 类型）正常进事件流」的行为不回退。raw_type 全集归属显式闭合：**仅 `product`/`paper` 排除出事件塌缩，`news`/`repo`/`post`/`NULL` 等其余值一律视作新闻类纳入塌缩**（QA §8.1 注释列 `news/product/repo/paper/post`）。产品条目由 product-discovery 的确定性产品塌缩独占消费（→ `ai_products`），论文条目 P2 仅作数据沉淀留在 `raw_items`（不进事件、不推送，见 source-collectors arXiv 与 proposal 非目标）。禁止把产品/论文条目误塌缩进 `ai_news_events` 污染新闻事件流，也禁止产品条目被「事件塌缩 + 产品塌缩」双重消费。

**排除行不得停在 `collapsed=false` 被每轮无界重扫**：类型路由的排除必须在塌缩**查询层**完成（事件塌缩入口的 `WHERE` 增加 `raw_type IS DISTINCT FROM 'product' AND raw_type IS DISTINCT FROM 'paper'`，使 product/paper 行不进 pending 集）；并且：产品行由产品塌缩成功后置 `collapsed=true`（见 product-discovery），论文行因 P2 无任何下游消费、入库即置 `collapsed=true`（标记为已路由/已沉淀）。否则被排除的 product/paper 行永远 `collapsed=false`，事件塌缩入口每轮重扫全部历史 product/paper 行，工作量随累计行数线性无界增长（与 P1 对新闻行严格置 `collapsed=true` 的设计不对称）。`collapsed` 列对 product/paper 行语义为「已按 raw_type 路由处理完毕」，对新闻行语义为「已塌缩进 ai_news_events」。各采集器**必须为每条 `raw_item` 标注非空 `raw_type`**（PH→`product`、arXiv→`paper`、RSS→`news`、HN/GitHub→其类型），NULL `raw_type` 视为采集器 bug；类型路由对 NULL 的「视作新闻」是防御性兜底、非鼓励留空。

塌缩的 `INSERT` 分支必须**省略 `event_id`**，由数据库默认值 `gen_random_uuid()::text` 生成不透明身份；首次创建时必须写入 `representative_raw_item_id`、`representative_title`（取代表 `raw_item` 的**原始 title**——非归一化标题，保证 `NOT NULL`，供摘要降级时回退展示；原始 title 通常可读，极个别为空串 `''` 的情形由摘要降级兜底到 canonical_url）、`first_seen_at`、`published_at`（取代表 `raw_item` 的发布时间），并初始化 `source_count=1`。`ON CONFLICT DO UPDATE` 分支必须累加 `source_count`、更新 `last_seen_at`，并且**仅在事件当前 `published_at IS NULL` 时**用后到 `raw_item` 的非 NULL `published_at` 经 `COALESCE` 补值（identity-preserving NULL-fill：`published_at = COALESCE(ai_news_events.published_at, excluded.published_at)`）——这是**确定性事实优先于 AI 推断**的体现（DB 已有的确定发布时间绝不交给 LLM，见 published-at-inference）。`ON CONFLICT DO UPDATE` 分支**禁止**覆盖 `event_id`、`representative_raw_item_id`、`representative_title`、`first_seen_at`，也**禁止**把已非 NULL 的 `published_at` 覆盖为其它值（`COALESCE` 保证已设值不变、只允许 `NULL → 已知` 单向补值）——否则事件身份与「首建代表原文」语义被后到的 `raw_item` 破坏。多条同 `dedup_key` 但日期不同的 `raw_item` 并发塌缩时，NULL-fill 取**先抢到行锁那条**的确定日期：取哪条依到达序、非全序确定，但**始终是某条真实 `raw_item` 的确定发布时间**（不丢、不臆造），与「首建代表 = 第一条命中」的到达序语义一致；契约只承诺「填入某个确定发布时间」（任一确定值都满足时效闸语义），不承诺选最早/最晚，故无需 per-dedup 序列化锁或聚合子查询。

**tombstone 改投（P3 新增）**：当塌缩的 `ON CONFLICT (dedup_key)` 命中的既有事件已被语义合并置 `merged_into` 非空（tombstone，见 semantic-dedup「确定性事件合并」），系统必须把该 `raw_item` 改塌缩进 `merged_into` 指向的存活事件，禁止新建重复事件、也禁止把 `source_count` 累加到 tombstone 行。**改投必须沿 `merged_into` 链递归/迭代到终态存活者**（`merged_into IS NULL`）——存活者本身可能在后续轮次再被合并而成 tombstone，单跳改投可能仍落在 tombstone 上；解析须带环路保护（已访问集合，命中环即报错告警，绝不无限循环）。`source_count` 仅对真正新到的 `raw_item` `+1`，绝不重加被吞事件已冻结的 `source_count`（见 semantic-dedup「source_count 不重复计数」）。

**改投的并发原子性（关键：塌缩与语义合并跨链并发）**：塌缩入口 `collapseUncollapsedRawItems` **日报链与实时告警高频链共用**，而告警链**不持日报单例锁**（`alert-scan.ts` 每 20min 跑塌缩、`acquireAlertLock` 只裹分发不裹塌缩），故告警链塌缩会与日报链语义合并**并发**。因此 tombstone 改投**不可**用裸 `ON CONFLICT (dedup_key) DO UPDATE SET source_count = source_count + 1`——该写会落在被命中行上，若该行刚被合并置 tombstone，就把已冻结的 tombstone `source_count` 误加（违反冻结不变量）、且不改投。改投必须：①增量目标是**链解析后的终态存活者**而非被命中行——对命中行的 `DO UPDATE` 加 `WHERE ai_news_events.merged_into IS NULL` 守卫（命中 tombstone 时该 `DO UPDATE` 不动 tombstone），命中行为 tombstone 时改在**同一事务内**对命中行取行锁（`ON CONFLICT` 对冲突行本就持行锁，或显式 `SELECT ... FOR UPDATE`）读 `merged_into`、链解析到存活者后 `UPDATE 存活者 SET source_count = source_count + 1, last_seen_at = ...`；②靠**冲突 `dedup_key` 那一行的行锁**与并发的语义合并（合并对被吞行 `FOR UPDATE`）串行化——两侧争同一行锁，故无论谁先提交都自洽：合并先提交→塌缩读到 `merged_into` 非空→改投存活者（+1 落存活者）；塌缩先提交（+1 落尚未 tombstone 的命中行）→合并随后 `源count += 被吞`（把这 +1 一并吸收进存活者）。两序皆不丢不重。

流水线下游对同一事件行的后续写入（Value Judge 写 `*_score`/`should_push`、中文摘要写 `summary_zh`、published-at-inference 在所有关联 raw_item 均无发布时间时回填 `published_at`）必须以 `UPDATE ... WHERE event_id = ?` 定位、`set` 中**只含本阶段目标列**（published-at-inference 的回填须附 `AND published_at IS NULL` 的 CAS 守卫），禁止用 `INSERT ... ON CONFLICT` 模板（P0 `persistEventScores` 的全列覆盖式 `set` 是反面模板），以免把 `published_at`/`representative_*`/`first_seen_at` 覆盖回 NULL 而使 Top N 排序静默退化。

去重判定的**最终事实**必须全程由程序与 DB 唯一约束保障，禁止交给 LLM。本需求只规定**硬去重层**（第一层硬去重 + 第二层 `title_hash`）行为；embedding 相似度（第三层）与 LLM 二次判断（第四层）在硬去重塌缩**之后**由 semantic-dedup capability 承接——其 LLM 仅产语义判断（结构见 semantic-dedup「LLM 二次判断」，`{same_event, same_product, reason}`），是否合并的最终落库仍由程序 + DB 单事务执行（见 semantic-dedup）。本需求不再禁止后续期次引入 embedding/LLM 语义层（原 P1/P2「本期仅做硬去重层、禁止引入 embedding 相似度或 LLM 二次判断」的期次限制随 P3 解除）。

#### 场景:同 canonical_url 的多条塌缩为一条事件
- **当** 两条新闻类 `raw_item` 经规范化得到相同 `canonical_url`（因而相同 `dedup_key`）
- **那么** 二者塌缩为 `ai_news_events` 中的同一行（同一 `event_id`），`source_count` 累加为 2

#### 场景:产品与论文条目不塌缩进 ai_news_events
- **当** `raw_items` 中存在 `raw_type='product'`（PH）与 `raw_type='paper'`（arXiv）条目
- **那么** 事件塌缩显式排除二者、不为它们生成 `ai_news_events` 行；产品条目仅由产品塌缩消费进 `ai_products`，论文条目仅留存 `raw_items` 作数据沉淀

#### 场景:首建记录代表原文与时间列
- **当** 某 `dedup_key` 首次创建事件
- **那么** 该事件的 `representative_raw_item_id` 与 `representative_title` 记录为第一条命中的 `raw_item`，`first_seen_at` 与 `published_at` 被写入，`event_id` 为数据库生成的 UUID 文本

#### 场景:再次塌缩不覆盖身份与代表原文
- **当** 第二条同 `dedup_key` 的 `raw_item` 经 `ON CONFLICT DO UPDATE` 命中已存在事件
- **那么** `event_id`、`representative_raw_item_id`、`representative_title`、`first_seen_at` 保持首建值不变，仅 `source_count` 累加、`last_seen_at` 更新；`published_at` 在首建已非 NULL 时保持不变（`COALESCE` 不覆盖已设值）

#### 场景:后到 raw_item 的确定发布时间补空（确定性优先于 AI）
- **当** 某事件首建时 `published_at` 为 NULL（首条 raw_item 无发布时间），后到的同 `dedup_key` raw_item 带确定 `published_at`
- **那么** `ON CONFLICT DO UPDATE` 经 `COALESCE(ai_news_events.published_at, excluded.published_at)` 把确定值补入（`NULL → 已知` 单向），该事件不再进入 AI 推断阶段（确定性事实优先、不交 LLM）

#### 场景:塌缩命中 tombstone 改投存活事件
- **当** 一条新闻类 `raw_item` 的 `dedup_key` 命中的既有事件已被语义合并置 `merged_into` 非空
- **那么** 该 `raw_item` 改塌缩进 `merged_into` 指向的存活事件，不新建重复事件、不向 tombstone 行累加 `source_count`
