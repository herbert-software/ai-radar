## 1. 数据模型与配置（M1）

- [x] 1.1 在 `src/db/schema.ts` 定义 `ai_experiences` 表：`id varchar(128)` PK `default gen_random_uuid()::text`、`canonical_source_url text NOT NULL` + `UNIQUE(canonical_source_url)`、`representative_raw_item_id bigint NOT NULL`（裸 bigint 无 FK）、`scenario text`、`tools jsonb`、`techniques text`、`applicability text`、`long_term_value integer NOT NULL`、`headline_zh text`、`summary_zh text`、`published_at timestamptz`、`created_at timestamptz`；**无向量列、无二级索引**
- [x] 1.2 生成 forward-only 迁移 `drizzle/0007_*_ai_experiences.sql`（`drizzle-kit generate`），含表 + `UNIQUE(canonical_source_url)`；幂等口径 = 经 `npm run migrate`（drizzle journal 跳过已应用项，**非** SQL 文件自身可重入，与 0006 注释口径一致），连续两次 `npm run migrate` 验证幂等
- [x] 1.3 在 `src/config/env.ts` 新增 `BLOGGER_FEEDS`（复用 `rssFeedList` 的 `URL|vendor` 解析），空值 → 空数组；新增 `EXPERIENCE_TEXT_MAX_CHARS`（整数，镜像 `EMBEDDING_TEXT_MAX_CHARS`，非法值启动报错）；补 env 解析单测
- [x] 1.4 迁移落表不变量测试：`ai_experiences` 落表 + `id` 为 `varchar(128)`/`gen_random_uuid()::text`（与 `push_records.target_id` 类型相容）+ `UNIQUE(canonical_source_url)` 生效（重复 URL 第二行被 ON CONFLICT 收敛 / NOT NULL 拒空）+ `representative_raw_item_id` 裸 bigint 无 FK + 无向量列 + 迁移幂等
- [x] 1.5 **前置：扩 `targetTypeEnum` + `TARGET_TYPE` 常量加 `'experience'`**（`src/push/targets.ts`）——push 与 KB 入库共用此枚举，须先落否则 M3/M4 用 `target_type='experience'` 会 tsc 失败（`TargetType` 联合不含 `'experience'`）

## 2. 采集接入：博主 feed + YouTube 字幕（M2）

- [x] 2.1 扩 `src/collectors/types.ts` 的 `CollectorSource` 联合类型加 `'blogger'`；registry（`src/collectors/index.ts`）注册 blogger collector（消费 `BLOGGER_FEEDS`）；**显式声明 blogger 不归 `REALTIME_NEWS_SOURCES`/`PRODUCT_SOURCES` 两子集**（对齐既有子集护栏）
- [x] 2.2 blogger 采集走**独立映射 `mapBloggerItem`** 产出 `source='blogger'`、`raw_type='experience'`、`collapsed=true`（**绝不复用** `mapRssItem` 硬钉的 `source:'rss'`/`raw_type:'news'`，否则静默写错 source 致隔离失效），feed 取自 `env.BLOGGER_FEEDS`；YouTube Atom 由 `rss-parser` 原生解析（**仅验证、预期可解，无需补 Atom 分支**），`source_item_id` 走既有 fallback 链取 `canonical_url`
- [x] 2.3 YouTube 字幕取正文：改 `collectRss` 支持对 host=youtube.com 条目**逐条 await** 拉字幕（轻量 transcript 库或 timedtext）作 `content`，带重试 + 错误日志；无字幕 → 仅标题+简介，不 ASR
- [x] 2.4 字幕拉取失败隔离：单条取字幕失败退化为仅标题+简介落库，不中止整批（与单源失败隔离对称）
- [x] 2.5 采集测试：博主 feed 注册即接入 + blogger 不在两子集 + **落库 `source='blogger'`/`raw_type='experience'`（非经 mapRssItem 误写为 'rss'/'news'）** + collapsed=true 确定性写入 + 有字幕取 transcript / 无字幕退化 / 取字幕失败隔离（注入桩不触网）

## 3. 经验提炼 Agent（M3）

- [x] 3.1 定义经验卡片 Zod schema（scenario / `tools: string[]`（与 KbStoreItem.tags 形状相容；存 jsonb，读回需运行期收敛为 string[]）/ techniques / applicability / `long_term_value: int().min(0).max(100)` / headline_zh / summary_zh）。**不含 `source_url`**——来源 URL 是确定性的 `canonical_source_url`（来自 raw_items.canonical_url，归一去 utm），不由 LLM 产出（对齐「确定性状态不交 LLM」）
- [x] 3.2 实现经验提炼 Agent（Vercel AI SDK `generateObject`），一次调用产出卡片 + `long_term_value`；提炼前按 `EXPERIENCE_TEXT_MAX_CHARS` 截断输入；带重试，校验失败/评分越界按降级处理 + 错误日志
- [x] 3.3 Agent 测试：合规 JSON 通过校验落库 / 缺字段或 long_term_value 越界重试后仍不合规则降级不写脏数据（注入 mock LLM，不真调）

