# ai-radar

> **AI 行业情报流水线 + AI 工具选型顾问**
>
> 一个可长期运行的系统：聚合国内外 AI 新闻 / 产品 / 开源项目 / 论文 / 工具更新 → 跨来源去重 → 价值判断 → 中文摘要 → 飞书 / Telegram 推送 → 知识库沉淀 → MCP 查询与工具选型问答。
>
> **当前最高优先：Model Radar（P5）** —— AI 编程订阅 / Coding Plan / Token 包的**比价 + 选型**（编程垂类），作为同仓 bounded domain 并入（详见 [`ROADMAP.md`](./ROADMAP.md)「P5 Model Radar 步骤拆解」）。

完整需求与设计文档见 [`QA.md`](./QA.md)（权威来源，任何冲突以它为准）。

---

## 这是什么 / 不是什么

- **是**：确定性流水线 + 数据库状态 + Agent 语义判断 + RAG 证据检索。
- **不是**：一条“全 Agent 自治流”，也不是单纯的新闻聚合工具。

去重、推送状态、幂等与唯一约束由**程序和数据库**保障；LLM 只负责分类、摘要、价值评分、推荐解释。

## 架构

```text
Scheduler / Workflow Engine
  ↓
Collectors (RSS / GitHub / Product Hunt / Hacker News / Reddit / arXiv / Hugging Face / Official Blog)
  ↓
Normalizer  →  Dedup Service  →  Value Judge Agent  →  Chinese Digest Agent
  ↓
Push Dispatcher (飞书 Bot / Telegram Bot)
  ↓
Knowledge Base Ingestion  →  MCP / API / Chat Query
```

职责边界：

| 组件 | 职责 |
|---|---|
| Workflow | 控制流程 |
| Database | 控制事实和状态（唯一索引决定是否重复） |
| Agent | 控制语义判断（分类 / 摘要 / 评分 / 推荐解释） |
| RAG | 控制证据检索 |
| MCP | 控制外部访问（查询与人工干预入口，不参与主流程调度） |
| Push Dispatcher | 控制推送幂等 |

## 工作流程图

> 颜色区分职责：🟦 确定性程序 · 🟨 Agent（LLM）· 🟩 数据库/知识库 · 🟥 幂等/去重闸门。

### 每日运行：采集 → 去重 → 判断 → 摘要 → 推送

```mermaid
flowchart TD
    CRON([BullMQ 定时/实时触发]):::prog --> COL

    subgraph COL[Collectors · 确定性程序]
      RSS[RSS]:::prog
      GH[GitHub]:::prog
      HN[Hacker News]:::prog
      MORE[Product Hunt / Reddit / arXiv / HF / 官方Blog]:::prog
    end

    COL --> RAW[(raw_items)]:::db
    RAW --> NORM["Normalizer<br/>URL/标题清洗 · canonical_url · title_hash"]:::prog
    NORM --> DH{"硬去重<br/>唯一键命中?"}:::gate
    DH -- 命中 --> DROP[跳过 · 标记重复]:::prog
    DH -- 未命中 --> EMB{"embedding 相似度"}:::gate
    EMB -- "cos≥0.88 疑似重复" --> MERGE["事件/产品合并"]:::prog
    EMB -- "0.82~0.88 待定" --> LLMD["LLM 去重判断"]:::agent
    EMB -- "低于阈值" --> NEW[新事件/新产品]:::prog
    LLMD --> MERGE
    LLMD --> NEW

    NEW --> JUDGE
    MERGE --> JUDGE["Value Judge Agent<br/>是否AI相关 · 分类 · 评分 · should_push"]:::agent
    JUDGE -- "should_push=true" --> DIGEST["Chinese Digest Agent<br/>中文标题/摘要/适合谁/风险"]:::agent
    JUDGE -. "long_term_value≥70" .-> KBING

    DIGEST --> GATE{"push_records 幂等闸<br/>UNIQUE 命中?"}:::gate
    GATE -- 冲突 --> SKIP[跳过推送]:::prog
    GATE -- "写入 pending" --> DISP[Push Dispatcher]:::prog
    DISP --> TG[Telegram]:::prog
    DISP --> FS[飞书]:::prog
    DISP --> RES["成功置 success<br/>失败置 failed（可重试）"]:::db

    KBING["KB Ingestion<br/>只入精选"]:::prog --> KB[("知识库<br/>Dify / RAGFlow / pgvector")]:::db

    classDef prog fill:#e0f2fe,stroke:#0369a1,color:#0c4a6e;
    classDef agent fill:#fef9c3,stroke:#ca8a04,color:#713f12;
    classDef db fill:#dcfce7,stroke:#16a34a,color:#14532d;
    classDef gate fill:#fee2e2,stroke:#dc2626,color:#7f1d1d;
```

