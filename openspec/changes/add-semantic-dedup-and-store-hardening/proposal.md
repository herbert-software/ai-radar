## 为什么

P3 是关键路径上的下一个里程碑：补齐 QA.md §9 分层去重的**第三层（embedding 相似度）**与**第四层（LLM 二次判断）**，让"标题不同但同一事件""中文/英文报道同一事件""同一产品多源出现"被识别为一条，并把精选内容沉淀进知识库（QA.md §13）支持历史查询。当前只做到硬去重 + `title_hash`（`dedup-and-normalization` spec 显式"禁止引入 embedding 相似度或 LLM 二次判断"），`platform-foundation` 仍持"零向量不变量"——语义能力一直留给 P3。

同时，这条正在为 P3 攒数据的采集管道有一处脆弱点：`store.ts` 是 `raw_items` 的唯一 text sink，但**只有 sitemap 采集器在自己那层净化文本**，其余 6 个采集器（RSS / HN / GitHub / Product Hunt / Show HN / HF Papers）与 store 层都未净化 NUL/控制符；且 store 的逐条 INSERT 未包 per-item try/catch——一条坏文本（如含 `\0` 的标题）会让 Postgres `text`/`jsonb` INSERT 抛错并**中止整批入库**，污染正要喂给 P3 的数据。趁启用语义层之前，把净化在 store 层统一收口。

**为什么现在**：阈值实测调优（0.88/0.82）依赖线上积累数周真实数据，但语义层的**代码地基**（向量列、embedding 生成、相似度/LLM 判定、事件合并、KB 入库）不依赖数据、可立即建好；阈值先用 QA.md 默认值作起点并做成可配置，待数据够了再单独调。store 加固与语义地基同属"强化数据管道"，一并交付。

## 变更内容

- **store 层统一文本净化（收口）**：把"剔除 NUL/C0 控制字符（保留 `\t\n\r`）+ lone surrogate（保留合法 emoji 代理对）"从 sitemap 采集器上移到 `store.ts`，对**所有源**入 `raw_items` 的文本列（`title`/`content`/`url`/`metadata` 字符串值）统一生效。
- **store 层 per-item 入库隔离**：逐条 INSERT 包 try/catch，单条失败被隔离并记错误日志、计入新增 `skippedError` 统计，**绝不中止整批**（与既有"单源失败不中止整批采集"对称）。
- **启用 pgvector**：解除 `platform-foundation` 零向量不变量；新增 forward-only 迁移 `CREATE EXTENSION vector` + 在 `ai_news_events` 增 `embedding vector(N)` 列（维度由所选 embedding 模型定，见 design）。
- **embedding 生成**：对事件代表文本（`representative_title` ‖ 代表 raw_item `content` 摘录；语义层在 digest 之前运行、`summary` 尚不可得，故以 content 摘录替代 QA.md §9.2 第三层字面的 `summary`，见 design D2 偏离登记）经 Vercel AI SDK `embed`/`embedMany` 生成向量并落库；外部调用带重试 + 错误日志，失败降级不吞。
- **语义去重第三/四层**：硬去重 → `title_hash` → **embedding 相似度（>0.88 高度疑似 / >0.82 交 LLM）→ LLM 二次判断（输出 `{same_event, same_product, reason}` 经 Zod 校验；`same_product` 本期仅采集不消费）** → DB 唯一约束兜底。阈值可配置，默认取 QA.md 值。
- **事件合并**：判定为同一事件时，由程序确定性地把两条 `ai_news_events` 合并为一条（保留较早 `event_id` 身份、累加 `source_count`、被吞事件置 `merged_into` tombstone、冻结字段不被覆盖；本期**不建** `item_event_relations` 表，故无 raw_item→event 指针需迁移）——合并动作由程序 + DB 执行，LLM 只产语义判断。合并后**所有把行当作独立事件的下游消费者必须排除 tombstone**（见 semantic-dedup「tombstone 对下游消费者不可见」需求）。
- **知识库入库**：新增 `kb_ingestion_records` 表（QA.md §8.7），只入 `long_term_value >= 70` 的精选，先做本地表 KB（符合 ROADMAP「本地表 → Dify HTTP」顺序），`UNIQUE(target_type, target_id, kb_provider)` 幂等。

