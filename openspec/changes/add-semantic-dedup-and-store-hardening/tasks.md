# tasks — add-semantic-dedup-and-store-hardening

> 顺序建议：先做组 1（store 加固，独立可先合）→ 组 2（schema 地基）→ 组 3/4（语义层）→ 组 5（KB）→ 组 6（管道接线）→ 组 7（收尾）。

## 1. store 层文本加固（独立，可先合）

- [x] 1.1 在 `src/collectors/`（或 `dedup/normalize.ts` 邻近）新增纯函数 `sanitizeText`：剔 NUL/C0 控制符（保留 `\t\n\r`）+ lone surrogate（保留合法 emoji 代理对）；附单测覆盖 NUL/`&#0;`/lone surrogate/合法 emoji 边界。
- [x] 1.2 `store.ts` 对每条目 `title`/`content`/`url` 及 `metadata` 字符串值统一过 `sanitizeText` 后再 INSERT（全源生效）。
- [x] 1.3 `store.ts` 逐条 INSERT 包 per-item `try/catch`：捕获→记错误日志→`skippedError += 1`→continue；`StoreResult` 新增 `skippedError` 字段，既有 `received`/`attempted`/`inserted`/`processableCount`/`skippedInvalid` 口径不变。
- [x] 1.4 集成测试（真实 pg）：① 一批含 NUL 标题的条目，净化后全部入库不抛错；② 注入一条会触发 INSERT 抛错的坏数据，验证被隔离、`skippedError=1`、其余照常入库、整批不中止。

## 2. P3 Schema 迁移（向量 + 知识库）

- [x] 2.1 `schema.ts` 解除零向量不变量注释；为 `aiNewsEvents` 增 `embedding`（pgvector `vector(1536)`）与 `mergedInto`（`varchar(128)` 可空）列。
- [x] 2.2 新增 forward-only 迁移：`CREATE EXTENSION IF NOT EXISTS vector;` + `ALTER TABLE ai_news_events ADD COLUMN embedding vector(1536)` + `ADD COLUMN merged_into varchar(128)`。
- [x] 2.3 `schema.ts` 定义 `kbDocuments`（`id`/`target_type`/`target_id`/`kb_title`/`summary_zh`/`tags jsonb`/`entities jsonb`/`source_urls jsonb`/`event_date`/`long_term_value`/`embedding vector(1536)`/`created_at`）与 `kbIngestionRecords`（QA §8.7，含 `UNIQUE(target_type, target_id, kb_provider)`），新增对应迁移。
- [x] 2.4 迁移幂等验证：`drizzle-kit migrate` 连跑两次，第二次无新 SQL、journal 与结构不变；集成测试断言 `vector` 扩展存在、两列与两表存在、`kb_ingestion_records` 唯一约束就位。

## 3. 事件 embedding 生成

- [x] 3.1 新增 `src/dedup/embedding.ts`：取事件 `representative_title` ‖ 代表 raw_item `content` 摘录（截断 `EMBEDDING_TEXT_MAX_CHARS` 默认 2000）构造文本；经 Vercel AI SDK `embedMany` 批量生成，带重试 + 错误日志。**空文本兜底**：拼接 trim 后为空/纯空白时跳过该事件的 embedding 与合并（记日志、保留独立），绝不对空文本求 embedding（防退化向量误并）。
- [x] 3.2 落库 + **候选窗口 bootstrap**：对候选窗口内（`first_seen_at >= now()-SEMANTIC_WINDOW_DAYS`）**所有** `embedding IS NULL AND merged_into IS NULL` 的新闻事件写 `ai_news_events.embedding`（**不只本轮 collapse 新事件**——历史存活者须有 embedding 才能作 KNN 候选，跨天去重前提）；幂等：已嵌入不重生成。单条生成失败→记日志→该事件跳过语义合并（保留独立），不中止整批。**首轮 backlog 上限 + 嵌入顺序**：单轮 bootstrap 至多嵌 `EMBEDDING_BOOTSTRAP_MAX_PER_RUN`（默认 500）条、余量后续日报轮次续嵌（防 P3 首部署一次性嵌入 14 天 backlog 撑爆 embedding 调用/拖住日报锁）；顺序须**先嵌本轮新事件**（保证今日新事件本轮即可作查询对象参与合并），再以 `first_seen_at` 升序填补剩余配额嵌历史存活者（作候选）——与 spec「候选窗口 bootstrap·嵌入顺序」一致（**不是**单纯 first_seen_at 升序）。
- [x] 3.3 单测（注入桩不触网）：① 已有 embedding 的事件不重新生成；② 一条生成失败时其余照常落库、失败条被跳过；③ **窗内历史 `embedding IS NULL` 事件被补嵌**（非仅本轮新事件）；④ **空/空白文本事件被跳过、不调用 embed**。