### 查询与选型：用户主动发起（不参与上面的调度主流程）

```mermaid
flowchart LR
    USER([用户 · Claude/Cursor/ChatGPT]):::prog --> MCP[MCP Server]:::prog
    MCP --> Q1[get_today_ai_digest]:::prog
    MCP --> Q2[search_ai_events / products]:::prog
    MCP --> Q3[recommend_ai_tools_for_task]:::prog
    Q1 --> DB[(PostgreSQL)]:::db
    Q2 --> DB
    Q3 --> RECO["推荐引擎<br/>规则召回 → RAG 证据 → LLM 解释"]:::agent
    RECO --> DB
    RECO --> KB[(知识库)]:::db
    RECO --> OUT["首选 / 备选 / 不推荐 / 落地步骤"]:::prog

    classDef prog fill:#e0f2fe,stroke:#0369a1,color:#0c4a6e;
    classDef agent fill:#fef9c3,stroke:#ca8a04,color:#713f12;
    classDef db fill:#dcfce7,stroke:#16a34a,color:#14532d;
```

读图要点：**事实只存数据库**（🟩），去重与推送是否重复由**唯一键闸门**（🟥）裁决，LLM（🟨）只做语义判断不碰状态——这正是"确定性流程 + DB 控状态 + Agent 控语义"原则的可视化。

## MCP 查询入口（在 Claude Desktop / Cursor 里用）

`src/mcp/server.ts` 是一个**独立的 MCP server 进程**（stdio transport），与流水线并列、**不参与日报调度**，把情报暴露为可在 Claude Desktop / Cursor 等客户端直接调用的查询与人工干预工具。

### 客户端配置（mcpServers）

在客户端的 MCP 配置文件里加一项（Claude Desktop：`claude_desktop_config.json`；Cursor：`.cursor/mcp.json`）。**直接用 `tsx` 跑 `src/mcp/server.ts`，不要用 `npm run mcp`**——`npm` 的启动横幅会污染 stdout（stdio 下 stdout 是 JSON-RPC 专用通道，任何非协议内容都会让客户端解析失败）。

**纯查询（最常用）——只需 `DATABASE_URL`**：

```json
{
  "mcpServers": {
    "ai-radar": {
      "command": "tsx",
      "args": ["src/mcp/server.ts"],
      "cwd": "/绝对路径/到/ai-radar",
      "env": {
        "DATABASE_URL": "postgres://ai_radar:ai_radar@localhost:5432/ai_radar"
      }
    }
  }
}
```

- `command: "tsx"` 须能被客户端 PATH 找到（或写成 `npx` + `args: ["tsx", "src/mcp/server.ts"]`，或填 `tsx` 的绝对路径）。
- `cwd` 必须是仓库根的**绝对路径**：server 用 `import 'dotenv/config'` 之外不自动找 `.env`，且模块解析依赖 cwd。
- `env.DATABASE_URL` **必填**：缺失/畸形时 server 在 connect 之前写 stderr 报错并 `exit(1)`（启动崩，不会静默）。
- 纯查询链零全局-env 依赖：**只配 `DATABASE_URL` 即可启动并使用全部 5 个查询工具 + 2 个标记工具**；不需要 telegram/feishu/redis/llm/product_hunt 任何 token。

