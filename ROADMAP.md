# ai-radar 排期计划

> 拆分原则与各期范围的详细论证见本文件；权威需求见 [`QA.md`](./QA.md)，技术栈与不变量见 [`openspec/config.yaml`](./openspec/config.yaml)。

## 拆分原则

- **纵向切片**：第一个上线版本就打通"采集 → 去重 → 判断 → 摘要 → 推送"整条最小链路，每个环节取最简实现，而不是横向堆层（先做完所有 collector 再做去重再做推送 → 到最后才能跑）。
- **幂等从第 0 天就在**：`push_records` 唯一约束 + `ON CONFLICT` 是不可回退的地基，放进第一个可上线切片。
- **最难且最不确定的留到有数据之后**：embedding 阈值（0.88 / 0.82）、LLM 去重、提示词质量是靠真实数据调出来的，不是写出来的；先用便宜的硬去重跑起来积累数据，再上语义层。
- **顺数据沉淀的自然节奏**：工具选型顾问依赖前几期积累的结构化产品库，天然排在最后。

## 排期计划表

> 假设：单人 + VibeCoding 节奏；工期为**相对工作量区间**，日历日期为估算（以 Kickoff = 2026-06-16 周一起算），实际随源接入与调参迭代浮动。`P4` 与 `P3` 并行，不进关键路径。

| 期 | 里程碑 | 工期 | 周次 | 估算日历 | 关键交付物 | 依赖 | 退出标准（可观测） |
|---|---|---|---|---|---|---|---|
| **P0** | 地基 / Walking skeleton | 1 周 | W1 | 06-16 ~ 06-22 | TS+Hono+Drizzle 脚手架、docker-compose(pg+redis)、核心表 migration、`.env.example`、CI、一次 Zod 校验的真实 LLM 调用 | — | `docker compose up` 起得来；migration 落表；健康检查通过；`generateObject` 跑通一次 |
| **P1** ✅ | 最小情报流（**首个真上线**） | 2–3 周 | W2 ~ W4 | 06-23 ~ 07-13 | RSS + HN/GitHub 三源、`raw_items` 入库、**硬去重**、Value Judge(Zod)、中文摘要、**Telegram 单通道 + 幂等**、BullMQ 每日任务 | P0 | **退出标准达成**（见下「P1 退出标准达成」）：每日定时推 Top N（BullMQ cron + `runDailyWorkflow`）；同一天同一条不重复（`push_records` 幂等 + 单例锁）；带 utm 的 URL 被归一为同一条（URL 归一 + `dedup_key` 塌缩） |
| **P2** ✅ | 扩源 + 双通道 + 产品发现 | 3–4 周 | W5 ~ W8 | 07-14 ~ 08-10 | 一线大厂官方 RSS（OpenAI/DeepMind/HuggingFace，T1）/Product Hunt/arXiv collector、飞书通道、`ai_products` 表 + **硬规则产品合并**、实时重大发布告警、周报。**Reddit 经鉴权/限流调研移出关键路径**（条款风险，详见 `expand-sources-dual-channel-products` 提案非目标）；Meta/Anthropic/Mistral 无原生 RSS 的 HTML 抓取列 T2 次批 | P1 | **退出标准达成**（见下「P2 退出标准达成」）：双通道均不重复推；每日产品发现推送；实时告警跑通；周报跑通 |
| **P3** | 语义去重 + 知识库 | 3–4 周 | W9 ~ W12 | 08-11 ~ 09-07 | pgvector embedding 去重 + LLM 二次判断、`ai_news_events` 事件合并、KB 入库（本地表 → Dify HTTP）、只入 `long_term_value≥70` | P2 + 真实数据积累 | 中英文同一事件被识别为一条；阈值经真实数据调过；KB 可检索 |
| **P4** | MCP 查询入口 | 1.5–2 周 | W9 ~ W11（与 P3 并行） | 08-11 ~ 08-24 | MCP server：`get_today_ai_digest` / `search_ai_events` / `search_ai_products` / `mark_*` / `push_event_now` | P2 | 从 Claude/Cursor 查到当日日报与历史 |
| **P5** | AI 工具选型顾问 | 3–5 周 | W13 ~ W17 | 09-08 ~ 10-12 | `ai_tools` + `task_patterns` 表、规则召回、RAG 证据、LLM 解释、`recommend_ai_tools_for_task`（可拆 5a 数据+规则 / 5b RAG+解释 / 5c 暴露） | P3 + P4 + 数据积累 | "内部知识库选 Dify/RAGFlow/FastGPT" 能给出首选/备选/不推荐/落地步骤 |
| **P6** | Web 控制台（可选，延后） | 按需 | — | — | 前后端同 TS、复用 Zod schema 的人工干预面板 | P4 | — |

