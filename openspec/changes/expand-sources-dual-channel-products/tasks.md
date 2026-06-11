# tasks

> 按四里程碑组织（design D7）：M1 扩源 → M2 双通道 → M3 产品发现 → M4 告警/周报。每个里程碑可独立交付并补不变量测试；apply 可在里程碑边界停。横切不变量（沿用 P1）：Agent 输出 Zod 校验失败重试/降级；外部调用带重试+错误日志；推送先 pending→调 API→success/failed 唯一键冲突即跳过；每段补对应不变量测试。

## 1. M1 — 采集器 registry 重构

- [x] 1.1 把 `CollectorSource` 扩为含 `arxiv` 与 `product_hunt`，将 `collectAllSources`（src/collectors/index.ts）改为数组驱动 registry：`Array<{ source, collect(opts) }>`，用 `Promise.allSettled(registry.map(...))` 并发、按 source 聚合 `perSource`（spec source-collectors「registry 注册即接入新源」）
- [x] 1.2 迁移现有 RSS/HN/GitHub 三 collector 为 registry 条目，保持单源失败隔离不拖垮整批
- [x] 1.3 补测试：registry 新增一源后被并发调用、单源失败隔离仍成立（不触网，注入桩）

## 2. M1 — RSS vendor provenance

- [x] 2.1 将 `RSS_FEEDS` env 由「URL 逗号列表」升级为带 vendor 的 feed 配置（`url|vendor` 分隔形式），env 解析为 `{url, vendor}[]`；遇旧纯 URL 格式（无 `|vendor`）启动即快速失败并提示新格式，禁止静默把 vendor 置空（src/config/env.ts）
- [x] 2.2 `mapRssItem`（src/collectors/rss.ts）增 vendor 入参，写入 `metadata.vendor`（未配 vendor 的 feed 取 null、不报错）+ `metadata.feed_url`；`source` 保持 `rss`；RSS `source_item_id` 改为按 feed 命名空间化 `sha256(feed_url ‖ '\0' ‖ guid)`（防跨 feed 同 guid 误去重），guid 缺失仍走 canonical_url → 内容哈希
- [x] 2.3 `.env.example` 填入 T1 大厂 feed：OpenAI `openai.com/news/rss.xml`、DeepMind `deepmind.google/blog/rss.xml`、Hugging Face `huggingface.co/blog/feed.xml`，各带 vendor 标记
- [x] 2.4 补测试：大厂 feed 条目带 vendor 入 metadata；不同 feed 相同 guid 命名空间化后不冲突各自入库；未配 vendor 取 null 不阻塞；旧纯 URL 格式启动即报错

## 3. M1 — arXiv 采集器

- [x] 3.1 新增 src/collectors/arxiv.ts：走 OAI-PMH 增量元数据接口（游标 at-least-once：上次 harvest 时间戳**在条目成功入库后才推进**，防崩溃漏窗），解析为统一 `CollectedItem`（rawType 标 paper），`source='arxiv'`，source_item_id 用稳定 arXiv id。**P2 论文仅采集落 raw_items 作沉淀，不进事件塌缩/日报/推送**。落点：`CollectedItem` 增可选 `collapsed?: boolean`、store 透传（默认 false），arXiv collector 置 `collapsed=true`（入库即标已沉淀，避免每轮重扫）
- [x] 3.2 实现单采集进程内串行节流闸：arXiv 请求 ≥3s 间隔、单连接；429 走指数退避（复用 withRetry，baseDelay 调大）且有重试上限，超限本轮放弃记 error、不无界 pending；鉴权错误 401/403 不重试直接隔离；声明单实例采集假设（不做跨 worker 分布式节流）
- [x] 3.3 注册 arXiv 进 collector registry；确认单源失败（429/超时/放弃/鉴权）被 allSettled 隔离、不触发「全部源返回 0」告警
- [x] 3.4 补测试：节流间隔 ≥3s 串行、429 退避重试 + 达上限放弃、401/403 不重试、游标入库后才推进、稳定 id 源内幂等（注入桩，不触网）
- [x] 3.5 事件塌缩（src/dedup/collapse.ts，collapse → ai_news_events）查询层加 `raw_type` 过滤：`WHERE ... AND raw_type IS DISTINCT FROM 'product' AND raw_type IS DISTINCT FROM 'paper'`（用 IS DISTINCT FROM 使 NULL 视作新闻、保 P1 行为），防 PH 产品/arXiv 论文污染新闻事件流或双重消费；arXiv 论文行入库即置 `collapsed=true`（仅沉淀无下游消费、避免每轮重扫）；补测试「product/paper 不产生 ai_news_events」「paper 行不被每轮重扫」

