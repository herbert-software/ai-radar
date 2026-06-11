## 1. 配置与依赖

- [x] 1.1 在 `.env.example` / env schema 新增：Telegram bot token、目标 chat id、`PUSH_TIMEZONE`（默认 Asia/Shanghai）、`TOP_N`、组合分权重（importance/developer_relevance/novelty/hype_risk）、`IMPORTANCE_FLOOR`、`DEGRADE_ABORT_RATIO`（默认 0.5）、`FIRST_SEEN_WINDOW_DAYS`、RSS 源清单、GitHub token
- [x] 1.2 安装依赖：grammY、RSS 解析库（如 `rss-parser`）、确认 BullMQ 已在依赖中；docker-compose 的 Redis 可连通
- [x] 1.3 env 校验扩展：新增关键变量缺失时按既有 `parseEnv` 快速失败（启动即报错），补单测

## 2. 数据库 Schema 迁移（platform-foundation MODIFIED）

- [x] 2.1 改 `ai_news_events.event_id` 为不透明 surrogate key：保留 `VARCHAR(128)` 列类型（与 `push_records.target_id` 一致）、设默认值 `gen_random_uuid()::text`，不由内容派生
- [x] 2.2 `ai_news_events` 新增 `dedup_key` 列 + `UNIQUE(dedup_key)`、新增 `representative_raw_item_id`、新增 `published_at`（可空，供 Top N tiebreaker）
- [x] 2.3 `raw_items` 新增 `title_hash` 列、新增 `unprocessable`（`BOOLEAN NOT NULL DEFAULT false`）；保留既有列与 `UNIQUE(source, source_item_id)`
- [x] 2.4 迁移机制：**新增一个迁移文件**（如 `0001_*`）做 DROP（用 `DROP TABLE IF EXISTS`）+ 按新定义 CREATE（P0 仅 seed 数据、push_records 实际为空，DROP 无数据损失），**不重写既有 `0000` 基线**——重写基线会改 journal hash 破坏 2.6 的迁移幂等重跑验证。幂等由 journal 追加 0001 entry 保证，0001 的 SQL 本身无需可重入
- [x] 2.5 改写/删除依赖 seed event_id 的 P0 代码与测试（删 seed 后它们会编译断裂，必须同期处理）：`src/agents/value-judge/persistence.ts`（`seed-<id>` 生成逻辑）、`src/agents/value-judge/roundtrip.ts`、`src/agents/value-judge/__tests__/roundtrip.integration.test.ts`、`package.json` 的 `roundtrip` 脚本——改为走真实 dedup_key 塌缩往返或移除
- [x] 2.6 生成并应用 Drizzle migration；验证 `drizzle-kit migrate` 可重复执行幂等（重跑跳过、结构无变化）
- [x] 2.7 验证迁移后：`event_id` 列类型为 VARCHAR(128) 且 DEFAULT 为 `gen_random_uuid()::text`；`UNIQUE(dedup_key)` 与 `UNIQUE(target_type, target_id, channel, push_date)` 两个唯一约束均就位；确认 PostgreSQL ≥ 13（`gen_random_uuid()` 内置），否则迁移须先 `CREATE EXTENSION pgcrypto`

## 3. 规范化纯函数（dedup-and-normalization）

- [x] 3.1 实现 URL 规范化纯函数：去 utm/ref/gclid/fbclid/spm、去 fragment、query 排序、host 小写、去尾斜杠；带 `normalizer_version`
- [x] 3.2 实现标题归一化纯函数：小写、去标点、去 emoji、去站点名、繁简转换、去「快讯/重磅/刚刚」噪声词；`title_hash = sha256(normalized_title)`；带 `normalizer_version`
- [x] 3.3 实现 `dedup_key` 构造与 fallback 链：有 canonical_url → sha256(canonical_url)；否则 sha256(title_hash)；皆缺 → unprocessable
- [x] 3.4 单测：带 utm 的两 URL 归一为同一 canonical_url；仅噪声词不同的两标题得同一 title_hash；版本号写入 metadata

## 4. 三源 Collector（source-collectors）

- [x] 4.1 RSS collector：拉取配置源、解析为统一结构、source_item_id fallback 链 guid → canonical_url（即时生成）→ 内容哈希 `sha256(title‖content)`，绝不为 NULL
- [x] 4.2 Hacker News collector：HN API、source_item_id 用 item id
- [x] 4.3 GitHub collector：GitHub API（带 token 提额）、source_item_id 用 repo 稳定 id
- [x] 4.4 统一入库：写 raw_items（含 canonical_url、title_hash），外部调用带重试 + 错误日志
- [x] 4.5 单测/集成测：同一源重复抓取同一条目因 `UNIQUE(source, source_item_id)` 冲突被跳过（源内幂等）；source_item_id 永不为 NULL（guid 与 canonical_url 皆缺时落到内容哈希）；单源失败不拖垮整批

## 5. 硬去重塌缩（dedup-and-normalization）

- [x] 5.1 实现塌缩落库：按 dedup_key `INSERT ai_news_events ... ON CONFLICT (dedup_key) DO UPDATE`；INSERT 省略 event_id（由 DB 默认生成）；首建写 representative_raw_item_id / first_seen_at / published_at、初始化 source_count=1；UPDATE 分支**只**累加 source_count、更新 last_seen_at，set 中**不含** event_id/representative_raw_item_id/first_seen_at/published_at
- [x] 5.2 unprocessable 兜底：无 canonical_url 且归一后标题为空串的 raw_item 置 `unprocessable=true`，不产生 event
- [x] 5.3 集成测（**dedup 不变量**）：两条同 canonical_url 的 raw_item 塌缩为同一 event（同 event_id），source_count=2，验证 `UNIQUE(dedup_key)` 兜底；**断言再次塌缩不覆盖 event_id/representative_raw_item_id/first_seen_at/published_at**