## 功能 (Capabilities)

### 新增功能
- `semantic-dedup`: embedding 相似度（第三层）+ LLM 二次判断（第四层）+ 确定性事件合并；含 pgvector 向量列启用与 embedding 生成。最终事实与去重身份仍由程序 + DB 唯一约束保障，LLM 只产语义判断。
- `knowledge-base`: 精选内容知识库入库——`kb_ingestion_records` 表、只入 `long_term_value >= 70`、本地表 KB（Dify HTTP 留后续）、`UNIQUE(target_type, target_id, kb_provider)` 幂等。

### 修改功能
- `dedup-and-normalization`: 解除"本期仅硬去重、禁止 embedding/LLM"的限制，分层去重补齐第三/四层（语义层细节归 `semantic-dedup`，本 spec 保留硬去重层不变并去掉禁令）。
- `platform-foundation`: 解除零向量不变量——P3 起允许 `CREATE EXTENSION vector` 与 `ai_news_events` 向量列（仍限本期仅此一表，迁移保持 forward-only 幂等）。
- `source-collectors`: store 层统一文本净化（覆盖全部源）+ per-item 入库隔离（单条坏文本不中止整批）。

## 影响

- **代码**：`src/db/schema.ts`（解除零向量注释 + 加 `embedding` 列）、新增迁移（`CREATE EXTENSION vector` + ALTER ADD COLUMN）、`src/collectors/store.ts`（净化 + try/catch + `skippedError`）、`src/dedup/`（新增 embedding 生成、相似度检索、LLM 判定、事件合并模块）、新增 `src/kb/`（入库 + `kb_ingestion_records`）、`src/pipeline/`（在塌缩后接入语义层与 KB 入库阶段）。
- **依赖/配置**：新增 embedding 模型相关 env（模型名、相似度阈值 `SEMANTIC_DEDUP_HIGH=0.88`/`SEMANTIC_DEDUP_LLM=0.82`、KB 准入阈值复用 `long_term_value>=70`）；CI 注入占位。pgvector 扩展（镜像已是 `pgvector/pgvector`，无需换镜像）。
- **不变量（守住）**：分层去重次序、URL 归一、推送幂等四元组、KB 只入精选(≥70)、所有 Agent 输出 Zod 校验、所有外部 API 带重试与错误日志——均不动；去重/合并/幂等的**最终事实仍由程序与 DB 唯一约束保障，绝不交给 LLM**。
- **非目标**见下。

## 非目标 (Non-Goals)

- **相似度阈值的真实数据实测调优**：0.88/0.82 仅作可配置起点，靠线上数周数据调优留作后续单独变更——本期不声称阈值已调准。
- **Dify / RAGFlow 外接知识库**：本期只做本地表 KB，HTTP 外接（含长文档/PDF 走 RAGFlow）留后续；`kb_provider` 预留 `custom` 之外的取值但不接线。
- **把确定性状态交给 LLM**：去重身份、事件合并落库、推送幂等、唯一约束**绝不**由 LLM 决定；LLM 仅在 0.82–0.88 灰区产 `{same_event, same_product, reason}` 语义判断（`same_product` 本期仅采集不消费），是否合并的最终落库由程序据该判断 + DB 约束执行。
- **P5 工具选型顾问**：`ai_tools`/`task_patterns` 与推荐逻辑不在本期。
- **产品实体的语义合并**：本期语义层只作用于 `ai_news_events`（新闻事件）；`ai_products` 仍沿用 P2 硬规则合并，产品语义合并留后续。
