## 新增需求

### 需求:经验类条目的识别与提炼路由

系统必须以**程序规则**（而非 LLM）判定哪些 `raw_items` 属于"AI 博主经验类"内容并路由进经验提炼链：判定依据为两个确定性硬字段 `source='blogger'` 且 `raw_type='experience'`（由采集层写入，见 source-collectors）。经验类条目入库即置 `collapsed=true`（沉淀），且事件塌缩类型路由显式排除 `raw_type='experience'`（见 dedup-and-normalization）——二者共同保证经验类条目**绝不**被新闻/告警事件塌缩消费、**绝不**塌缩进 `ai_news_events`、**绝不**进入要闻日报段。经验提炼链选条必须为 `source='blogger'` AND `raw_type='experience'` AND **`canonical_url IS NOT NULL`**（两硬字段都进谓词，与标记一致）且按 `canonical_source_url` 反连接「尚无对应经验卡片」的经验类 raw_items。**批内去重**：反连接只挡跨天（DB 已有卡片）的重复——同一轮批内两条同 `canonical_url` 的新条目都会过反连接、都被提炼（`ON CONFLICT` 只兜底写库一行、不防重复 LLM），故选条必须 **`DISTINCT ON (canonical_url)`**（确定性代表排序，如 `ORDER BY canonical_url, id`）做批内去重，确保跨 feed 同 URL **一轮内只提炼一次**。`canonical_url` 为空的经验条目（无 link/相对/非 http 链接经 `normalizeUrl` 得 NULL）**没有去重键**：必须由选条 `canonical_url IS NOT NULL` 预过滤排除（否则反连接 `NULL=NULL` 永不匹配 → 每轮重选、无界重复调 LLM，且写 `canonical_source_url=NULL` 撞 `NOT NULL` 抛错），跳过提炼 + 记日志。**这类行终态为「永久 `collapsed=true` 的不可处理沉淀」**（占一行、不重扫、不烧 LLM、对称新闻 unprocessable）——**禁止对其加重扫逻辑**（否则重新引入无界重选 bug）。

#### 场景:经验类来源被路由进提炼链且不进事件塌缩
- **当** 采集落库一条 `source='blogger'`、`raw_type='experience'`、`canonical_url` 非空的 `raw_items`（`collapsed=true`）
- **那么** 它被经验提炼链选中处理，且不进入要闻日报段、不被新闻/告警事件塌缩选入、不塌缩进 `ai_news_events`

#### 场景:canonical_url 为空的经验条目被选条排除
- **当** 一条 `raw_type='experience'` 的 raw_item 其 `canonical_url` 为 NULL（无 link/不可规范化）
- **那么** 经验链选条 `canonical_url IS NOT NULL` 将其排除、不提炼、记日志，绝不每轮重选重复调 LLM、绝不以 `canonical_source_url=NULL` 写库

#### 场景:新闻类来源不被误入经验链
- **当** 采集落库一条来自普通新闻源（rss 新闻 / hacker_news / github）的 `raw_items`
- **那么** 经验提炼链不选中它（其 `raw_type≠'experience'`），它仍按既有新闻链处理

### 需求:经验提炼 Agent 结构化输出

系统必须提供一个**经验提炼 Agent**，对每条经验类条目输出**结构化 JSON 并做 Zod schema 校验**，字段至少包含：适用场景、涉及的 AI 工具（数组）、具体做法或技巧、适用条件或前提、`long_term_value`（**不含来源链接**——来源 URL 是确定性的 `canonical_source_url`，不由 LLM 产出）。`long_term_value` 必须经 Zod 约束为 `int` 且范围 `0..100`（对齐既有 KB Agent 的 `min(0).max(100)`），越界/缺字段/类型不符必须**重试或降级**（绝不吞掉、绝不写未校验或越界的脏结果）。提炼前必须对超长 transcript/博文按 `EXPERIENCE_TEXT_MAX_CHARS` 截断（防 token 超限）。该 Agent 仅负责语义提炼+评分，不负责判定是否采集、是否重复、是否推送（那些由程序 + DB 保障）。所有对 LLM 的调用必须带重试与错误日志。

#### 场景:提炼输出经 schema 校验后落库
- **当** 经验提炼 Agent 对一条经验类条目产出 JSON
- **那么** 该 JSON 必须通过 Zod schema 校验（含必填字段、类型、`long_term_value` 0..100）后才写入 `ai_experiences`

