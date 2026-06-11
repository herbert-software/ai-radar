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
| **P2** | 扩源 + 双通道 + 产品发现 | 3–4 周 | W5 ~ W8 | 07-14 ~ 08-10 | GitHub/Product Hunt/Reddit/arXiv collector、飞书通道、`ai_products` 表 + **硬规则产品合并**、实时重大发布告警、周报 | P1 | 双通道均不重复推；每日产品发现推送；实时告警跑通 |
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