**关键路径**：P0 → P1 → P2 → P3 → P5 ≈ **13–17 周（约 3.5–4 个月）** 到完整顾问；**首个可用版本约第 4 周末（7 月中）** 上线。

## P1 退出标准达成

`minimal-intel-pipeline` 提案已实现，三条可观测退出标准均由程序 + DB 保障并有不变量测试覆盖：

| 退出标准 | 状态 | 实现与证据 |
|---|---|---|
| 每日定时推 Top N | ✅ 已实现 | BullMQ 每日 cron 重复任务（`DAILY_DIGEST_CRON`，默认 08:00 Asia/Shanghai）触发 `runDailyWorkflow()`（`src/pipeline/`）；组合分排序 + importance 下限闸 + 确定性 tiebreaker 取 Top N。`npm run worker` 起常驻调度，`npm run smoke` 手动触发一次。 |
| 同一天同一条不重复 | ✅ 已实现 | event 粒度幂等：`UNIQUE(target_type, target_id, channel, push_date)` + 待发集合显式排除「今日已 success」+ Redis 全局单例锁（同 `push_date` 仅一实例）。覆盖测试：`src/push/__tests__/dispatch.integration.test.ts`（pushIdempotency / 单例锁，本地实跑 7 用例全绿）。 |
| 带 utm 的 URL 被归一为同一条 | ✅ 已实现 | URL 归一去 `utm/ref/gclid/fbclid/spm` + query 排序 + host 小写 + 去尾斜杠 → `canonical_url`；`dedup_key` 经 `ON CONFLICT` 塌缩为单一 `ai_news_events`。覆盖测试：`src/dedup/__tests__/normalize.test.ts` + `collapse.integration.test.ts`（dedup 不变量，本地实跑全绿）。 |

> 验证：本地 `docker compose up -d` + `npm run migrate`（两次重跑验证迁移幂等）后，全量 vitest **126 测试全绿**
> （含 pushIdempotency / dedup / URL 归一 / 降级熔断 10.4 / 单例锁五组不变量，连真实 pg+redis 实跑不 skip）。
> CI（`.github/workflows/ci.yml`）带 postgres(pgvector) + redis services，迁移幂等与上述不变量测试在 CI 路径内实跑。
> **真实 Telegram 送达**需真实 `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` + 外网，交付用户本地执行 `npm run smoke` 确认。

## P2 退出标准达成

`expand-sources-dual-channel-products` 提案已实现（M1 扩源 → M2 双通道 → M3 产品发现 → M4 告警/周报），四条可观测退出标准均由程序 + DB 保障并有不变量测试覆盖：