#### 场景:校验失败或评分越界不写脏数据
- **当** Agent 返回的 JSON 缺字段、类型不符或 `long_term_value` 越界、重试后仍不合规
- **那么** 系统按降级策略处理并记错误日志，**不**把不合规结果写入 `ai_experiences`

### 需求:经验卡片实体表与确定性去重幂等

系统必须新增实体表 `ai_experiences` 承载提炼后的经验卡片（系统级事实与状态以 DB 为准）。主键必须为 `varchar(128)` 不透明 surrogate（`gen_random_uuid()::text`，与 `event_id`/`product_id` 同口径，使 `push_records.target_id` 互引类型相容）。去重必须以 `canonical_source_url`（经验行规范化来源 URL）作 `UNIQUE` 约束 + `ON CONFLICT (canonical_source_url)` 收敛，**纯程序键 + DB 唯一约束，绝不由 LLM 判定是否重复**——同一来源（同一视频/博文、同 watch URL）即便经不同 feed 采到不同 `raw_item`，也因 `canonical_source_url` 相同而收敛为一行。`representative_raw_item_id` 作 provenance（裸 bigint NOT NULL，对齐既有零 FK 惯例）。该表必须承载推送所需的稳定 `target_id`（主键）与 `published_at`（时效窗口）。

#### 场景:跨 feed 同一来源不产生重复经验卡片
- **当** 同一视频经两个不同 feed 被采为两条 `raw_item`（`source_item_id` 不同）但规范化来源 URL 相同
- **那么** 二者经 `ON CONFLICT (canonical_source_url)` 收敛，`ai_experiences` 中该来源仅一行

#### 场景:同批内跨 feed 同 URL 只提炼一次
- **当** 同一轮选条命中两条同 `canonical_url` 的新经验类 raw_item（DB 中尚无对应卡片）
- **那么** 选条 `DISTINCT ON (canonical_url)` 批内去重使本轮只提炼一次（只调一次 LLM），不依赖 `ON CONFLICT` 事后兜底

#### 场景:去重不依赖 LLM
- **当** 判定一条经验卡片是否已存在
- **那么** 判定完全由 `canonical_source_url` 程序键 + DB 唯一约束完成，不调用 LLM

### 需求:价值闸门与知识库沉淀

经验卡片必须经价值判断打出 `long_term_value` 评分（Agent 语义打分、程序定闸门）；只有 `long_term_value >= 70` 的精选经验卡片才写入知识库作为顾问 RAG 证据语料，严守 QA.md §13.1「知识库不是垃圾桶」。`>= 70` 闸门必须**复用既有 `KB_ADMISSION_FLOOR` 常量**、由程序判定（绝不让 LLM 决定是否入库）。该常量现为模块私有（`kb/index.ts`），**必须先提升为可导出符号**（或迁入共享常量模块），由经验链的 **KB 准入候选**与**实践锦囊推送候选**两处共同 `import`——**禁止任一处写字面量 `70`**（否则违背「单一 70」不变量、埋口径分裂）。入库必须复用既有 `storeKbDocument` 原语与 `kb_ingestion_records` 幂等（`UNIQUE(target_type,target_id,kb_provider)`），但**不得复用 event 版编排 `runKbIngestion`**（其循环硬编码每条候选必调 KB 摘要 Agent `generateKbMetadata`）——须新写独立编排 `runExperienceKbIngestion`，**且必须在 `runDailyWorkflow` 的无候选早退之前、channel-blind 单跑步骤内执行**（不被 push 空早退劫持：经验入 KB「不以已推送为前提」，而 push-empty 与 KB-empty 是不同集合——某天 ≥70 卡片昨天已全推、push 候选空但今天有新 ≥70 卡片仍须入 KB；若放早退之后会 stranding）。`runExperienceKbIngestion`：候选 SELECT（经验来源，不要求已推送）→ 直接以卡片字段组装完整 `KbStoreItem`（**10 字段全必填**）：`targetType = TARGET_TYPE.experience`、**`targetId = ai_experiences.id`**（与推送侧 `target_id` 同源——KB claim CAS 目标身份 + 幂等键第二元，漏则 tsc 失败/幂等无锚）、`kbTitle = headline_zh ?? scenario`、`summaryZh = summary_zh`、`tags = tools`（卡片 `tools` 数组、空则 `[]`，卡片**无独立 tags 字段**）、`entities = []`、`sourceUrls = [canonical_source_url]`（有意 canonical-only，经验表不存原始 url）、`eventDate = published_at ? getPushDate(published_at) : 当日 pushDate`（镜像 `deriveEventDate` 的 NULL 回退，绝不写 NULL/undefined 进 date 列）、`longTermValue = 卡片值`、`embedding = null` → `storeKbDocument`（`kbProvider='custom'` 经 options 传入、非 item 字段），**复用 `ai_experiences` 已带的 `long_term_value`、不再调 KB 摘要 Agent 重算**。失败隔离、永不向上抛。