## 4. M2 — dispatcher channel 参数化

- [x] 4.1 把 `dispatcher.ts` 的 `CHANNEL='telegram'` 常量改为参数（channel 由调用方传入幂等四元组）；待发集合 success 排除按 channel 限定（spec telegram-push MODIFIED）
- [x] 4.2 新增程序集中定义的枚举常量（Zod enum）：`target_type = {event,product,alert,weekly}`、`channel = {telegram,feishu}`（本期权威全集，不含 paper/repo），各推送路径统一引用、禁止散落字面量（spec platform-foundation 枚举收口）；可选为 push_records 加 CHECK 约束
- [x] 4.3 候选窗口（selection/top-n 或候选查询）改为按目标 channel 分别判定「从未以该 channel success」，使同一事件可分别进入 telegram 与 feishu 候选（spec daily-intel-pipeline「Top N 组合分选择」MODIFIED）
- [x] 4.4 抽 message.ts 为「选 Top N 渲染数据」+「按 channel 渲染」两层；保留 Telegram MarkdownV2 渲染与渲染期截断逻辑不变
- [x] 4.5 补测试：同事件不同 channel 各自独立幂等（telegram 已 success 不抑制 feishu 待发）；telegram 已 success 的事件仍进入 feishu 候选窗口（跨天维度）；channel 参数化后既有 Telegram 幂等不变量仍绿

## 5. M2 — 飞书通道

- [x] 5.1 新增飞书 env：`FEISHU_WEBHOOK_URL` / `FEISHU_SIGN_SECRET`（src/config/env.ts + .env.example）。**飞书可选**：两者均缺 → 飞书 disabled、不纳入「已配置通道」集、纯 Telegram 部署照常启动；仅配其一（不完整）→ 快速失败；两者全配 → enabled
- [x] 5.2 实现 FeishuSender（原生 fetch + 签名）+ 飞书 JSON 卡片渲染（按钮/文字链跳转，不依赖回调）；带重试+错误日志
- [x] 5.3 `runDailyWorkflow` 扩为向所有已配置通道分发；单通道发送失败隔离不拖垮另一通道（spec daily-intel-pipeline MODIFIED）
- [x] 5.4 多通道并发分发（Promise.allSettled）；单例锁 `daily-digest:{push_date}` TTL 上调到覆盖「采集+判断+摘要+两通道并发分发」最坏时长（spec telegram-push「日报任务全局单例」MODIFIED）
- [x] 5.5 每日 cron 默认值避整点/半点（如 08:03），降低飞书 11232 限流（.env.example DAILY_DIGEST_CRON 默认）
- [x] 5.6 补测试：飞书卡片渲染、飞书 channel 幂等（channel='feishu'）、单通道失败隔离；纯 Telegram（未配飞书）部署照常启动
- [x] 5.7 更新降级熔断（src/pipeline/circuit-breaker.ts）：全失败告警分母改 registry 全部源、**新闻类可处理条目**（排除 raw_type product/paper，熔断用分母改名 `newsProcessableCount` 或加注与 store 通用 `processableCount` 区分语义）、分发失败不计入 judge/摘要熔断分母、仅日报链套用（高频告警链不套用）；补测试「仅 arXiv 返回 paper、新闻源全空 → 仍按新闻真空告警」

## 6. M3 — ai_products 表与迁移

