## 为什么

P1 已打通「RSS+HN+GitHub 三源 → 硬去重 → Value Judge → 中文摘要 → Telegram 单通道 + 幂等」的最小情报流并真上线。但当前源覆盖窄（无一线大厂官方发布、无产品发现、无论文）、只有单一推送通道、只有每日日报一种节奏。要让 ai-radar 真正成为「AI 行业情报流水线」，P2 必须把信号最高的**一线大厂官方新闻**接进来、补上**产品发现**与**论文**两类内容、加**飞书第二通道**与**实时重大发布告警 + 周报**两种新节奏。

源选型经外部鉴权/限流实测调研后做了修订：**Reddit 移出关键路径**（post-2023 收费化后免费层仅非商业用途、月上限 1 万次、商业用途需 $12000/年合同且条款封死商业化，把源稳定性绑在随时再收紧的源上风险过高）；改为**优先一线大厂官方源**（无鉴权、无限流费、信号最高）。

## 变更内容

- **扩源 T1（一线大厂官方 RSS，已实测有效）**：接入 OpenAI（`openai.com/news/rss.xml`）、Google DeepMind（`deepmind.google/blog/rss.xml`）、Hugging Face（`huggingface.co/blog/feed.xml`）。走现有 RSS collector，但**新增 vendor provenance**：当前 `mapRssItem` 把所有 RSS 标成 `source='rss'` 丢弃来源，本期改为给每条带厂商标记（写入 `metadata`，如 `{vendor, feed_url}`），供重要性评分与日报展示区分「谁发布的」。
- **扩源 T4（论文，仅采集沉淀）**：接入 arXiv，走 OAI-PMH 官方推荐的增量元数据抓取；**内置 ≥3s 节流 + 429 退避**（硬限流 1 请求/3 秒、单连接；2026-02 起 429 收紧）。P2 论文仅**采集落 `raw_items`（`raw_type='paper'`）作数据沉淀**，**不进日报板块、不推送**（论文板块渲染/推送留 P3，避免本期引入 `target_type='paper'` 全链路）。
- **采集器结构重构**：`CollectorSource` 写死联合类型 + `collectAllSources` 三个固定 `Promise.allSettled` 分支，加新源要改两处。本期抽成**数组驱动的 collector registry**，新增源只注册不改编排。
- **产品发现（新）**：接入 Product Hunt（Developer Token 只读，无需 OAuth flow；GraphQL 6250 复杂度点/15min，按 `X-Rate-Limit-*` 响应头自适应）。PH 作为普通 collector **先落 `raw_items`（`source='product_hunt'`、`raw_type='product'`）**（对齐 QA.md「输出统一写入 `raw_items`」），再由确定性步骤塌缩进 **新建的 `ai_products` 表**，硬规则产品合并键 `canonical_domain` / `github_repo` / `product_hunt_slug` 唯一约束（**绝不交给 LLM 判断**）。每日产品发现推送带跨天不重推候选窗口（同 event 口径）。
- **飞书第二通道（新）**：自定义机器人 webhook（100 次/分钟、5 次/秒；cron 避开整点/半点防 11232 限流）。Telegram 用 MarkdownV2、飞书用 JSON 卡片，**消息渲染按通道分叉**。推送 dispatcher **参数化 channel**——幂等四元组 `UNIQUE(target_type, target_id, channel, push_date)` 的 `channel` 列天生支持多通道，同一事件按通道各自独立幂等。
- **实时重大发布告警（新）**：事件级触发，**不复用日报的天级 `push_date` 幂等口径**（独立幂等键避免「当天日报已推 → 实时告警被吞」）。
- **周报（新）**：周期性汇总推送。

## 功能 (Capabilities)

### 新增功能
- `product-discovery`: Product Hunt 采集 + `ai_products` 表 + 硬规则产品合并（唯一约束）+ 每日产品发现推送。
- `feishu-push`: 飞书自定义机器人 webhook 通道 + JSON 卡片渲染 + 限流避让。
- `realtime-alerts`: 事件级重大发布实时告警，独立于日报的幂等口径。
- `weekly-report`: 周期性周报汇总与推送。