**要用 `push_event_now`（会真发推送）——须配齐与 worker 同的全部 required env**：

`push_event_now` 的 handler 内动态 import 推送链（`dispatcher` → 全局 `parseEnv`），会校验**全部** required 变量（不止 telegram）。缺任一 → 该通道返回错误（不影响查询工具）。

```json
{
  "mcpServers": {
    "ai-radar": {
      "command": "tsx",
      "args": ["src/mcp/server.ts"],
      "cwd": "/绝对路径/到/ai-radar",
      "env": {
        "DATABASE_URL": "postgres://ai_radar:ai_radar@localhost:5432/ai_radar",
        "REDIS_URL": "redis://localhost:6379",
        "LLM_API_KEY": "sk-or-...",
        "LLM_MODEL": "openai/gpt-4o-mini",
        "PRODUCT_HUNT_TOKEN": "...",
        "TELEGRAM_BOT_TOKEN": "...",
        "TELEGRAM_CHAT_ID": "...",
        "FEISHU_WEBHOOK_URL": "https://open.feishu.cn/...",
        "FEISHU_SIGN_SECRET": "..."
      }
    }
  }
}
```

> 飞书可选：未配 `FEISHU_WEBHOOK_URL` + `FEISHU_SIGN_SECRET` 时 `push_event_now` 默认只推 telegram；配齐则默认 telegram + feishu（也可用 `channel` 参数指定单通道）。

### 7 个工具一览（何时用 + 关键约束）

| 工具 | 何时用 | 关键约束 |
|---|---|---|
| `get_today_ai_digest` | 想看**今天已经推送出去**的日报（要闻段 + 新品段） | **查「已推事实」而非重跑 Top N 选择**——以 `push_records` 中今天 success 的记录还原；channel 默认取当日实际推过的所有通道（不依赖进程 env），可传 `channel` 过滤；产品链接经严格域名校验，畸形域降级为无链接（与实际已推一致）；当日未推则返回空 + 「今日尚未推送」。只读。 |
| `search_ai_events` | 按关键词 / 时间窗 / 重要度查**历史事件** | **无 source（来源）维度**——事件表无 source 列，源统计请改用 `get_source_quality_report`；关键词走标题/摘要 ILIKE，`%`/`_` 等 LIKE 元字符按字面匹配；`limit` 默认 20、上限 100；按 `published_at` 降序分页。只读。 |
| `search_ai_products` | 按名称 / 域名查**历史产品** | 名称或 `canonical_domain` 关键词（同 LIKE 转义）分页；链接经严格域名校验，畸形域降级为无链接。只读。 |
| `get_source_quality_report` | 评估各**信息源**的产出与转化 | 按 source 聚合采集量 / 塌缩入事件数 / 被推送数 / 最近活跃时间；**按代表源归因**（多源塌缩事件仅计代表源）；用「被推送数」替代不可从 DB 计算的「入选 Top N 率」。只读、无入参。 |
| `mark_event_not_relevant` | 人工把某事件**踢出后续推送候选** | 置 `should_push=false`（事件表无 metadata 列，`reason` 仅记日志/返回、不入库）；事件不存在 → 返回错误；幂等。 |
| `mark_product_interesting` | 人工给某产品打**「有趣」标记** | 在 `ai_products.metadata` 原子 merge 写 `interesting`（含时间/备注），不新增列、不触 LLM；产品不存在 → 返回错误；幂等。 |
| `push_event_now` | 人工**立即把某事件推送**出去（不等日报） | **会真实发送外部消息**——复用既有 `dispatchDigest` 幂等状态机（该通道已成功推过则跳过）、单段要闻 digest；需配齐全部推送相关 env（缺则该通道返回错误）；多通道时各自独立，一个失败不拖累其它。 |