- [x] 6.1 Drizzle 定义 `ai_products`（src/db/schema.ts）：`product_id VARCHAR(128) PRIMARY KEY DEFAULT gen_random_uuid()::text` + **`name VARCHAR(255) NOT NULL`（QA §8.3）** + `UNIQUE(canonical_domain)` / `UNIQUE(github_repo)` / `UNIQUE(product_hunt_slug)` + **`first_seen_at`/`last_seen_at`/`last_pushed_at`（本期必建，UPDATE 累加目标）** + **`metadata JSONB`（本期必建，merge_conflict 标记落点）** + `representative_raw_item_id BIGINT`（独立列，回指 raw_items.id）；放宽 schema.ts 注释的「禁止 ai_products」限制（其余五表仍禁）。其余 §8.3 富化列（vendor/category/score 等）可留空/留 P5
- [x] 6.1b 为 `ai_news_events` 新增 `judge_claimed_at TIMESTAMPTZ`（可空）列（forward-only 迁移），承载并发评分原子 claim（日报链 + 实时告警高频链防双评分，见 9.1/降级容错）
- [x] 6.2 生成 forward-only 迁移（追加新序号，不重写既有 0000–0003，不 drop 上线表）；无 vector 列
- [x] 6.3 补测试：迁移落表 + 三唯一约束就位；迁移幂等可重跑；不含向量列（spec platform-foundation「ai_products 产品表可迁移」）

## 7. M3 — Product Hunt 采集与硬合并

- [x] 7.1 新增 env `PRODUCT_HUNT_TOKEN`（Developer Token 只读）+ .env.example；缺失快速失败
- [x] 7.2 新增 Product Hunt 采集器（注册进 registry）：GraphQL 拉当日上榜，**先落 `raw_items`**（`source='product_hunt'`、`raw_type='product'`，PH 产品名写入 `title` 满足 NOT NULL、缺失兜底 slug/domain，PH 原始 payload 入 metadata）；读 `X-Rate-Limit-Remaining`/`Reset` 头，余量耗尽退避；带重试+错误日志
- [x] 7.3 实现确定性产品塌缩步骤：读 `raw_items(raw_type='product' AND collapsed=false)` 写 `ai_products`，塌缩成功后置该 raw_item `collapsed=true`（避免每轮无界重塌）；事务内对**全部非空归一键各 `SELECT ... FOR UPDATE`**（按命中 product_id 升序加锁防死锁，不按优先级短路）收集命中 product_id 集合，据 size 分流：0→INSERT / 1→UPDATE（不覆盖 product_id、记 representative_raw_item_id）/ >1→冲突分支；**INSERT 必填 `name`（取 raw_item.title，缺失兜底 slug/domain，绝不留空）**；NULL 键不参与约束；canonical_domain 由 URL 规范化纯函数提取、github_repo 归一 owner/name；产品塌缩由单实例承载；推送候选查询在塌缩后执行（merge_conflict 标记可见）
- [x] 7.4 实现多键命中多行冲突处置：事务内收集各键命中 product_id 集合，size>1 即在各行 metadata 标记 `merge_conflict`+告警、不静默择一 upsert、不留孤儿行；同冲突组下轮再命中只更新不重复告警（跨行合并留 P3）
- [x] 7.5 补测试：同产品经任一稳定键塌缩为单行 product_id 不变；首次 INSERT 填非空 name（缺名兜底）；多键命中多行记冲突告警不静默择一且不重复刷；NULL 键不放行多行；合并全程无 LLM 调用（spec product-discovery 硬合并）

## 8. M3 — 每日产品发现推送

- [x] 8.1 程序规则选当日推送产品（非 LLM 定名单），候选含「该 product_id 从未以该 channel success 推过」跨天不重推窗口（防 last_seen 刷新致天天重推）+ **排除 `merge_conflict` 标记的产品**（防同产品散多行各推一次）；复用 dispatcher 同一状态机经多通道推送，`target_type='product'`、`target_id=product_id`；带独立单例锁 `product-digest:{channel}:{push_date}`（job 级 + TTL/finally 释放）
- [x] 8.2 补测试：同天同产品同通道不重复推（UNIQUE 冲突跳过）；已推过产品跨天不再重推（候选窗口）；冲突态产品排除出候选；产品推送与事件日报 target_type 不同互不挤占

## 9. M4 — 实时重大发布告警