## 4. 语义去重第三/四层 + 事件合并

- [x] 4.1 候选检索 `src/dedup/semantic-search.ts`：窗口 `first_seen_at >= now()-SEMANTIC_WINDOW_DAYS`（默认 14）、排除自身与 `merged_into IS NOT NULL`、`ORDER BY embedding <=> $q LIMIT K`（默认 10）；返回 `cosine_sim = 1 - distance`。
- [x] 4.2 阈值分流：`sim>0.88` 直接判同事件；`0.82<sim<=0.88` 交 LLM；`sim<=0.82` 不合并。阈值/窗口经 env 可配（`SEMANTIC_DEDUP_HIGH`/`SEMANTIC_DEDUP_LLM`/`SEMANTIC_WINDOW_DAYS`），默认取 QA 值。
- [x] 4.3 LLM 二次判断 `src/dedup/semantic-judge.ts`：`generateObject` + Zod `{same_event, same_product, reason}`，带重试；失败/校验不过→降级为"不合并"（记日志，不中止）。
- [x] 4.4 确定性事件合并 `src/dedup/merge-events.ts`（单事务、两行 `FOR UPDATE` **按 `event_id` 升序加锁**防 AB-BA 死锁）：存活=`first_seen_at` 较早（并列取 `event_id` 字典序小）；存活**一次性** `source_count += 被吞`（被吞 tombstone 的 `source_count` 此后冻结）、`published_at=COALESCE`、`first_seen_at=LEAST`、`last_seen_at=GREATEST`；冻结存活 `event_id`/`representative_*`/`dedup_key`；被吞置 `merged_into=存活event_id`（不物理删）。**合并 provenance**：记录被吞/存活 `event_id`、`cosine_sim`、触发档位（`high-auto`/`llm-confirmed`）、LLM `reason`（若经 LLM）到可观测日志/轻量审计，使误并可审计可回滚。
- [x] 4.5 `collapse.ts` tombstone 改投：`ON CONFLICT (dedup_key)` 命中 `merged_into` 非空的行时改投 `merged_into` 指向的存活事件，不新建重复、不向 tombstone 累加 `source_count`。**链式解析**：沿 `merged_into` 递归/迭代到终态存活者（`merged_into IS NULL`），带环路保护（已访问集合，命中环报错告警），不得停在仍是 tombstone 的中间行。**并发原子性（塌缩 vs 合并跨链并发，告警链塌缩不持日报锁）**：`DO UPDATE` 的 `source_count+1` 加 `WHERE ai_news_events.merged_into IS NULL` 守卫（命中 tombstone 时不动 tombstone）；命中 tombstone 则在同一事务内对命中行持行锁（`ON CONFLICT` 行锁或 `SELECT FOR UPDATE`）读 `merged_into`、链解析后 `UPDATE 存活者 SET source_count+1, last_seen_at`——靠冲突 `dedup_key` 行锁与并发合并（`FOR UPDATE` 被吞行）串行化，增量只落存活者。
- [x] 4.6 不变量集成测试（真实 pg）：① sim>0.88 两事件合并为一、`source_count` 累加、存活身份不变；② 灰区 LLM 判 same→合并、LLM 失败→不合并（降级安全）；③ tombstone 改投：后到同 `dedup_key` raw_item 塌缩进存活者不新建重复；④ **跨天幂等**：昨日已 push 事件为存活者时，今日推送候选据"从未以该 channel success"跳过、同事件不重推（显式覆盖 `UNIQUE(target_type,target_id,channel,push_date)` 幂等）；⑤ **链式合并**：A 吞 B 后 A 又被吞入 C，命中 B 的 `dedup_key` 的 raw_item 改投到终态 C（非 tombstone A）；⑥ **source_count 不重复**：合并吸收一次 + 后到新 raw_item 仅 +1，被吞已冻结的 source_count 不重加；⑦ **塌缩 vs 合并并发**（模拟告警链塌缩与日报链合并交错触碰同一被吞行）：两序（合并先 / 塌缩先）下 `source_count` 既不丢也不重、增量最终都落存活者、tombstone `source_count` 不被改，验证靠冲突行行锁串行化。