## 6. Value Judge 接入流水线（value-judge-agent MODIFIED）

- [x] 6.1 把 P0 的 seed 落库脚手架替换为：对去重塌缩后的真实事件逐条调用 `judgeRawItem`，按 mapping 写入 `*_score` 列
- [x] 6.2 接入降级计数：单条失败跳过 + 记日志 + degraded_count++，整批继续
- [x] 6.3 集成测：真实事件评分按映射写入并可读回一致（往返）；校验失败不落库未校验数据

## 7. 中文摘要 Agent（chinese-digest-agent）

- [x] 7.1 实现摘要 Agent：generateObject + Zod schema（含 summary_zh）+ 有限重试 + 降级，复用 value-judge 结构
- [x] 7.2 落库 summary_zh；失败降级回退 representative_title 或剔除该 event，绝不写半截输出
- [x] 7.3 单测：摘要失败时降级不污染推送、不写未校验内容

## 8. Top N 选择（daily-intel-pipeline）

- [x] 8.1 实现候选窗口查询：`should_push=true AND first_seen_at 在近 N 天 AND 该 event 从未被任何 push_date 以该 channel success 推送过`；窗口「今天」必须**复用 9.1 的同一 Asia/Shanghai 时间源函数**（不另起实现，防两处时区漂移）
- [x] 8.2 实现组合分排序（权重读 config）+ 确定性 tiebreaker（`published_at DESC NULLS LAST, event_id ASC`）+ importance 下限闸
- [x] 8.3 单测：候选多于 N 时按 rank_score 确定性取前 N（对同一批已落库事件多次运行结果一致）；低于下限闸的被过滤；已 success 推送过的事件不再入选（跨天不重推）

## 9. Telegram 推送 Dispatcher（telegram-push）

- [x] 9.1 实现 push_date 按 Asia/Shanghai 算「今天」的工具函数 + 单测（跨 UTC 零点不算成两天）
- [x] 9.2 实现待发集合计算：今日 Top N 中 status ∈ {无记录, pending, failed}（显式排除今日 success）
- [x] 9.3 实现推送状态机：事务内对无记录者 INSERT pending（ON CONFLICT DO NOTHING）→ 拼一条 grammY 消息发送 → 成功整批 success / 失败整批 failed（留 error_message）
- [x] 9.4 实现日报全局单例锁（Redis SETNX daily-digest:{date}）：**必须带 TTL 或 finally 释放**，保证崩溃后同日可重新获取（不与僵尸 pending 重试冲突）；TTL 须显著大于最坏 runDailyWorkflow 时长或用可续租/看门狗锁（防固定小 TTL 提前过期致双发）
- [x] 9.5 集成测（**pushIdempotency 不变量**）：当天重跑待发集合为空不重发；发送失败整批 failed 且下次重试；僵尸 pending 被重试；锁崩溃未释放后同日 TTL 到期可重新获取（不死锁）；并发两实例仅一份送达（单例锁）；验证 `UNIQUE(target_type,target_id,channel,push_date)` 行为

## 10. BullMQ 编排与容错（daily-intel-pipeline）

- [x] 10.1 实现 `runDailyWorkflow()`：collect(Promise.allSettled 三源) → 去重塌缩 → Value Judge 逐条 → Top N → 摘要 → 推送，纯顺序
- [x] 10.2 实现 BullMQ 每日 cron 重复任务触发 `daily-digest`，BullMQ 仅作触发器 + 整 job 重试外壳（不拆阶段队列）
- [x] 10.3 实现降级率熔断（**按阶段分别计算、各自独立熔断**）：Value Judge 阶段只送判未评分事件（`*_score IS NULL`），分母 = 本轮送判事件数；摘要阶段分母 = Top N；任一阶段分母 > 0 且其降级率严格 > `DEGRADE_ABORT_RATIO` 即中止 + 告警，不推残缺日报。分母为 0 时禁止按 0/0 计算且**不中止**：judge 分母=0 直接进 Top N（已评分常青事件仍可推），摘要分母=0 正常不推。「系统级故障」告警以采集/规范化层为准：①采集返回条数=0（三源全挂）或②采集返回>0 但可处理条目数=0（全 unprocessable）均告警；可处理数含塌缩进既有事件者，故全命中既有事件的正常无新闻日不告警
- [x] 10.4 集成测：个别条目降级整批继续；**judge 与摘要两阶段各自超阈值即中止（摘要少量失败不被 judge 大分母稀释）**；**judge 分母=0 但有已评分常青候选时仍正常推送（不误判今日无候选中止）**；采集返回=0 或采集>0 但全 unprocessable 时告警；全命中既有事件的正常无新闻日不误告警

## 11. 收尾

- [x] 11.1 端到端冒烟：本地起 docker-compose，手动触发一次 `runDailyWorkflow()`，确认真实推送一条日报到 Telegram
- [x] 11.2 不变量测试全绿并纳入 CI：pushIdempotency / dedup / URL 归一 三个核心，外加降级熔断（10.4）与迁移幂等（2.6）
- [x] 11.3 更新 README 的运行说明与 `.env.example` 注释；ROADMAP 标记 P1 退出标准达成