| 退出标准 | 状态 | 实现与证据 |
|---|---|---|
| 双通道均不重复推 | ✅ 已实现 | dispatcher channel 参数化（`src/push/dispatcher.ts` + `src/push/targets.ts` 枚举收口 `target_type={event,product,alert,weekly}` / `channel={telegram,feishu}`）；幂等四元组 `UNIQUE(target_type, target_id, channel, push_date)`，候选/待发按 channel 分别判定「从未以该 channel success」，同事件可分别进 telegram 与 feishu 候选、各自独立幂等。飞书 sender + 签名 + JSON 卡片渲染（`src/push/feishu.ts`），可选通道（两者全配才 enabled，纯 Telegram 部署照常启动）。覆盖测试：`src/push/__tests__/dispatch.integration.test.ts`（同事件不同 channel 各自独立幂等、telegram 已 success 不抑制 feishu 待发）、`src/push/__tests__/feishu.test.ts`（卡片渲染 / channel='feishu' 幂等 / 单通道失败隔离 / 纯 Telegram 启动）。 |
| 每日产品发现推送 | ✅ 已实现 | Product Hunt 采集先落 `raw_items`（`source=product_hunt`、`raw_type=product`，`src/collectors/product-hunt.ts`）→ 确定性硬合并塌缩进 `ai_products`（全部非空归一键 `FOR UPDATE` 收集命中、按 `canonical_domain`/`github_repo`/`product_hunt_slug` 唯一键 INSERT/UPDATE/冲突分流，全程无 LLM，`src/collectors/product-collapse.ts`）；独立 BullMQ 调度（`src/pipeline/product-digest.ts`，`target_type=product`、独立单例锁 `product-digest:{channel}:{push_date}`），候选「该 product_id 从未以该 channel success」跨天不重推 + 排除 `merge_conflict`。覆盖测试：`src/collectors/__tests__/product-collapse.integration.test.ts`（单行 product_id 不变 / 非空 name 兜底 / 多键多行冲突告警不静默择一 / NULL 键不放行 / 零 LLM）、`src/pipeline/__tests__/product-digest.integration.test.ts`（同天同通道不重推 / 跨天不再重推 / 冲突态排除 / 与事件日报 target_type 不挤占）、`src/db/__tests__/ai-products-migration.integration.test.ts`（落表 + 三唯一约束 + 迁移幂等 + 无向量列）。 |
| 实时告警跑通 | ✅ 已实现 | 高频独立调度（`src/pipeline/alert-queue.ts` + `alert-scan.ts`，默认每 20min，只采实时新闻源 `{rss,hacker_news,github}`）→ 塌缩 → 评分 → **评分后**判 `importance_score >= ALERT_IMPORTANCE_THRESHOLD`（默认 85，纯程序阈值）告警；四元组 `target_type=alert`、`target_id=event_id` 一生一次去重 + 独立单例锁 `alert:{channel}:{event_id}`；Value Judge 并发原子 claim（`judge_claimed_at` 列 + 回收阈值 `T > L + W`，`src/agents/value-judge/score-events.ts`）防日报链/告警链双评分。覆盖测试：`src/pipeline/__tests__/alert-scan.integration.test.ts`（评分后达阈值即告警 / 评分前不误判 / 日报已推同事件仍可 alert / 一生一次 / 同日并发 UNIQUE 兜底 / 低于阈值不触发 / 无摘要 headline 回退）、`src/agents/value-judge/__tests__/claim.integration.test.ts`（两链路并发只评一次 / claim 后崩溃经 T 重评 / 逼近 L+W 不误回收）。 |
| 周报跑通 | ✅ 已实现 | 周级独立调度（`src/pipeline/weekly-report.ts`，默认每周一 09:07）：程序规则从「被汇总窗口 `[上周一,本周一)`」选高价值事件/产品、复用已落库 `summary_zh`/`headline_zh` 零 LLM；四元组 `target_type=weekly`、`target_id=iso_week`、`push_date=该 ISO 周周一`，iso_week 与 push_date 同源锚定汇总窗口（防跨周边界抖动错配）+ 独立单例锁 `weekly:{channel}:{iso_week}`。覆盖测试：`src/pipeline/__tests__/weekly-report.test.ts`（同一 ISO 周内抖动触发不改变 target_id/push_date）、`src/pipeline/__tests__/weekly-report.integration.test.ts`（同周不重推 UNIQUE 兜底 / 周报与日报 target_type 不挤占）。 |