## 4. 经验链编排 + 塌缩路由排除（M4）

- [x] 4.1 改 `src/dedup/collapse.ts` 的 `collapseUncollapsedRawItems` 查询层排除集，加 `raw_type IS DISTINCT FROM 'experience'`（一处覆盖日报 + 告警两条链）；补测试证经验行不被事件塌缩选入
- [x] 4.2 经验链选条：`source='blogger'` AND `raw_type='experience'` AND **`canonical_url IS NOT NULL`** AND 按 `canonical_source_url` 反连接 `ai_experiences` 尚无对应卡片，且 **`DISTINCT ON (canonical_url)`（`ORDER BY canonical_url, id`）批内去重**（跨 feed 同 URL 一轮只提炼一次）；`canonical_url` 为空者跳过 + 记日志、终态永久 collapsed sink（禁加重扫）
- [x] 4.3 写 `ai_experiences`：`ON CONFLICT (canonical_source_url) DO ...` 收敛，去重纯程序键 + DB 约束；`published_at` 取自 raw_items。幂等三层：反连接预去重 → ON CONFLICT 兜底 → collapsed=true 不靠提炼翻转（崩溃重选安全，无需事务包 LLM）
- [x] 4.4 KB_ADMISSION_FLOOR 提为可导出符号（从 `kb/index.ts` 私有 const → 导出/共享常量模块）；新写**独立编排 `runExperienceKbIngestion`**（**不走 `runKbIngestion`**，**且在 runDailyWorkflow 无候选早退之前、channel-blind 单跑步骤内执行**，防 KB stranding）：经验候选 SELECT（`long_term_value >= KB_ADMISSION_FLOOR`、`target_type='experience'`、不要求已推送）→ 组**完整 `KbStoreItem`（10 字段）**（`targetType=TARGET_TYPE.experience`、`targetId=ai_experiences.id`（与推送侧同源）、`kbTitle=headline_zh ?? scenario`、`summaryZh=summary_zh`、`tags=tools`(空[])、`entities=[]`、`sourceUrls=[canonical_source_url]`、`eventDate=published_at ? getPushDate(published_at) : 当日pushDate`、`longTermValue=卡片值`、`embedding=null`）→ `storeKbDocument`（`kbProvider='custom'` 经 options 传入、非 item 字段）+ `kb_ingestion_records` 幂等，**跳过 KB 摘要 Agent 重算**，失败隔离不向上抛
- [x] 4.5 编排测试：经验类被路由不进 events / 新闻类不误入 / 跨 feed 同 URL 不产生重复卡片 / **同批同 URL 只调一次 LLM** / 高价值入库低价值不入 / 经验入库不要求已推送 / **纯经验-全已推日（无新闻无产品无 push 候选但有新 ≥70 卡片）仍入 KB、不被早退跳过** / `published_at` 为空卡片入 KB（eventDate 回退）但不进推送候选（注入 mock）

## 5. 实践锦囊推送段（M5，内联日报）

- [x] 5.1 接线 Push Dispatcher 处理 `target_type='experience'`（枚举本身已在 1.5 前置扩好）：dispatcher channel 参数化 + 幂等四元组对 experience 生效
- [x] 5.2 实践锦囊段**内联 `runDailyWorkflow`、搭日报单例锁 `daily-digest:{push_date}`**（不新增 queue/cron/独立锁），置于**阶段6「无候选早退」之前**（与 product 段同侧），并**把早退判空条件扩为「新闻空 ∧ 全产品空 ∧ 全经验空」三者皆空**（防纯经验日漏推）；提炼/塌缩为 channel-blind、每批只跑一次再按 channel 展开候选（镜像 product 段）、失败隔离永不向上抛；候选 = `long_term_value >= KB_ADMISSION_FLOOR`（**引用导出常量、不写字面量 70**）且 `published_at` 在 recency 窗口内 且「该卡片从未以该 channel success」，按 `long_term_value DESC, published_at` 取 Top N
- [x] 5.3 推送测试：同日同卡片同通道不重复推（UNIQUE 兜底）/ 跨天不重推 / 上线不批量回推窗口外旧经验（published_at 窗口）/ channel-blind 只提炼一次 / **纯经验日（无新闻无产品）仍推经验、不被早退跳过** / 与 event/product/alert/weekly 的 target_type 不挤占

## 6. 策划 feed 清单与收尾验证（M6）

- [x] 6.1 把 `feeds.md` 的策划 AI 博主 feed 清单写进 `.env.example`（`BLOGGER_FEEDS` 注释示例，实战子集）+ 文档；资讯类源按 feeds.md 建议归 `RSS_FEEDS` 或暂不接
- [x] 6.2 全量验证：`npx tsc --noEmit` 0 错、`npm run lint` 0 错、全量 vitest 全绿 0 skip（连真实 pg+redis）；迁移两次 `npm run migrate` 幂等
- [x] 6.3 真实凭据/外网勘验项交付用户本地执行（拉一次有字幕 YouTube transcript + 拉一个 Substack/博客 feed + 实践锦囊发一条测试卡片），结果作 artifact 附 PR
