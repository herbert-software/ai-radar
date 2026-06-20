## 上下文

现有流水线（P0–P4 已落地）采新闻/产品/论文/仓库 → 去重塌缩 → Value Judge → 中文摘要 → 推送 + KB。它没有"实践经验"这条进料，而 P5「AI 工具选型顾问」（QA.md §15「不能只靠 RAG」）正缺这层证据。本变更加一条与现有链**并行**的经验提炼链，最大化复用既有设施（collector registry、RSS 采集、源内幂等、Push Dispatcher 幂等四元组、KB 入库原语与幂等）。视频深度已与用户确认选「字幕优先」（A 方案）：只取有字幕的 YouTube transcript，不做 ASR。

**关键基线事实（本设计据实读 `src/` 校正，勿凭记忆假设）**：
- 事件塌缩 `collapseUncollapsedRawItems`（`src/dedup/collapse.ts:303-325`）**按 `raw_type` 路由、不按 `source`**：只排除 `product`/`paper`，`post`/`news`/`NULL` 等一律当新闻类纳入 `ai_news_events`；且**日报链与实时告警链（`alert-scan.ts:290-298`）共用此函数**、全库扫 `collapsed=false`。故"独立 source 让新闻链不跑经验源"对**塌缩阶段不成立**——隔离必须在 `raw_type` + `collapsed` 维度做。
- product 段**已无独立调度**（`product-digest.ts:1-11`「队列/worker/cron/独立锁已移除」），现为 `runDailyWorkflow` 内联段、搭 `daily-digest:{push_date}` 锁便车。
- `push_records.target_id` 与 `ai_news_events.event_id`/`ai_products.product_id` 均 `varchar(128)`（`gen_random_uuid()::text`），刻意保类型相容供 `target_id` 互引。
- KB 候选 `selectCandidates`（`src/kb/index.ts:103-145`）绑死「`push_records` success 的 event_id JOIN `ai_news_events`」；`storeKbDocument`（`kb/store.ts`）按 `targetType` 参数化、表无关、可复用；准入闸常量 `KB_ADMISSION_FLOOR=70`（`src/kb/index.ts`）。
- `targetTypeEnum`（`src/push/targets.ts:20`）= `{event,product,alert,weekly}`，DB 不挡拼写，须先扩枚举再用；push 与 KB 入库共用此枚举。
- `mapRssItem`（`src/collectors/rss.ts`）是同步纯函数、只读 `item.guid`、硬钉 `source:'rss'`/`raw_type:'news'`。

约束：守住所有既有不变量（推送幂等四元组、URL 归一、源内幂等、知识库只入精选、Agent 输出 Zod 校验、外部调用带重试+错误日志、时效性策略）；技术栈 TS（config.yaml）。

## 目标 / 非目标

**目标：**
- 复用 RSS 采集管道接入一批策划 AI 博主 feed（博客/Substack/YouTube 频道 RSS），以 `source='blogger'` + `raw_type='experience'` 两个硬字段确定性标记。
- 有字幕的 YouTube 视频取 transcript 作正文，供经验提炼。
- 经验提炼 Agent 产出结构化经验卡片（含 `long_term_value` 0..100），Zod 校验。
- 经验卡片落 `ai_experiences`（DB 控事实/状态/去重/幂等），高价值（≥70）入 KB，每日「实践锦囊」段内联日报推送。

**非目标：**
- ASR/Whisper；经验内容的 embedding/LLM 语义去重；新推送通道/独立调度；经验类混入新闻 event 日报段；经验链单独熔断告警。

## 决策