### 修改功能
- `source-collectors`: 抽数组驱动 collector registry；RSS 新增 vendor provenance（写入 `metadata`）；接入一线大厂官方 RSS（T1）；新增 arXiv collector（OAI-PMH + ≥3s 节流 + 429 退避，仅采集沉淀）；PH 作为 raw_items collector 纳入 registry。
- `dedup-and-normalization`: 事件塌缩（→ `ai_news_events`）新增类型路由，显式排除 `raw_type IN ('product','paper')`，防产品/论文条目污染新闻事件流或被双重消费。
- `telegram-push`: dispatcher 由 Telegram 专用泛化为**按 channel 参数化**；确立跨通道幂等语义（同事件按 channel 各自独立 pending→success/failed）。
- `platform-foundation`: 解禁并新建 `ai_products` 表（含硬规则合并唯一约束）；放宽 P1「仅三表」限制至 `ai_products`（其余五表仍留 P3/P5）。
- `daily-intel-pipeline`: 日报编排本期扩展为 registry 多源采集（含 arXiv/PH）+ 多通道并发分发 + Top N 候选窗口按 channel 分判 + 降级熔断口径更新（registry 全部源、分发失败不计入、新闻类分母）+ 并发评分原子 claim。产品发现/实时告警/周报均为**独立调度入口**、不塞进日报链；arXiv 论文 P2 仅采集沉淀、不进日报板块、不推送。

## 影响

- **代码**：`src/collectors/`（registry 重构、rss.ts provenance、新增 product-hunt.ts / arxiv.ts）、`src/push/`（dispatcher channel 参数化、新增 feishu sender、message.ts 按通道分叉）、`src/db/schema.ts` + 新 migration（`ai_products`）、`src/pipeline/`（编排扩展、周报/实时告警触发路径）、`src/agents/`（产品摘要/价值判断复用或扩展）。
- **配置**：`.env.example` 新增 `FEISHU_WEBHOOK_URL`/`FEISHU_SIGN_SECRET`、`PRODUCT_HUNT_TOKEN`、arXiv OAI-PMH 端点与节流参数、T1 vendor feed 清单与 vendor 映射、周报 cron、实时告警阈值；`DAILY_DIGEST_CRON` 默认值避整点。
- **依赖**：可能新增 GraphQL 客户端（或用 fetch 直发）、arXiv OAI-PMH/XML 解析（复用 rss-parser 或 fast-xml-parser）。
- **数据库**：新增 `ai_products` 表与唯一约束；`push_records` 写入新增 `feishu` channel 与新 `target_type`（如 `product` / `alert`）。
- **不变量（沿用 P1，本期不可违背）**：Agent 输出 Zod 校验失败重试/降级；所有外部 API 调用带重试 + 错误日志；推送先写 `pending` → 调 API → 置 `success`/`failed`，唯一键冲突即跳过；每个能力补对应不变量测试；去重/推送状态/幂等/唯一约束由程序与 DB 保障，绝不交给 LLM。

## 非目标

- **不接 Reddit**：条款风险（免费层非商业 only、商业需 $12000/年合同、月上限 1 万次），移出关键路径。
- **不做无原生 RSS 大厂的 HTML 抓取**：Meta AI / Anthropic / Mistral 列为 T2 次批，**不卡 P2 退出标准**，可 T1 上线后再提案补。
- **不做论文板块渲染/推送**：arXiv 论文 P2 仅采集落 `raw_items` 作数据沉淀，不进日报、不引入 `target_type='paper'` 全链路；论文板块留 P3。本期 `target_type` 收口集 = `{event, product, alert, weekly}`（不含 QA §8.6 注释的 `paper`/`repo`）。
- **不做语义去重 / 事件合并 / 知识库入库**：embedding 相似度、LLM 二次判断、`ai_news_events` 跨语言事件合并、KB 入库仍属 P3；本期产品合并**只用硬规则**。
- **不做 MCP 查询入口**：属 P4。
- **不交确定性状态给 LLM**：去重、推送状态、幂等、产品合并唯一键一律由程序与数据库保障。