## 技术栈

> **采用 TypeScript**（经评估后从 `QA.md` 的 Python 默认改选,理由见 [技术栈决策](#技术栈决策为什么用-typescript-而非-qamd-的-python)）。

| 层 | 选型 | 说明 |
|---|---|---|
| 语言 / 运行时 | **TypeScript + Node.js** | 静态类型为 AI 生成代码兜底 |
| API | **Hono**(或 Fastify) | 轻量、类型友好;Fastify 插件生态更成熟 |
| 数据库 / ORM | **PostgreSQL + pgvector + Drizzle** | SQL-first,原生支持 `ON CONFLICT` 与 pgvector |
| 迁移 | **Drizzle Kit** | `drizzle-kit migrate` |
| LLM / 结构化输出 | **Vercel AI SDK + Zod** | `generateObject` / `embed`,schema 即类型即校验,多 provider |
| 编排 / 调度 / 队列 | **BullMQ**(Redis) | 自带重试与幂等任务;**不用 LangGraph** |
| Telegram | **grammY** | 现代、强类型 |
| 飞书 | 原生 fetch + 签名 Webhook | — |
| 知识库 | Dify / RAGFlow（HTTP API） | 当可替换黑盒消费 |
| 查询入口 | **MCP Server**(@modelcontextprotocol/sdk) | 官方 TS-first |
| 本地 ML 逃生舱 | Python sidecar(按需) | 仅当未来需本地 embedding/rerank 模型时,经 HTTP 旁挂 |

## 技术栈决策：为什么用 TypeScript 而非 QA.md 的 Python

`QA.md` 默认推荐 Python,但经评估后本项目主应用选 **TypeScript**:

- **主负载是 I/O 编排**(HTTP 采集、DB 约束、幂等推送),不是 ML 计算,两种语言都胜任。
- **决定性因素 — VibeCoding**:大量代码由 AI 生成且不逐行 review,TS 静态类型在**编译期**拦截 AI 高频错误(字段名 / 数据 shape / null / LLM 返回结构不符),是一道免费的正确性防线;Python 类型 opt-in,错误多在运行时才暴露。
- **正中硬要求**:项目反复要求"所有 Agent 输出必须结构化 JSON 并校验",**Zod + AI SDK `generateObject`** 是当前 DX 最佳实现。
- **不用 LangGraph**:流水线是线性的,Agent 部分都是单次结构化调用,LangGraph 属过度设计且迭代快(AI 易生成过时代码),改用 BullMQ + 显式工作流函数。
- **Dify/RAGFlow 不构成 Python 锁定**:通过 HTTP API 消费,主应用语言无关。评估未来 fork/魔改其内核的概率为**低(约 10–15%)**——它们被设计成 interface 后的可替换黑盒,高价值逻辑都在自有 PostgreSQL + 应用代码里;需求增长的出口是"替换为自建 pgvector / 旁挂 sidecar",而非改其内核。
- **Web 控制台**非第一期必要;一旦要做,TS 可前后端同语言并复用 Zod schema。

## 关键不变量

实现与评审必须守住这些约束（详见 `QA.md` §9 / §12）：

- **推送幂等**：`UNIQUE(target_type, target_id, channel, push_date)`。先写 `push_records=pending`，唯一键冲突即跳过，成功置 `success`，失败置 `failed` 保留错误信息可重试。
- **分层去重**：硬去重(`source+guid` / `canonical_url` / `github_repo` / `product_hunt_slug` / `canonical_domain`) → 标题归一化(`title_hash`) → embedding 相似度 → LLM 判断 → DB 唯一约束兜底。
- **URL 规范化**：移除 `utm/ref/gclid/fbclid/spm` 等追踪参数生成 `canonical_url`。
- **知识库不是垃圾桶**：只入精选（`long_term_value >= 70`），不入每条 RSS 原文 / 转载 / 营销稿 / 标题党。
- **推荐逻辑**：规则筛选负责“不离谱”、RAG 负责“有依据”、LLM 负责“讲明白”、DB 负责“事实和状态”。不让 LLM 直接拍脑袋推荐工具。

## 数据模型

核心表（DDL 见 `QA.md` §8）：`raw_items`、`ai_news_events`、`ai_products`、`item_event_relations`、`item_product_relations`、`push_records`、`kb_ingestion_records`、`ai_tools`、`task_patterns`。

## 实施路线 / 排期

完整排期计划表、各期范围、退出标准与风险见 [`ROADMAP.md`](./ROADMAP.md)。概览：

| 期 | 里程碑 | 上线后能用什么 |
|---|---|---|
| **P0** | 地基 | 脚手架 + 核心表 + 一次跑通的 Zod 校验 LLM 调用 |
| **P1** | 最小情报流（**首个真上线**） | 每日去重 + 中文 + 评分的 Telegram 日报，当天不重复 |
| **P2** | 扩源 + 双通道 + 产品发现 | 多源、飞书也通、每日 AI 产品发现、实时告警、周报 |
| **P3** | 语义去重 + 知识库 | 跨源/跨语言同事件合并、精选可检索 |
| **P4** | MCP 查询入口 | 在 Claude/Cursor 里查情报、人工干预（与 P3 并行） |
| **P5** ⭐ | **Model Radar（编程订阅比价 + 选型，现最高优先）** | 编程订阅 / Coding Plan / Token 包比价页 + 「接 Claude Code 用哪个国产模型最划算」选型；10s 内答「谁含 GLM-5.2 / 谁支持 Claude Code / 同档谁最划算 / 谁最近变了」 |
| **P6** | 泛化选型顾问（原 P5） | "做某事用哪个 AI 工具" 的首选/备选/不推荐/落地步骤 |
| P7 | Web 控制台（可选，延后） | 人工干预面板 |

> 关键路径约 13–17 周；首个可用版本约第 4 周末。MVP 任务拆解与测试用例见 `QA.md` §17 / §18。
>
> **进度（截至 2026-06-21）**：P0–P4 ✅ 全部落地，外加 roadmap 外的「AI 博主经验挖掘」链（`ai_experiences` 表 + 经验链 + ≥70 价值闸入知识库）。**下一步 P5 = Model Radar（编程订阅比价 + 选型，已提优先级）**，先做 5a（数据模型 + provenance）；原通用「工具选型顾问」降为 P6 泛化目标。P3 语义阈值的真实数据复校为持续运营动作（接线就位、取默认值，详见 `ROADMAP.md`「P3 退出标准达成」）。

## 建议目录结构

> QA.md §16 的目录是 Python 版;下面是对齐 TS 技术栈后的等价结构。

```text
ai-radar/
  src/
    app/          # server.ts (Hono), config.ts
    db/           # client.ts, schema.ts (Drizzle), migrations/
    collectors/   # rss / github / producthunt / hackernews / reddit / arxiv / huggingface / officialBlog
    services/     # normalize / dedup / embeddings / eventMerge / productMerge / scoring / push / kbIngestion / recommendation
    agents/       # valueJudge / digestZh / productClassifier / toolRecommender  (AI SDK + Zod)
    channels/     # telegram (grammY) / feishu
    workflows/    # dailyDigest / realtimeAlert / weeklyReport / ingestKb  (BullMQ jobs)
    mcp/          # server.ts, tools.ts
    schemas/      # zod schemas（Agent 输出 / DTO）
    prompts/      # 提示词
  drizzle.config.ts
  tests/          # dedup / pushIdempotency / productMerge / recommendation  (Vitest)
  docker-compose.yml
  .env.example
```

## 环境变量

参考 `QA.md` §19，落地时提供 `.env.example`：

```env
DATABASE_URL=postgresql://user:password@localhost:5432/ai_radar
REDIS_URL=redis://localhost:6379/0
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
DEEPSEEK_API_KEY=
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
FEISHU_WEBHOOK_URL=
FEISHU_SECRET=
DIFY_API_BASE=
DIFY_API_KEY=
DIFY_DATASET_ID=
ENABLE_PGVECTOR=true
DEFAULT_TIMEZONE=Asia/Shanghai
```

## 开发约定

本项目采用 **OpenSpec（spec-driven）** 工作流。项目上下文与不变量沉淀在 [`openspec/config.yaml`](./openspec/config.yaml)，需求权威文档为 [`QA.md`](./QA.md)。AI 协作约定见 [`CLAUDE.md`](./CLAUDE.md)。

> **进度（截至 2026-06-21）**：P0–P4 + 「AI 博主经验挖掘」链均已落地（多源采集 → 跨源/跨语言语义去重 → 价值判断 → 中文摘要 → 飞书/Telegram 双通道推送，含产品发现 / 实时告警 / 周报 / 本地表知识库 / MCP 查询入口）；下一步 **P5 = Model Radar（编程订阅比价 + 选型，已提优先级）**，通用泛化顾问降为 P6。下面两节（P0 从零到验证序列、**P1 流水线运行说明**）是最初的端到端跑通指引，后续各期能力在其上叠加，运行入口不变。

## 本地起步 / 快速开始

前置：Node ≥ 20、Docker（含 `docker compose`）。

```bash
# 1) 准备环境变量
cp .env.example .env
# 编辑 .env：
#   - DATABASE_URL / REDIS_URL：用 docker-compose 默认即可（见下方说明）
#   - LLM_API_KEY：填 OpenRouter key（形如 sk-or-...）
#   - LLM_BASE_URL：默认 https://openrouter.ai/api/v1（可省）
#   - LLM_MODEL：如 openai/gpt-4o-mini

# 2) 起基础设施（postgres + redis）并确认健康
docker compose up -d
docker compose ps          # 两个服务都应显示 (healthy)

# 3) 安装依赖
npm install

# 4) 迁移：对空库落 raw_items / ai_news_events / push_records 三张表（幂等，可重跑）
npm run migrate

# 5) 起 Hono 服务并验证健康检查
npm run dev                # 监听 http://localhost:3000（PORT 可覆盖）
curl http://localhost:3000/health
# 期望：{"status":"ok","db":"ok","redis":"ok"}；任一依赖不可达会如实反映为 down

# 6) Value Judge 真实往返（需真实 LLM key）：
#    seed 一条假 raw_item → generateObject + Zod 校验 → 按字段名映射写 ai_news_events
#    → 读回比对各 *_score 列；成功时会 dump 落库行作为可审计 artifact
npm run roundtrip
```

> **DATABASE_URL 与 compose 默认对齐**：`docker-compose.yml` 默认用户/密码/库均为 `ai_radar`。
> 若沿用 compose 默认，`.env` 里应填：
> `DATABASE_URL=postgres://ai_radar:ai_radar@localhost:5432/ai_radar`、`REDIS_URL=redis://localhost:6379`。
> （仓库内 `.env.example` 的示例串仅为占位，请按你的 compose 凭据填写。）

辅助脚本：

```bash
npm run typecheck   # tsc --noEmit（strict）
npm run lint        # eslint（flat config）
npm run test        # vitest run（/health、迁移断言、Value Judge mock 往返等）
```

## P1 流水线运行说明（采集 → 去重 → 判断 → 摘要 → Telegram 推送）

P1 把每日情报流水线接成一条 `runDailyWorkflow()`：三源采集（RSS / Hacker News /
GitHub，`Promise.allSettled` 容错）→ URL/标题归一 + `dedup_key` 硬去重塌缩 → Value Judge
逐条评分（只判未评分事件）→ Top N 组合分排序 + importance 下限闸 → 中文摘要 → grammY
单通道 Telegram 推送（`push_records` 幂等 + 全局单例锁）。BullMQ 只当「每日 cron 定时
触发器 + 整 job 重试外壳」，不拆阶段队列。

> **日报格式（自 `improve-digest-format` 起）**：日报渲染已从「每条堆叠完整长摘要」改为
> 「序号 + 代表标题（粗体，渲染期按 code point 截断 ≤`TITLE_MAX`）+ 一句话要点
> （`headline_zh`，≤`HEADLINE_MAX`=80 字）+ 原文可点击链接（`canonical_url`）」——
> 一眼能扫完、想深入再点链接。Digest Agent 在同一次结构化输出里新增 `headline_zh`
> 短要点（落 `ai_news_events.headline_zh` 列，与长摘要 `summary_zh` 并存：`headline_zh`
> 进日报，`summary_zh` 落库留待知识库 / Web 控制台）。回退链：`headline_zh` 缺失（旧事件/降级）
> → `summary_zh` 截断前 ~80 字 → 仅标题；`canonical_url` 缺失则不渲染链接。因标题与要点均有界，
> Top N（默认 8 条）一条消息远低于 Telegram ~4000 字上限，**截断顺延从常态退化为极少触发的兜底**
> （截断逻辑与告警保留不变）。`HEADLINE_MAX`(80) / `TITLE_MAX`(120) 是代码内常量
> （`src/agents/digest/`、`src/push/message.ts`），非环境变量，本变更未新增必填 env。

前置同上：`docker compose up -d`（postgres + redis healthy）+ `npm run migrate`。
此外 P1 需在 `.env` 补齐（见 [`.env.example`](./.env.example) 各项注释）：

- `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`：必填，否则启动即报错（推送目标）。
- `RSS_FEEDS`：逗号分隔的真实 feed URL（**新闻链**，`url|vendor` 格式；留空则不采 RSS；三源全空会触发系统级故障告警、无内容可推）。
- `BLOGGER_FEEDS`：策划 AI 博主 feed（**经验链**，同 `url|vendor` 格式；留空则不采）。与 `RSS_FEEDS` 用途区分：`RSS_FEEDS` 走 `source='rss'`/`raw_type='news'` 的日报/告警新闻链追时效；`BLOGGER_FEEDS` 走 `source='blogger'`/`raw_type='experience'` 的独立经验链，经「经验提炼 Agent」沉淀可复用实战经验（≥70 价值闸入知识库 + 实践锦囊推送），两条链以两硬字段隔离、互不混入。`.env.example` 含「实战子集」示例，完整 49 源清单见 [`openspec/changes/add-ai-blogger-experience-mining/feeds.md`](./openspec/changes/add-ai-blogger-experience-mining/feeds.md)。
- `GITHUB_TOKEN`：可选，提升 GitHub API 速率上限（留空匿名调用受更严限流）。
- `TOP_N` / `RANK_WEIGHT_*` / `IMPORTANCE_FLOOR` / `DEGRADE_ABORT_RATIO` /
  `FIRST_SEEN_WINDOW_DAYS` / `PUSH_TIMEZONE`：均有默认值，按需覆盖。
- `DAILY_DIGEST_CRON`（默认 `0 8 * * *`）/ `DAILY_DIGEST_CRON_TZ`（默认 `Asia/Shanghai`）：定时触发时刻。

```bash
# A) 手动触发一次完整流水线（端到端冒烟，对应退出标准）：
npm run smoke              # 真实推送：用 grammY 真把当日 Top N 日报发到 TELEGRAM_CHAT_ID
npm run smoke -- --dry-run # 链路冒烟：不连 Telegram，把待发日报消息打到 stdout（验证链路不抛错）
# stdout 末尾输出结构化 artifact（"daily-workflow-smoke"，含 outcome / 各阶段降级统计）作可审计证据。

# B) 起常驻 worker：按 DAILY_DIGEST_CRON 每日定时触发日报（生产形态）
npm run worker             # 注册每日 cron 重复任务 + 启动 BullMQ worker；Ctrl-C 优雅退出
```

> **幂等与单例不变量**：同一 `push_date`（Asia/Shanghai 口径）由 Redis 全局单例锁保证只跑一个实例；
> 推送以 event 粒度走 `UNIQUE(target_type, target_id, channel, push_date)`，当天重跑「今日已 success」
> 的事件不再重发；带 `utm/ref/gclid/fbclid/spm` 的 URL 经归一为同一 `canonical_url` 塌缩为同一事件。
> 真实 Telegram 送达需真实凭据 + 外网，沙箱不可验证——`npm run smoke -- --dry-run` 已在本地 DB 上
> 验证非 Telegram 部分链路不抛错；真实送达请按上面前置在本地执行 `npm run smoke` 确认。

## P0 退出标准核对表

逐条对照 `bootstrap-walking-skeleton` 提案的退出标准。状态如实反映（实测 / 待人工），
手动验证步骤见 [`docs/verify-p0.md`](./docs/verify-p0.md)。

| # | 退出标准 | 状态 | 证据 / 备注 |
|---|---|---|---|
| 1 | compose 健康（pg + redis healthy） | ✅ 已验证 | 实跑 `docker compose up`，pg+redis 进入 healthy |
| 2 | migrate 落 3 表且幂等 | ✅ 已验证 | 对真实 pg 连跑两次，落 `raw_items`/`ai_news_events`/`push_records`，重跑不报错 |
| 3 | `push_records` 唯一约束就位 | ✅ 已验证 | `information_schema` 断言测试验证 `UNIQUE(target_type, target_id, channel, push_date)` |
| 4 | `/health` 通过 | ✅ 已验证 | 单测 + 实跑（双服务齐全返回 ok）；依赖不可达时如实反映 down |
| 5 | Zod 校验失败可观测 | ✅ 已验证 | 单测覆盖：记录日志 → 有限重试 → 仍失败则降级（不写库），不静默吞掉 |
| 6 | 一次**真实** generateObject + Zod 往返按映射落库读回 | ⏳ 待人工 | 往返代码 + mock-LLM 对真实 pg 落库往返已验证；仅缺真实 LLM 调用一次。**交付用户执行**，见下 |
| 7 | Actions 全绿 | ⏳ 待人工 | CI 已完整实现并本地验证（lint/typecheck/migrate/test 全绿，含 postgres+redis service）；需 push 分支触发。**交付用户执行**，见下 |
| 8 | Dependabot 激活 | ⏳ 待人工 | `.github/dependabot.yml` 覆盖 npm + github-actions；需在 GitHub 仓库确认已激活。**交付用户执行**，见下 |

### 交付用户执行（待人工项）

以下三项依赖真实凭据或 GitHub 侧操作，无法在本地无 key 环境完成，交付用户执行：

- **退出标准 6 — 真实 LLM 往返（对应任务 5.6）**：在带真实 OpenRouter key 的环境跑
  `npm run roundtrip`，把 stdout 输出的 `artifact: "value-judge-roundtrip"` JSON（含 `agentOutput`
  与落库读回的 `persistedEvent`）作为 PR artifact 附上。完整步骤见
  [`docs/verify-p0.md`](./docs/verify-p0.md)。
- **退出标准 7 — Actions 全绿（对应任务 6.5）**：推一个分支触发 `.github/workflows/ci.yml`，
  在 GitHub Actions 页确认 lint / typecheck / migrate / test 全绿。
- **退出标准 8 — Dependabot 激活（对应任务 6.5）**：在 GitHub 仓库 Settings → Code security
  确认 Dependabot 已读取 `.github/dependabot.yml` 并对 npm 与 github-actions 两个 ecosystem 生效。