**D1 — 经验源用独立 `source='blogger'` + `raw_type='experience'` 两个硬字段，独立 `BLOGGER_FEEDS` env。**
- 隔离必须在 `raw_type` 维度（塌缩按 raw_type 路由，见上）——故经验类必须有**独立 raw_type**。**不复用 `raw_type='post'`**：`post` 已被 Hacker News 占用（`hacker-news.ts:75`）且被塌缩当新闻类纳入。用新 `raw_type='experience'`。
- `source='blogger'` 供 registry 路由/采集子集划分（须扩 `CollectorSource` 联合类型 `types.ts:30-38` + `buildRegistry`，并显式声明 blogger **不**归 `REALTIME_NEWS_SOURCES`/`PRODUCT_SOURCES` 两子集——对齐 `index.ts:160` 的「新增源须显式决定子集归属」前向护栏）。
- `RSS_FEEDS` 解析已是破坏性 env；新增独立 `BLOGGER_FEEDS`（复用 `rssFeedList` Zod transform、同 `URL|vendor`）**零破坏**、语义清晰。
- 标记是程序在配置/采集层确定性写入两个**硬字段**（非 `metadata` 软标记）——下游塌缩路由与经验链选条都靠 `raw_type` 硬筛。

**D2 — YouTube 频道 RSS 复用 `rss-parser`（已原生支持 Atom，无需补 Atom 分支）；`source_item_id` 用 `canonical_url` fallback，仅须覆盖 `source`/`raw_type`。**
- `rss-parser@3.13` 原生归一 Atom：`title`/`link`/`isoDate` 正常填充。**无需补 Atom 分支**（原措辞「不能则补分支」过述，task 改为"验证即可"）。
- `mapRssItem` 只读 `item.guid`，YouTube Atom 的稳定 entry id 落在 `item.id`（`yt:video:<ID>`），但**本设计不读 `item.id`**——`source_item_id` 经既有 fallback 链取 `canonical_url`（watch URL，稳定，源内幂等仍成立）即可。唯一真实改动：blogger 采集路径**不能复用** `mapRssItem` 硬钉的 `source:'rss'`/`raw_type:'news'`，须走独立映射 `mapBloggerItem` 产出 `source:'blogger'`/`raw_type:'experience'`（见 D3 与 source-collectors）。

**D3 — blogger 走独立 collector + `mapBloggerItem`；YouTube 字幕逐条异步增强 + 失败隔离。**
- **隔离命门**：`raw_items.source`/`raw_type` 由 collector 返回的 `item.source`/`item.rawType` 直写（`store.ts:144`，DB 不挡），与 registry 项的 `source` 字段是**两个独立来源**。若 blogger 复用 `mapRssItem`（硬钉 `source:'rss'`/`raw_type:'news'`），会**静默写错** `raw_items.source='rss'`/`raw_type='news'` → 两硬字段隔离全部失效、经验帖被塌进 `ai_news_events`。故 blogger **必须**走独立映射 `mapBloggerItem` 产出 `source:'blogger'`/`raw_type:'experience'`/`collapsed:true`，喂 `env.BLOGGER_FEEDS`。**不变量**：registry 注册的 `source` 字段必须与该 collector 返回的 `item.source` 一致（否则 `raw_items.source` 写错），测试须显式断言 blogger 落库为 `source='blogger'` 而非 `'rss'`。
- **字幕增强**：`mapRssItem`/`mapBloggerItem` 是同步纯函数无网络——取字幕须在采集阶段对 host=youtube.com 的条目**逐条 `await` transcript**（把字幕拉取抽成 blogger collector 内或可注入的「逐条 content 增强 hook」、改采集结构、非零改动）。timedtext 直拉已被收紧，按 ponytail 阶梯选一个小而维护中的库取字幕。
- 字幕拉取是**采集增强非必须**：带重试，单条失败被隔离 → 退化为仅标题+简介落库，绝不中止整批（与"单源失败不拖垮整批"对称）。无字幕同样退化、不 ASR。