#### 场景:高价值经验入库
- **当** 一条经验卡片 `long_term_value >= KB_ADMISSION_FLOOR`（70）
- **那么** 它经既有 `storeKbDocument`/`kb_ingestion_records` 路径以 `target_type='experience'` 写入知识库，重复入库被幂等抑制，且不再调 KB Agent 重算评分

#### 场景:低价值经验不入库
- **当** 一条经验卡片 `long_term_value < 70`
- **那么** 它不写入知识库（仍可留在 `ai_experiences` 供观测）

#### 场景:纯经验-全已推日仍入 KB（不被早退劫持）
- **当** 某日新闻空、产品空、且所有 ≥70 经验昨日已 success 推送（push 候选空），但今天提炼出新的 ≥70 经验卡片
- **那么** `runExperienceKbIngestion` 在早退之前执行、把新卡片沉淀进知识库，不因 push 候选空的早退而被跳过

#### 场景:published_at 为空的经验卡片仅入 KB 不进推送
- **当** 一条 ≥70 经验卡片 `published_at` 为 NULL（feed 无可解析日期）
- **那么** 它经 `eventDate` 回退当日入 KB，但不进实践锦囊推送候选（recency 窗口对 NULL 求假），刻意接受 date-less 卡片 KB-only

### 需求:每日实践锦囊推送段与幂等

系统必须提供一个**每日「实践锦囊」推送段**，**内联进 `runDailyWorkflow` 并搭日报单例锁 `daily-digest:{push_date}` 便车执行**（不新增 queue/cron/独立锁）。该段必须置于 `runDailyWorkflow` 的**「无候选早退」判断之前**（与产品段同侧；既有早退在新闻 Top-N 空且全 channel 产品空时 `return 'skipped-no-candidates'`、位于 KB 阶段之前），且**早退判空条件必须扩为「新闻空 ∧ 全 channel 产品空 ∧ 全 channel 经验空」三者皆空才早退**——否则「纯经验日」（无新闻无产品但有高价值经验）会被早退静默跳过、经验永不推送。经验提炼/塌缩必须是 **channel-blind** 动作、每批只跑一次，再按 channel 分别展开候选（镜像产品段），失败隔离、永不向上抛。推送候选 = `ai_experiences.long_term_value >= KB_ADMISSION_FLOOR`（**引用导出常量、不写字面量 70**）、`published_at` 在 recency 窗口内、且「该卡片从未以该 channel `success` 推送」（`NOT EXISTS(push_records...)` anti-join），按 `long_term_value` DESC + `published_at` 排序取 Top N。复用 Push Dispatcher 幂等四元组 `UNIQUE(target_type, target_id, channel, push_date)`（`target_type='experience'`、`target_id=经验卡片主键`、`push_date` 取 Asia/Shanghai），遵守"先写 `pending` → 调 API → 置 `success`/`failed`，唯一键冲突即跳过"。时效性：**禁止上线后批量回推历史旧经验**，靠 `published_at` 窗口谓词只推当期。`target_type='experience'` 与既有 event/product/alert/weekly 互不挤占。

#### 场景:同日同卡片同通道不重复推
- **当** 某经验卡片已在今日以某通道 success 推送
- **那么** 同日该卡片该通道的再次触发因 `UNIQUE(target_type, target_id, channel, push_date)` 冲突被跳过

#### 场景:上线不批量回推旧经验
- **当** 该功能首次上线 / worker 重启
- **那么** 实践锦囊段只推 `published_at` 在 recency 窗口内的当期经验，不批量回推窗口外的历史经验卡片

#### 场景:提炼塌缩 channel-blind 只跑一次
- **当** 双通道（telegram + feishu）都启用、实践锦囊段触发
- **那么** 经验提炼/塌缩每批只执行一次（channel-blind），再按各 channel 分别判定候选与幂等，不因多通道重复提炼

#### 场景:纯经验日不被无候选早退跳过
- **当** 某日新闻 Top-N 为空、全 channel 产品候选为空，但存在高价值经验卡片
- **那么** `runDailyWorkflow` 不在经验段之前早退（早退判空已纳入经验候选），实践锦囊段照常推送当期高价值经验