- [x] 9.1 实现高频告警工作流（独立 BullMQ 调度入口，频率 env 默认 15–30min，不嵌 runDailyWorkflow）：采集**只跑实时新闻源 {rss,hacker_news,github}**（排除 arXiv 非实时、PH 配额受限）→ 塌缩 → 对未评分事件评分 → **评分后**判 `importance_score IS NOT NULL AND >= 85` 阈值（env 可配），非 LLM 决定；高频链路全源 0/空轮不套用日报「全源 0」告警（防刷屏）
- [x] 9.1b Value Judge 评分加并发原子 claim（日报链 + 告警链共用）：送 LLM 前 `UPDATE ai_news_events SET judge_claimed_at=now() WHERE event_id=? AND *_score IS NULL AND (judge_claimed_at IS NULL OR judge_claimed_at < now()-interval 'T') RETURNING`（或 FOR UPDATE SKIP LOCKED），仅 claim 成功者评分；**单条 LLM 调用设硬超时 `L`（如 LLM_TIMEOUT_MS），写分提交延迟上界 `W`，回收阈值 `T > L + W`**（或写分与 claim 释放同事务原子完成使在途总时长恒 <L+W<T）——保证正在评分/写分的事件（总时长 <L+W）不被误回收、僵尸 claim 经 T 回收；补测试「两链路并发只评一次不覆写」「claim 后崩溃经 T 重评」「评分+写分总时长逼近 L+W 不被误回收」
- [x] 9.2 告警推送复用 dispatcher 同一状态机（含 headline 缺失回退链，告警事件可能无摘要），四元组 `target_type='alert'`、`target_id=event_id`、`push_date=触发当日(Asia/Shanghai)`；候选含「该 event_id 从未以该 channel success 告警过」一生一次去重；带独立单例锁 `alert:{channel}:{event_id}`（job 级 + TTL/finally 释放，锁键无时间故释放不可省）
- [x] 9.3 补测试：高频链路评分后达阈值即告警（不等日报）；评分前不以 NULL 误判；日报已推同一事件仍可发 alert（不被 event 四元组吞）；已告警过事件不重复告警（一生一次）；同日并发 UNIQUE 兜底；低于阈值不触发；告警事件无摘要时 headline 回退不报错

## 10. M4 — 周报

- [x] 10.1 实现周级 cron 周报任务（独立调度）：程序规则从过去一周窗口选高价值事件/产品，复用已落库 summary_zh/headline_zh 不重复触发 LLM
- [x] 10.2 周报推送复用 dispatcher 同一状态机，四元组 `target_type='weekly'`、`target_id=iso_week`、`push_date=该 ISO 周周一(Asia/Shanghai)`；**iso_week 与 push_date 同源锚定「被汇总窗口 [上周一,本周一)」对应的 ISO 周，不取触发时刻所在周**（防跨周边界抖动错配）；带独立单例锁 `weekly:{channel}:{iso_week}`（job 级 + TTL/finally 释放）；触发时刻避整点；补测试「同一 ISO 周内抖动触发不改变 target_id/push_date」（跨 ISO 周边界触发本属不同周、锚定不同 iso_week 为有意正确行为）
- [x] 10.3 补测试：同周周报不重复推（UNIQUE 冲突跳过）；周报与日报 target_type 不同互不挤占

## 11. 收尾验证

- [x] 11.1 全量 vitest 绿（含 M1–M4 新增不变量测试）；CI 起真实 pg(pgvector)+redis service container，**存在 skip 即判失败**（不变量测试不得静默跳过）
- [x] 11.2 `docker compose up -d` + `npm run migrate` 两次重跑验证迁移幂等（含 ai_products forward-only）
- [ ] 11.3 一次性鉴权/配额勘验（非可复现验收，结果作 artifact 附 PR）：PH Developer Token 拉一次 + 打印剩余复杂度点、arXiv OAI-PMH 拉一次确认 ≥3s 不被 429、飞书 webhook 发一条测试卡片。注：持续限流行为靠线上观测，节流退避逻辑由 3.4/7.x 单测（注入桩）覆盖
- [x] 11.4 更新 ROADMAP P2 退出标准达成表（仿 P1 格式，标证据与测试文件）