**D4 — 经验行入库即 `collapsed=true`（沉淀），经验链按 `canonical_source_url` 反连接选未提炼者。**
- 经验行入库即置 `collapsed=true`（镜像 arXiv 论文「入库即已路由/已沉淀」）→ 天然被新闻/告警塌缩的 `collapsed=false` 过滤排除（**第一道**隔离）；叠加 D-dedup 的类型路由 `IS DISTINCT FROM 'experience'`（**第二道**双保险）。故经验内容绝不进 `ai_news_events`。
- 经验链选条：选 `source='blogger'` AND `raw_type='experience'` AND **`canonical_url IS NOT NULL`** 且其 `canonical_url` 在 `ai_experiences` 中**尚无对应卡片**的 raw_items（按 `canonical_source_url` 反连接）。**两硬字段都进选条谓词**（与 D1 的双字段标记一致；source 不只是 provenance）。
- **批内去重（跨天 + 同批两道，命门）**：反连接只挡**跨天**（DB 已有卡片）的重复——**同一轮批内**两条同 `canonical_url` 的新条目都过反连接 → 都被 SELECT → 都提炼 → 重复调 LLM（`ON CONFLICT (canonical_source_url)` 只兜底写库一行、不防重复 LLM）。故选条 SQL 必须 **`DISTINCT ON (canonical_url)`**（指定确定性代表排序，如 `ORDER BY canonical_url, id`）做**批内**去重，确保跨 feed 同 URL 一轮内**只提炼一次**。
- **`canonical_url` 为空的经验条目（unprocessable 兜底，命门）**：`normalizeUrl(url)` 对无 link/相对/`mailto:`/非 http 链接返回 `null`（`store.ts:114`），故 blogger 条目可能 `canonical_url=NULL`。这类条目**没有去重键**：若不过滤，反连接 `NULL = NULL` 永不匹配 → **每轮重选、无界重复调 LLM**，且写 `ai_experiences(canonical_source_url=NULL)` 撞 `NOT NULL` 抛错。故选条必须 `canonical_url IS NOT NULL` 预过滤，空者**跳过提炼 + 记日志**。**这类行的终态是「永久 `collapsed=true` 的不可处理沉淀」**（占一行、不重扫、不烧 LLM、对称新闻 unprocessable）——**禁止对其加重扫逻辑**，否则会重新引入本可无界重选的 bug。
- `ai_experiences` 去重唯一键 = `canonical_source_url`（经验行的 `raw_items.canonical_url`）+ `ON CONFLICT (canonical_source_url)` 收敛。**纯程序键 + DB 约束，不调 LLM。** 不用 `raw_item_id` 作唯一键：同一 YouTube 视频经不同 feed 会得不同 `source_item_id`（`sha256(feed_url‖guid)`）→ 不同 raw_item，`UNIQUE(raw_item_id)` 拦不住；同 watch URL 的 `canonical_url` 相同，能收敛。`representative_raw_item_id` 存为 provenance（裸 bigint，**对齐既有零 FK 惯例**——既有 `ai_news_events`/`ai_products` 的 representative_raw_item_id 是 nullable 裸 bigint，本表对齐其「零 FK」、但更强地取 `NOT NULL`，因每张卡片必有 provenance raw_item）。
- **经验链幂等三层（崩溃/重入安全）**：① 提炼前反连接预去重（省 LLM，非正确性）；② `ON CONFLICT (canonical_source_url)` DB 兜底（正确性——同 URL 只落一行）；③ blogger 入库即 `collapsed=true`、经验链**不靠 collapsed 翻转**记处理状态（处理状态由「`ai_experiences` 是否有该 URL 卡片」承载）。故「选 → 调 LLM → INSERT」三步**无需事务包 LLM 调用**：崩溃后重选、`ON CONFLICT` 收敛，至多**白烧一次** LLM、不产生重复卡片、不污染数据。搭日报单例锁 + channel-blind 单跑（D6）使稳态无并发；不引入 per-item「提炼中」claim 列（YAGNI，锁内单跑 + ON CONFLICT 已足）。

