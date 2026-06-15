## 新增需求

### 需求:知识摘要 Agent 产出入库元数据

系统必须提供知识摘要 Agent（QA.md §10.7 Knowledge Ingestion Agent），对候选事件经 LLM（Vercel AI SDK `generateObject`）产出经 Zod 校验的结构化 JSON：`{ kb_title, summary_zh, tags: string[], entities: string[], source_urls: string[], event_date, long_term_value: number }`。`long_term_value` 的 Zod 必须钉死取值域 `number().int().min(0).max(100)`——防越界值（如 200 或负数）绕过 `>= 70` 准入闸语义；越界即视为校验不过、跳过该条。该 Agent 属外部 API 调用，必须带重试与错误日志；输出未通过 Zod 校验时必须跳过该条、不入库（不污染知识库），不得中止整批。入库元数据的生成可由 LLM 完成，但**实际入库由程序执行**（QA.md §10.7）。

#### 场景:Agent 产出结构化入库元数据
- **当** 一条候选事件送入知识摘要 Agent
- **那么** 返回经 Zod 校验的 `{ kb_title, summary_zh, tags, entities, source_urls, event_date, long_term_value }`

#### 场景:校验不过的输出被跳过不入库
- **当** 某候选事件的 Agent 输出未通过 Zod 校验或调用重试后仍失败
- **那么** 系统记错误日志并跳过该条、不写入知识库，其余候选照常处理

### 需求:知识库准入闸只入精选

系统必须仅把 `long_term_value >= 70` 的内容写入知识库（QA.md §13.1「知识库不是垃圾桶」），禁止写入每条 RSS 原文、重复转载、低价值营销稿、纯标题党。准入闸为程序判定（非 LLM 决定是否入库）。准入闸阈值复用 `long_term_value >= 70` 不变量。

**候选域（显式钉死，消除歧义）**：候选 = 「本轮日报链**实际推送成功**（该 `event_id` 当日产生 `push_records.status='success'`）的事件」，**并**排除 tombstone（`merged_into IS NULL`，见 semantic-dedup「tombstone 对所有下游消费者不可见」）。以「已推送成功」为唯一候选界定（而非「importance≥某档的全部事件」），控成本且对齐 config 流水线 `Push → KB Ingestion` 顺序；避免落选/被合并事件进入 KB。

#### 场景:高价值内容入库
- **当** 某事件的 `long_term_value` 为 78
- **那么** 该事件被写入知识库

#### 场景:低价值内容被准入闸拦下
- **当** 某事件的 `long_term_value` 为 62（小于 70）
- **那么** 该事件不被写入知识库，记录为未达准入阈值

### 需求:本地表知识库存储

系统必须先以本地表实现知识库（符合 ROADMAP「本地表 → Dify HTTP」顺序）：新增 `kb_documents` 表承载入库内容（`id`、`target_type`、`target_id`、`kb_title`、`summary_zh`、`tags JSONB`、`entities JSONB`、`source_urls JSONB`、`event_date`、`long_term_value`、`embedding vector(1536)`（供未来检索）、`created_at`）。`kb_provider` 取 `custom` 指向本地表。Dify/RAGFlow HTTP 外接不在本期范围（`kb_provider` 预留其它取值但不接线）。

#### 场景:精选事件写入本地 kb_documents
- **当** 一条 `long_term_value >= 70` 的事件入库
- **那么** `kb_documents` 新增一行，含 `kb_title`/`summary_zh`/`tags`/`entities`/`source_urls`/`event_date`/`long_term_value`，`kb_provider='custom'`

### 需求:知识库入库幂等

系统必须以 `kb_ingestion_records` 表（QA.md §8.7）记录入库日志，并以 `UNIQUE(target_type, target_id, kb_provider)` 保障同一目标对同一 provider **最终只成功入库一次**。`kb_ingestion_records.kb_document_id` 必须回指 `kb_documents.id`。

**状态感知的认领（claim）——`success` 跳过、`failed`/僵尸 `pending` 可重试**：幂等闸是「`success` 终态只一次」，**不是「记录存在即跳过」**。因 `failed` 与崩溃残留的 `pending` 行也占用 `UNIQUE(target_type,target_id,kb_provider)`，认领**绝不可**用 `ON CONFLICT DO NOTHING`（那会让一条 `failed` 行把后续重试永久挡死、该 event 再不入库——与「失败可重试」自相矛盾，对齐 **value-judge 的 claim CAS** 状态感知范式；push dispatcher 同为状态感知但用「预算 pending-set + `ON CONFLICT DO NOTHING`」另一范式，此处取 value-judge 的 `DO UPDATE … WHERE status<>'success'` CAS）。认领必须为：`INSERT kb_ingestion_records(status='pending') ON CONFLICT(target_type,target_id,kb_provider) DO UPDATE SET status='pending', ingested_at=now() WHERE kb_ingestion_records.status <> 'success' RETURNING id`——已 `success` 者 `WHERE` 不满足、不返回行 → 跳过（不重入）；不存在 / `failed` / 僵尸 `pending`（可加 `OR ingested_at < now()-T` 回收）者被认领为 `pending` 并返回。

**两表写入原子性（防重复/孤儿 `kb_documents`）**：`kb_documents` 自身无业务唯一约束。认领成功（RETURNING 非空）后，**插入 `kb_documents` 与置该 record `status='success'`、回指 `kb_document_id` 必须在同一 DB 事务**内：成功则一并提交；任一步失败 → 事务回滚（**不留 `kb_documents`**）→ 再以独立 `UPDATE` 置 `status='failed'` 保留 `error_message`（下次认领因 `status='failed'` 重新抢到、重试；因失败已回滚故无残留文档，重试不产生重复）。KB 入库阶段运行在日报链单例锁内（单实例、无并发认领），认领 CAS + 两表同事务共同保证并发与崩溃下都无重复/孤儿 `kb_documents`。崩溃若发生在「事务回滚之后、独立置 `failed` 之前」，该行停在认领时写入的 `pending`（僵尸 pending），由下次认领的 `status<>'success'`（含僵尸 pending 回收）重新抢到重试，无正确性损失（回滚已确保无残留文档）。

#### 场景:已成功入库的事件重复触发被跳过
- **当** 同一事件（同 `target_type`/`target_id`/`kb_provider`）已有 `status='success'` 记录、再次触发入库
- **那么** 认领的 `ON CONFLICT DO UPDATE ... WHERE status <> 'success'` 不满足、不返回行，入库被跳过，不产生重复 `kb_documents`/`kb_ingestion_records` 行

#### 场景:入库失败保留可重试状态且能真正重试
- **当** 某次入库在写入阶段失败、置 `status='failed'` 保留 `error_message`，其后再次触发入库
- **那么** 认领据 `status <> 'success'` 重新抢到该行、置回 `pending` 重试（`failed` 行绝不把重试永久挡死）；重试成功后 `status='success'`、新增**恰一条** `kb_documents`（失败已回滚无残留，不重复）
