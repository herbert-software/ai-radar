## 新增需求

### 需求:结构化价值判断契约
系统必须提供 Value Judge Agent 雏形，对一条原始信息（`raw_item`）做结构化价值判断。该 Agent 必须通过 Vercel AI SDK 的 `generateObject` 调用 LLM，并以 Zod schema 约束输出。输出 schema 字段必须对齐 QA.md §10.4 的输出 JSON 定义，至少包含：是否 AI 相关（`is_ai_related`）、类型（`type`）、重点分类（`category`）、重要性（`importance`）、新颖性（`novelty`）、开发者相关性（`developer_relevance`）、炒作风险（`hype_risk`）、是否应推送（`should_push`）、理由（`reason`）。Agent 的输出必须是经 Zod 校验通过的结构化 JSON；禁止把判断结果以非结构化文本形式直接返回或入库。

本能力确立"所有 Agent 输出必须为结构化 JSON 并校验"的可复用契约，后续期次（P1）将在此之上扩展真实的判断逻辑与输入来源。

#### 场景:对原始信息产出经校验的结构化判断
- **当** 向 Value Judge Agent 输入一条 `raw_item`
- **那么** Agent 返回一个经 Zod schema 校验通过的对象，包含 `is_ai_related`、`type`、`category`、`importance`、`novelty`、`developer_relevance`、`hype_risk`、`should_push`、`reason` 等字段

### 需求:Agent 输出落库往返
系统必须把 Value Judge Agent 经校验的评分结果写入 `ai_news_events` 的对应评分列，并能从数据库读回，从而证明 Agent 的结构化输出可正确落库——而不仅是证明 LLM API 可调通。

Agent 输出字段（无 `_score` 后缀，对齐 QA.md §10.4）与 `ai_news_events` 列（带 `_score` 后缀，对齐 QA.md §8.2）**不同名**，系统必须显式做以下字段名映射后再写入，禁止假定同名直插：

| Agent 输出字段 | `ai_news_events` 列 |
|---|---|
| `importance` | `importance_score` |
| `novelty` | `novelty_score` |
| `developer_relevance` | `developer_relevance_score` |
| `hype_risk` | `hype_risk_score` |
| `should_push` | `should_push`（同名直写） |

#### 场景:评分结果按映射写入并可读回
- **当** Value Judge Agent 对 seed 的 `raw_item` 产出经校验的评分，系统按上表映射写入 `ai_news_events`
- **那么** 可从 `ai_news_events` 读回该条记录，各 `*_score` 列与 Agent 输出对应字段一致

### 需求:校验失败可观测
当 LLM 返回的结构不通过 Zod 校验时，系统禁止静默吞掉错误。系统必须以可观测的方式处理失败——记录错误日志，并采取重试或降级，而非假装成功或写入不完整数据。

#### 场景:输出不符 schema 时不静默成功
- **当** LLM 返回的结构无法通过 Zod 校验
- **那么** 系统记录错误日志并执行重试或降级，且不向 `ai_news_events` 写入未通过校验的数据