**D5 — 价值评分并入提炼 Agent 一次结构化调用；闸门复用 `KB_ADMISSION_FLOOR` 常量。**
- 现有 value-judge 输入其实是通用 `{title,content,source}`、非 event-coupled——故"复用受阻"非真因。真正理由：现有架构 score 与 summary 是**分开两次** LLM 调用（无"一次出多产物"先例），经验链选择一次 `generateObject` 同出卡片+评分是**有意偏离**该惯例（经验价值强依赖提炼内容，合并省一次调用），在 design 诚实标注为偏离、非复用。
- 经验卡片只产 `long_term_value`（0..100，Zod `int().min(0).max(100)`，对齐既有 KB Agent 边界）——**不另设 `importance_score`**：实践锦囊段排序直接用 `long_term_value` DESC + `published_at` tiebreaker（省一字段、消 events `numeric(5,2)` 口径分叉）。**单字段双职责取舍**：`long_term_value` 同时作 KB 准入闸与实践锦囊排序键——二者方向一致（越高越好），不像 events 的 `importance_score`(时效) 与 `long_term_value`(沉淀) 正交；接受「recency 窗口内老高分压新中分」（窗口谓词已挡掉真正过期者，经验类不强时效，刻意让长期价值高者优先）。
- `long_term_value` **不加 DB CHECK(0..100)**：有意对齐基线零-CHECK 惯例（全库 `*_score` 均无 CHECK），0..100 边界唯一防线是提炼 Agent 的 Zod `int().min(0).max(100)`（合规于「Agent 输出必 Zod 校验」不变量）；落地须确保该列**只**经 Zod 校验后的 Agent 输出写入、无第二写入路径。
- `>=70` 入库闸由**程序**判定，**复用同一个 `KB_ADMISSION_FLOOR` 常量**（不复制 70）。但基线 `KB_ADMISSION_FLOOR=70` 现为 `kb/index.ts:45` 的**模块私有 const、未 export**——经验链两处用到 ≥70（KB 准入候选 + 实践锦囊推送候选）。故落地**必须先把 `KB_ADMISSION_FLOOR` 提为可导出符号**（或迁入共享常量模块），经验链两处 + 事件链共同 `import` 同一处，**禁止任一处写字面量 70**（否则违背 spec 自立的「单一 70」不变量、埋「改 KB 闸为 75 但推送仍 70」的口径分裂）。
- 经验入 KB 用 `ai_experiences` 已带的 `long_term_value`，**跳过** KB Agent 重算（否则双评分双 LLM + 口径分裂）——但既有 `runKbIngestion` 循环硬编码每条必调 `generateKbMetadata`（KB Agent），故经验入 KB **不走 `runKbIngestion`**，须新写独立编排（见 D6 末）。