> **arXiv 增量采集（at-least-once）**：arXiv 仅在日报链采集（非实时，不入告警链），仅落 `raw_items` 作数据沉淀（`collapsed=true`、不进事件塌缩/日报/推送）。游标接线选**固定回溯窗口**方案（`src/collectors/arxiv-cursor.ts`：`load()` 返回 `now − 7d` 作 OAI-PMH `from`，`commit` no-op），**无漏窗 + crash-safe 由「固定窗口重叠 + `UNIQUE(source, source_item_id)` 幂等吸收重抓」共同保障**，无需新建表或持久化游标。`src/pipeline/run-daily-workflow.ts` 在采集阶段注入默认游标（调用方未自带 arxiv 选项时）。覆盖测试：`src/collectors/__tests__/collectors.test.ts`（回溯窗口下界 / commit no-op / 接入 harvest 首请求带 `from=窗口下界`，注入桩不触网）。
>
> **降级熔断扩展（M2）**：全失败告警分母改 registry 全部源、新闻类可处理条目分母（排除 `raw_type` product/paper）、分发失败不计入 judge/摘要熔断分母、仅日报链套用高频告警链不套用（`src/pipeline/circuit-breaker.ts`，覆盖测试 `src/pipeline/__tests__/circuit-breaker.test.ts`「仅 arXiv 返回 paper、新闻源全空 → 仍按新闻真空告警」）。

> 验证：本地 `docker compose up -d`（postgres pgvector + redis healthy）+ `npm run migrate` **连续两次重跑**验证迁移幂等（含 `ai_products` forward-only 0004 + `judge_claimed_at`；第二次无新 SQL，journal 维持 5 条已应用、结构无变化）后，全量 vitest **287 测试全绿、0 skip**（连真实 pg+redis 实跑不 skip）；`npx tsc --noEmit` 0 错、`npm run lint` 0 错。
> CI（`.github/workflows/ci.yml`）带 postgres(pgvector) + redis services，注入全部必填 env 占位（含 `PRODUCT_HUNT_TOKEN`），迁移幂等与上述不变量测试在 CI 路径内实跑。
> **真实鉴权/配额勘验**（PH Developer Token 拉一次 + 剩余复杂度点、arXiv OAI-PMH 拉一次确认 ≥3s 不被 429、飞书 webhook 发一条测试卡片）需真实凭据 + 外网、**无法在本环境复现**，交付用户本地用真实凭据执行（结果作 artifact 附 PR）；持续节流/退避逻辑已由单测（注入桩）覆盖。

## 排序依据

- **P1 选 Telegram 单通道**：只为先打通最简推送链路验证整条管道；飞书 P2 补，二者可互换。
- **产品合并 P2 用硬规则先行**（`canonical_domain` / `github_repo` / `product_hunt_slug` 唯一键），昂贵的语义合并留到 P3 与事件去重共用 embedding 设施。
- **MCP（P4）排在有数据之后**：无积累的事件/产品则查询接口无内容；可与 P3 并行。
- **顾问（P5）垫底**：最依赖前期沉淀的结构化产品库，价值最高，宜在地基稳固后做。

## 横切关注点（每期都带，不单独排期）

每个 PR 都须满足，否则违反 `config.yaml` 不变量：

- Agent 输出一律 Zod 校验，失败重试/降级而非吞掉；
- 所有外部 API 调用带重试 + 错误日志；
- 推送一律"先写 `pending` → 调 API → 置 `success`/`failed`"，唯一键冲突即跳过；
- 每期补对应不变量测试（P1 起即有 `pushIdempotency` / `dedup` / URL 归一 三个 Vitest）。

## 风险与缓冲

- **VibeCoding 改变时间结构**：写代码更快，省下的时间转到验证与调参——去重阈值（P3）、提示词质量（P1/P5）是经验性的，排期已为其留迭代回合，不按"写完即完成"估。
- **外部源认证/限流**（Product Hunt、Reddit、PH 排名）是 P2 主要不确定性：建议 P0/P1 期间先各跑一次手动抓取确认配额与鉴权。
- **数据沉淀是日历时间输入**：P3 阈值调优与 P5 顾问都需 P1/P2 已运行数周积累真实数据，不宜在无数据阶段提前压上。

## 与 OpenSpec 的衔接

本仓库为 spec-driven。建议**逐期立提案**（`/opsx:propose`）：先做 P0 + P1，其余各期在前一期收尾时再提案，避免把仍会变动的后期细节过早写死。
