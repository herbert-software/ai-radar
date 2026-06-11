# value-judge-agent 规范

## 目的
待定 - 由归档变更 bootstrap-walking-skeleton 创建。归档后请更新目的。
## 需求
### 需求:结构化价值判断契约

系统必须提供 Value Judge Agent，对一条原始信息（`raw_item`）做结构化价值判断。该 Agent 必须通过 Vercel AI SDK 的 `generateObject` 调用 LLM，并以 Zod schema 约束输出。输出 schema 字段必须对齐 QA.md §10.4 的输出 JSON 定义，至少包含：是否 AI 相关（`is_ai_related`）、类型（`type`）、重点分类（`category`）、重要性（`importance`）、新颖性（`novelty`）、开发者相关性（`developer_relevance`）、炒作风险（`hype_risk`）、是否应推送（`should_push`）、理由（`reason`）。Agent 的输出必须是经 Zod 校验通过的结构化 JSON；禁止把判断结果以非结构化文本形式直接返回或入库。

本期（P1）该 Agent 由 P0 的 seed 验证脚手架演进为流水线内对真实 `raw_item` 的逐条价值判断：输入来自采集/去重后的真实条目，而非 seed 假数据；其 `should_push` 与各项评分作为 Top N 选择的候选信号（最终推送名单与排序由程序决定，不由 Agent 决定）。

#### 场景:对真实 raw_item 产出经校验的结构化判断
- **当** 流水线向 Value Judge Agent 输入一条采集去重后的真实 `raw_item`
- **那么** Agent 返回一个经 Zod schema 校验通过的对象，包含 `is_ai_related`、`type`、`category`、`importance`、`novelty`、`developer_relevance`、`hype_risk`、`should_push`、`reason` 等字段

### 需求:Agent 输出落库往返

系统必须把 Value Judge Agent 经校验的评分结果写入 `ai_news_events` 的对应评分列，并能从数据库读回。Agent 输出字段（无 `_score` 后缀，对齐 QA.md §10.4）与 `ai_news_events` 列（带 `_score` 后缀，对齐 QA.md §8.2）**不同名**，系统必须显式做以下字段名映射后再写入，禁止假定同名直插：

| Agent 输出字段 | `ai_news_events` 列 |
|---|---|
| `importance` | `importance_score` |
| `novelty` | `novelty_score` |
| `developer_relevance` | `developer_relevance_score` |
| `hype_risk` | `hype_risk_score` |
| `should_push` | `should_push`（同名直写） |

本期评分必须写入由硬去重塌缩产生的真实事件行（以 `dedup_key` 经 `ON CONFLICT` 命中/创建的 `ai_news_events`），而非 P0 的 seed 行；P0 基于 `seed-<rawItemId>` 的落库脚手架被真实流水线替换。塌缩阶段先建事件行（DB 生成 `event_id`），Value Judge 阶段在其后对已存在行写分，故写分必须以 `UPDATE ... WHERE event_id = ?` 定位、`set` 中**仅含** `*_score` 与 `should_push` 列，禁止用 `INSERT ... ON CONFLICT` 模板或在 `set` 中带 `event_id`/`representative_raw_item_id`/`representative_title`/`first_seen_at`/`published_at`——否则会覆盖塌缩首建的身份与排序列。

#### 场景:评分按映射写入真实事件并可读回
- **当** Value Judge Agent 对一条去重塌缩后的真实事件产出经校验的评分，系统按上表映射写入 `ai_news_events`
- **那么** 可从 `ai_news_events` 读回该事件，各 `*_score` 列与 Agent 输出对应字段一致

### 需求:校验失败可观测
当 LLM 返回的结构不通过 Zod 校验时，系统禁止静默吞掉错误。系统必须以可观测的方式处理失败——记录错误日志，并采取重试或降级，而非假装成功或写入不完整数据。

#### 场景:输出不符 schema 时不静默成功
- **当** LLM 返回的结构无法通过 Zod 校验
- **那么** 系统记录错误日志并执行重试或降级，且不向 `ai_news_events` 写入未通过校验的数据