**D6 — 实践锦囊段内联 `runDailyWorkflow`、搭日报单例锁，不独立调度。**
- product 段已从独立调度退化为日报内联段（`product-digest.ts:1-11`）——"镜像 product-digest"的正确结论是**内联日报、搭 `daily-digest:{push_date}` 锁便车**，不新增 queue/cron/独立锁（逆架构演进方向才会重新引入已删除的模式）。
- **内联位置（命门：纯经验日漏推）**：`runDailyWorkflow` 在「新闻 Top-N 空 ∧ 全 channel 产品候选空」时**早退 `return 'skipped-no-candidates'`**（`run-daily-workflow.ts:653-672`，在 KB 阶段之前）。product 段刻意放在**早退判断之前**。故经验段**必须同样放在早退之前**，且**早退判空条件须扩为「新闻空 ∧ 全 channel 产品空 ∧ 全 channel 经验空」三者皆空才早退**——否则「纯经验日」（无新闻无产品但有高价值经验）会被早退静默跳过、经验永不推送。
- **三段顺序钉死（channel-blind 单跑 → KB 沉淀 → 早退判空 → per-channel 推送）**，镜像产品段阶段 5.5→6 的真实顺序：① `runExperienceMiningOnce`（channel-blind：提炼 + 写 `ai_experiences`，**每批只跑一次**，在 per-channel 候选之前）；② `runExperienceKbIngestion`（channel-blind：≥70 卡片沉淀 KB，见下，**与提炼同侧、在早退之前**）；③ per-channel 推送候选展开（`selectExperiencesForChannel`）；④ 三元早退判空读展开后的经验候选 Map。提炼在判空**上游**（无循环依赖）；提炼/塌缩/KB 沉淀都失败隔离、永不向上抛（不拖垮日报）。
- 推送候选 = `ai_experiences.long_term_value >= KB_ADMISSION_FLOOR`（**引用导出常量、不写字面量 70**，与 KB 准入同源）且 `published_at` 在 recency 窗口内 且「该卡片从未以该 channel `success`」（`NOT EXISTS(push_records...)` anti-join，两侧 `target_id`/`id` 均 `varchar(128)` 类型相容，跨天不重推）。`target_type='experience'`、`target_id=经验卡片主键`、`push_date` 取 Asia/Shanghai（与日报同源）。时效性靠 `published_at` 窗口谓词保证不回推旧经验（policy-push-timeliness）。该 anti-join + `published_at` 窗口 + `long_term_value DESC` 排序均**全表顺序扫**（对齐基线零二级索引惯例，数据量小可接受，**勿顺手加索引**破坏惯例；未来慢了再单独 forward-only 迁移加）。
- **KB 沉淀独立编排 `runExperienceKbIngestion`（不走 `runKbIngestion`，且必在早退之前）**：既有 `runKbIngestion`（`kb/index.ts:173`）循环硬编码每条候选必调 `generateKbMetadata`（KB Agent）+ embedding，对经验卡片既违反「跳过重算」又因输入形状不符降级；且既有 event KB 阶段在 `run-daily-workflow.ts:755`、**早退 return 之后**。**KB stranding 命门**：经验入 KB「不以已推送为前提」，但若把经验 KB 沉淀放在早退之后（如并列 event KB 阶段），则「新闻空 ∧ 产品空 ∧ 推送候选空（如 ≥70 卡片昨天已推、push anti-join=0）但今天有新 ≥70 卡片」时，三元早退仍触发 → KB 沉淀被跳过 → **违反「≥70 全入 KB 不被推送名额限」不变量**（push-empty 与 KB-empty 是不同集合）。故 `runExperienceKbIngestion` **必须在 channel-blind 单跑步骤内、早退判断之前执行**（②，紧跟提炼）。
- **`KbStoreItem` 完整字段映射（10 字段全必填，逐一钉死）**：`targetType = TARGET_TYPE.experience`、**`targetId = ai_experiences.id`**（与推送侧 `target_id` 同源同口径——同一卡片在 push 幂等命名空间与 KB 幂等命名空间用同一 target_id；是 KB claim CAS 目标身份、写入 `kb_ingestion_records.target_id`〔幂等键第二元〕与 `kb_documents.target_id`〔NOT NULL〕，漏则 tsc 失败 + 幂等键无锚）、`kbTitle = headline_zh ?? scenario`（回退防空）、`summaryZh = summary_zh`、`tags = tools`（卡片 `tools` 数组，空则 `[]`——卡片**无独立 tags 字段**）、`entities = []`、`sourceUrls = [canonical_source_url]`（**有意 canonical-only**：经验表不存原始 `raw_items.url`，canonical URL 已是去 utm 后可点击的有效来源、满足 RAG 可回链；与 event 路径 `[canonical, raw]` 不对称是刻意的）、`eventDate = published_at ? getPushDate(published_at) : 当日 pushDate`（**镜像 `deriveEventDate`（kb/index.ts:157）的 NULL 回退**——`published_at` 可空而 `KbStoreItem.eventDate` 是非空 string，绝不写 NULL/undefined 进 `kb_documents.event_date` date 列）、`longTermValue = 卡片 long_term_value`、`embedding = null`。`kbProvider`（`'custom'`）**不是 `KbStoreItem` 字段，经 `storeKbDocument` 的 options 传入**（store.ts:146-151）。复用 `storeKbDocument` 原语 + `kb_ingestion_records` 幂等，只复用**原语**不复用 event 版**编排**；统计自有形状（不复用 event 版 `KbIngestionResult` 的 `agentOk/agentFailed` KB-Agent 维度字段——经验链不调 KB Agent）。
- **`published_at` 为 NULL 的经验卡片**：仍入 KB（`eventDate` 回退当日），但**不进实践锦囊推送候选**——推送 recency 窗口 `gte/lte` 对 NULL 求假（对齐 `top-n.ts:255-260`），经验链无 published-at-inference，**刻意接受 date-less 高价值卡片 KB-only**（经验类不强时效）。