- [x] 4.7 **tombstone 对下游消费者不可见（合并核心闭环）**：给以下读 `ai_news_events` 的查询/写入加 `merged_into IS NULL` 排除（按 spec「tombstone 对所有下游消费者不可见」枚举表）：`value-judge/score-events.ts`（候选 SELECT **与 claim CAS、评分写 CAS 三处自身 `WHERE` 都加**谓词——告警链无锁、SELECT→claim→评分写均分离、任一间隙有 TOCTOU，仅 SELECT/claim 收口不充分）、`selection/top-n.ts`（候选 SELECT）、`published-at-inference/backfill.ts`（候选 SELECT **与回填 CAS 自身 `WHERE` 都加**谓词，同上 TOCTOU 理由）、`pipeline/weekly-report.ts`、`pipeline/alert-scan.ts`、`mcp/tools/source-quality.ts`（`count(distinct event_id)`）、`mcp/tools/search-events.ts`（count + rows 两查询）/`get-today.ts`/`mark-event.ts`（命中 tombstone 走 `updated.length===0` 的「未找到」分支、不静默落写）/`push-event-now.ts`（SELECT 即排除、不手动推 tombstone）、KB 候选选择（组 5）。**读路径集成测试**：构造一条 tombstone 事件，断言它**不**进 value-judge 评分、**不**进 Top N、**不**被推送、**不**出现在告警候选/周报/MCP `search-events`/KB 候选/`source-quality` 计数中。**并发交错测试**：模拟「候选 SELECT 选中 B → 日报合并把 B 置 tombstone → CAS 执行」交错，断言 claim CAS / **评分写 CAS**（含 claim 成功后、评分写前才置 tombstone 的链内二次窗口）/ 回填 CAS 各因自身 `WHERE merged_into IS NULL` 命中 0 行、不 claim/不评分写/不回填/不复活 tombstone（与 6.3 的写路径断言互补、不可互替）。

## 5. 知识库入库

