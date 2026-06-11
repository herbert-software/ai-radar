## 修改需求

### 需求:基于 dedup_key 的硬去重塌缩

系统必须为每条可处理的**新闻类** `raw_item` 计算 `dedup_key`，并以 `ai_news_events.dedup_key` 的 `UNIQUE` 约束 + `INSERT ... ON CONFLICT (dedup_key) DO UPDATE` 把同一事件的多条 `raw_item` 塌缩为同一条 `ai_news_events`。`dedup_key` 构造必须遵循 fallback 链：`canonical_url` 存在时 `dedup_key = sha256(canonical_url)`；否则 `dedup_key = sha256(title_hash)`。

**类型路由（P2 新增，绝不可省）**：自 P2 起 `raw_items` 含非新闻类型条目（`raw_type='product'` 来自 Product Hunt、`raw_type='paper'` 来自 arXiv）。事件塌缩（→ `ai_news_events`）必须**排除产品与论文条目**，排除条件须用 **`raw_type IS DISTINCT FROM 'product' AND raw_type IS DISTINCT FROM 'paper'`**（而非 `raw_type NOT IN (...)`）——因 `raw_type` 列可空（QA §8.1 `raw_type VARCHAR(64)`），`NULL NOT IN (...)` 求值为 `NULL` 会**放行** NULL 条目；用 `IS DISTINCT FROM` 使 `NULL` 被当作新闻类纳入塌缩，保持 P1「现有三源（含 GitHub `repo` 等非 product/paper 类型）正常进事件流」的行为不回退。raw_type 全集归属显式闭合：**仅 `product`/`paper` 排除出事件塌缩，`news`/`repo`/`post`/`NULL` 等其余值一律视作新闻类纳入塌缩**（QA §8.1 注释列 `news/product/repo/paper/post`）。产品条目由 product-discovery 的确定性产品塌缩独占消费（→ `ai_products`），论文条目 P2 仅作数据沉淀留在 `raw_items`（不进事件、不推送，见 source-collectors arXiv 与 proposal 非目标）。禁止把产品/论文条目误塌缩进 `ai_news_events` 污染新闻事件流，也禁止产品条目被「事件塌缩 + 产品塌缩」双重消费。

**排除行不得停在 `collapsed=false` 被每轮无界重扫**：类型路由的排除必须在塌缩**查询层**完成（事件塌缩入口的 `WHERE` 增加 `raw_type IS DISTINCT FROM 'product' AND raw_type IS DISTINCT FROM 'paper'`，使 product/paper 行不进 pending 集）；并且：产品行由产品塌缩成功后置 `collapsed=true`（见 product-discovery），论文行因 P2 无任何下游消费、入库即置 `collapsed=true`（标记为已路由/已沉淀）。否则被排除的 product/paper 行永远 `collapsed=false`，事件塌缩入口每轮重扫全部历史 product/paper 行，工作量随累计行数线性无界增长（与 P1 对新闻行严格置 `collapsed=true` 的设计不对称）。`collapsed` 列对 product/paper 行语义为「已按 raw_type 路由处理完毕」，对新闻行语义为「已塌缩进 ai_news_events」。各采集器**必须为每条 `raw_item` 标注非空 `raw_type`**（PH→`product`、arXiv→`paper`、RSS→`news`、HN/GitHub→其类型），NULL `raw_type` 视为采集器 bug；类型路由对 NULL 的「视作新闻」是防御性兜底、非鼓励留空。

塌缩的 `INSERT` 分支必须**省略 `event_id`**，由数据库默认值 `gen_random_uuid()::text` 生成不透明身份；首次创建时必须写入 `representative_raw_item_id`、`representative_title`（取代表 `raw_item` 的**原始 title**——非归一化标题，保证 `NOT NULL`，供摘要降级时回退展示；原始 title 通常可读，极个别为空串 `''` 的情形由摘要降级兜底到 canonical_url）、`first_seen_at`、`published_at`（取代表 `raw_item` 的发布时间），并初始化 `source_count=1`。`ON CONFLICT DO UPDATE` 分支必须**只**累加 `source_count` 并更新 `last_seen_at`；**禁止**在 `UPDATE` 的 `set` 中覆盖 `event_id`、`representative_raw_item_id`、`representative_title`、`first_seen_at`、`published_at`——否则事件身份与「首建代表原文」语义被后到的 `raw_item` 破坏。

流水线下游对同一事件行的后续写入（Value Judge 写 `*_score`/`should_push`、中文摘要写 `summary_zh`）必须以 `UPDATE ... WHERE event_id = ?` 定位、`set` 中**只含本阶段目标列**，禁止用 `INSERT ... ON CONFLICT` 模板（P0 `persistEventScores` 的全列覆盖式 `set` 是反面模板），以免把 `published_at`/`representative_*`/`first_seen_at` 覆盖回 NULL 而使 Top N 排序静默退化。

去重判定必须全程由程序与 DB 唯一约束保障，禁止交给 LLM。本期仅做此硬去重层，禁止引入 embedding 相似度或 LLM 二次判断。

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
- **那么** `event_id`、`representative_raw_item_id`、`representative_title`、`first_seen_at`、`published_at` 保持首建值不变，仅 `source_count` 累加、`last_seen_at` 更新
