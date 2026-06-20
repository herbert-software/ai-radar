## 修改需求

### 需求:知识库准入闸只入精选

系统必须仅把 `long_term_value >= 70` 的内容写入知识库（QA.md §13.1「知识库不是垃圾桶」），禁止写入每条 RSS 原文、重复转载、低价值营销稿、纯标题党。准入闸为程序判定（非 LLM 决定是否入库）。准入闸阈值复用 `long_term_value >= 70` 不变量（程序常量 `KB_ADMISSION_FLOOR`——**本变更须先把它从 `kb/index.ts` 私有 const 提升为可导出符号，详见下方候选域说明**）。

**候选域（显式钉死，消除歧义）——本变更扩为两类来源**：

- **事件来源（既有）**：候选 = 「本轮日报链**实际推送成功**（该 `event_id` 当日产生 `push_records.status='success'`）的事件」，**并**排除 tombstone（`merged_into IS NULL`，见 semantic-dedup「tombstone 对所有下游消费者不可见」）。以「已推送成功」为唯一候选界定（而非「importance≥某档的全部事件」），控成本且对齐 config 流水线 `Push → KB Ingestion` 顺序；其 `long_term_value` 由 KB 摘要 Agent 在入库阶段产出。
- **经验来源（本变更新增）**：候选 = `ai_experiences` 中 `long_term_value >= 70` 的经验卡片（`target_type='experience'`）。经验卡片的 `long_term_value` 已由经验提炼 Agent 在提炼阶段产出并 Zod 约束（0..100），故经验来源**直接以卡片自带 `long_term_value` 过准入闸、不再调 KB 摘要 Agent 重算**（避免双评分双 LLM + 口径分裂）；入库元数据（`kb_title`/`summary_zh`/`tags`/`source_urls`/`event_date`/`long_term_value`）直接取自经验卡片字段。经验来源**不以「已推送成功」为前提**（实践锦囊段每日只推 Top N，但全部 `≥70` 经验都应作顾问 RAG 证据语料沉淀，不被每日推送名额所限）。

两类来源都必须经同一 `KB_ADMISSION_FLOOR`（70）程序闸；该常量现为 `kb/index.ts` 模块私有 const，**必须提升为可导出符号**（或迁入共享常量模块），事件链与经验链共同 `import`，禁止写字面量 `70`。两类来源都复用既有 `storeKbDocument` 原语与 `kb_ingestion_records` 幂等（`UNIQUE(target_type,target_id,kb_provider)` 天然容纳 `target_type='experience'`）写入。但**经验来源不得复用 event 版编排 `runKbIngestion`**（其循环硬编码每条候选必调 KB 摘要 Agent `generateKbMetadata`+embedding，对经验卡片既违反「跳过重算」又因输入形状不符降级）——经验来源须走**独立编排 `runExperienceKbIngestion`**，**且必须在 `runDailyWorkflow` 的无候选早退之前执行**（经验入 KB 不以已推送为前提；push-empty 与 KB-empty 是不同集合——所有 ≥70 卡片昨日已推、push 候选空但今日有新 ≥70 卡片时，仍须入 KB；放早退之后会被 push 空早退劫持致 stranding）。`runExperienceKbIngestion`：经验候选 SELECT（独立于 `push_records`，与事件候选路径口径不同、不要求已推送）→ 直接以卡片字段组装**完整 `KbStoreItem`**（**10 字段全必填**）：`targetType = TARGET_TYPE.experience`、**`targetId = ai_experiences.id`**（与推送侧 `target_id` 同源；KB claim CAS 目标身份 + `kb_ingestion_records`/`kb_documents` 的 `target_id`，漏则 tsc 失败/幂等无锚）、`kbTitle = headline_zh ?? scenario`、`summaryZh = summary_zh`、`tags = tools`（卡片 `tools` 数组、空则 `[]`，卡片无独立 tags 字段）、`entities = []`、`sourceUrls = [canonical_source_url]`（有意 canonical-only）、`eventDate = published_at ? getPushDate(published_at) : 当日 pushDate`（镜像 `deriveEventDate` 的 NULL 回退，绝不写 NULL 进 `event_date` date 列）、`longTermValue = 卡片值`、`embedding = null` → `storeKbDocument`（`kbProvider='custom'` 经 options 传入、非 `KbStoreItem` 字段）。即经验来源**只复用入库原语与幂等表、不复用 event 候选编排**；统计自有形状，不复用 event 版 `KbIngestionResult` 的 `agentOk/agentFailed`（经验链不调 KB Agent）。

#### 场景:高价值事件入库
- **当** 某已推送成功事件的 `long_term_value` 为 78
- **那么** 该事件被写入知识库

#### 场景:高价值经验卡片入库
- **当** 某经验卡片（`target_type='experience'`）的 `long_term_value` 为 78
- **那么** 该卡片经 `storeKbDocument` 以 `target_type='experience'` 写入知识库，元数据取自卡片字段，且不再调 KB 摘要 Agent 重算评分

#### 场景:低价值内容被准入闸拦下
- **当** 某事件或经验卡片的 `long_term_value` 为 62（小于 70）
- **那么** 它不被写入知识库，记录为未达准入阈值

#### 场景:经验卡片入库不以已推送为前提
- **当** 某经验卡片 `long_term_value >= 70` 但当日未被实践锦囊段选入 Top N 推送
- **那么** 该卡片仍作为顾问 RAG 证据语料写入知识库（经验来源候选不要求 `push_records.status='success'`）