- [x] 5.1 知识摘要 Agent `src/kb/ingestion-agent.ts`：`generateObject` + Zod `{kb_title, summary_zh, tags[], entities[], source_urls[], event_date, long_term_value}`，`long_term_value` 钉 `number().int().min(0).max(100)`（越界即校验不过、防绕过准入闸）；带重试 + 错误日志；校验不过→跳过该条不入库。
- [x] 5.2 准入闸（程序）：仅 `long_term_value >= 70` 入库；**候选 = 当日推送 success（`push_records.status='success'`）且 `merged_into IS NULL` 的 event**（单一口径，排除 tombstone 与落选事件，控成本）。
- [x] 5.3 本地表入库 `src/kb/store.ts`：**状态感知认领**——`INSERT kb_ingestion_records(pending) ON CONFLICT(target_type,target_id,kb_provider) DO UPDATE SET status='pending', ingested_at=now() WHERE kb_ingestion_records.status <> 'success' RETURNING id`（`success` 不返回行→跳过；`failed`/僵尸 `pending` 重新抢到→重试；**不可用 `DO NOTHING`**，否则 `failed` 永久挡死重试）。认领成功后**同一事务**写 `kb_documents`（含 embedding）+ 置 record `status='success'`、`kb_document_id` 回指；失败→事务回滚（不留 `kb_documents`）→ 独立 `UPDATE status='failed'` 保留 `error_message`（下次认领重试，无残留文档）。
- [x] 5.4 幂等不变量集成测试（真实 pg）：① 同一 `(target_type,target_id,kb_provider)` 已 `success` 后重复触发被认领 `WHERE status<>'success'` 跳过、不产生重复 `kb_documents`/`kb_ingestion_records`；② `long_term_value=62` 被准入闸拦下不入库；③ 入库写入阶段失败→`status=failed` 保留 `error_message`，**再次触发能真正重试**（认领重新抢到该 `failed` 行、重试成功后 `status=success` 且仅一条 `kb_documents`——验证 `failed` 不会永久挡死重试）；④ **两表原子性**：写入失败时事务回滚后无孤儿 `kb_documents`（断言 documents 行数 = `success` records 数）；⑤ **tombstone 排除**：被合并掉的 event 不进 KB 候选、不产生 `kb_documents`。

## 6. 管道接线（仅日报链）

- [x] 6.1 `run-daily-workflow.ts`：在 `collapseUncollapsedRawItems` 之后、`scoreUnscoredEvents` 之前插入 `semanticMergeEvents` 阶段（embedding 生成→候选检索→分流→合并）；加 `SEMANTIC_DEDUP_ENABLED`（默认 on）开关，关闭时跳过该阶段。
- [x] 6.2 在 push 之后插入 KB 入库阶段（对当日高价值/已推送事件跑组 5）；KB/语义阶段的降级不计入 judge/digest 熔断分母（语义层独立）。
- [x] 6.3 确认实时告警链（`alert-scan.ts`）**不**调用语义合并/KB（保持硬去重快路径）；加测试断言告警链不触发 `semanticMergeEvents`。

## 7. 配置、CI 与收尾

- [x] 7.1 新增 env 及校验：`EMBEDDING_MODEL`(默认 `text-embedding-3-small`)、`EMBEDDING_TEXT_MAX_CHARS`(2000)、`EMBEDDING_BOOTSTRAP_MAX_PER_RUN`(默认 500，首轮 backlog 上限)、`SEMANTIC_DEDUP_HIGH`(0.88)、`SEMANTIC_DEDUP_LLM`(0.82)、`SEMANTIC_WINDOW_DAYS`(14)、`SEMANTIC_DEDUP_ENABLED`(on)；更新 `.env.example`；CI 注入占位。
- [x] 7.2 全量 `npx tsc --noEmit` 0 错、`npm run lint` 0 错、`vitest` 全绿（677 passed / 0 failed，连真实 pg+redis 实跑；组 1/2/4/5 新增不变量测试均实跑通过）。说明：15 skip 为既有 env-gated 迁移测试（`DATABASE_URL` 显式导出后 13/13 通过）与真实凭据（Telegram/Feishu token）测试，非 P3 新测被跳过。
- [x] 7.3 `docker compose`（pg+redis 已 healthy）+ `npm run migrate` 连跑两次验证迁移幂等：两次均 exit 0、第二次 journal 级 no-op（含 vector 扩展 + embedding/merged_into 两列 + kb_documents/kb_ingestion_records 两表）。
- [x] 7.4 PR 描述要点（归档/开 PR 时填入）：① 相似度阈值 0.88/0.82 为 QA 默认起点、**非实测调优**（对齐 proposal 非目标），靠线上数周数据后续单独调；② 真实 embedding/LLM **送达**需真实 key，本会话集成测试用注入桩验证逻辑、未触真实外部 API，真实链路交用户本地配 key 确认；③ embedding 维度钉死 1536，换维度模型属新 forward-only 迁移。