**D7 — forward-only 迁移建 `ai_experiences`；platform-foundation 扩 target_type + 表集。**
- 列：`id varchar(128) PK DEFAULT gen_random_uuid()::text`（与 event_id/product_id 同口径，供 target_id 互引）、`canonical_source_url text NOT NULL UNIQUE`（去重键）、`representative_raw_item_id bigint NOT NULL`（provenance，裸 bigint 无 FK，对齐基线）、`scenario text`、`tools jsonb`、`techniques text`、`applicability text`、`long_term_value integer NOT NULL`、`headline_zh text`、`summary_zh text`、`published_at timestamptz`（recency 窗口，从 raw_items 取）、`created_at timestamptz`。**无向量列、无二级索引**（对齐基线惯例；数据量小，排序顺序扫足够，未来慢了再单独迁移加索引）。
- 迁移 forward-only（追加序号、不重写既有 0000–0006），幂等口径 = 经 `npm run migrate`（drizzle journal 跳过已应用项），**非** SQL 文件自身可重入（与 0006 注释口径一致）。
- `target_type='experience'` 须扩 `targetTypeEnum` + `TARGET_TYPE` 常量（platform-foundation 权威全集需同步 MODIFIED）；该枚举 push 与 KB 入库共用，一处改两处生效。

## 风险 / 权衡

- **YouTube transcript 脆弱（反爬/无官方接口）** → 字幕拉取失败隔离 + 退化为标题+简介 + 库可替换；字幕覆盖不足是已知，ASR 留后续。覆盖率不达预期时，价值闸门会自然过滤掉只剩标题简介的低信息条目（≥70 难达标）。
- **长文本 token 爆** → 提炼前按 `EXPERIENCE_TEXT_MAX_CHARS` 截断（镜像 `EMBEDDING_TEXT_MAX_CHARS`，env 校验非法值启动报错）。
- **经验提炼 prompt 质量经验性** → schema 强约束兜底（缺字段/越界重试/降级），prompt 留迭代回合。
- **博主 feed 质量参差/资讯类混入** → `long_term_value≥70` 价值闸门把关；feeds.md 已按"实战 vs 资讯"建议拆分入 `BLOGGER_FEEDS` vs `RSS_FEEDS`，减少白烧 LLM。
- **评分与提炼耦合（D5）** → 接受：v1 省调用、独立单链无并发评分问题；若后续要独立调权再抽分离评分。
- **`collapsed` 全局布尔承载 per-chain 处理状态** → 三链（news/product/experience）按 `raw_type` 切片互斥、共享 `collapsed` 仅作幂等标记，安全；但须固化前向护栏「新增任何 `raw_type` 必须显式声明它属哪条塌缩链」（写进 dedup spec 与 schema 注释），否则第四条链会重踩本次的坑。
- **经验链失败无熔断** → 本期仅记错误日志（低量级）；失败规模可观测留 Open Question，不本期加（避免 scope creep）。
- **新闻真空熔断分母不被经验污染**（自动收口，记录）：`circuit-breaker` 的 `newsProcessableCount`（`run-daily-workflow.ts:331`）= `collapseUncollapsedRawItems` 的 `!unprocessable` 计数；经验行经查询层 `IS DISTINCT FROM 'experience'` 排除后**不进 collapse pending 集**，故天然不计入新闻真空告警分母，无需额外改熔断逻辑。

## Open Questions

- transcript 库最终选型（`youtube-transcript` vs `youtubei.js`）——落地时按体积/维护活跃度定。
- 经验链失败规模是否需独立告警（参照 product-digest 的 failure-rate 告警）——本期不做，量级上来再评估。
- `published_at` recency 窗口的具体天数——落地时与日报 recency 口径对齐后定。
