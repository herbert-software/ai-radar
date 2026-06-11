## ADDED Requirements

### 需求:结构化中文摘要契约

系统必须提供中文摘要 Agent，为入选事件生成中文摘要。该 Agent 必须通过 Vercel AI SDK 的 `generateObject` 调用 LLM，并以 Zod schema 约束输出，输出必须包含中文摘要正文（`summary_zh`）等结构化字段。Agent 的输出必须是经 Zod 校验通过的结构化 JSON，校验通过后写入 `ai_news_events.summary_zh`；禁止把摘要以非结构化文本形式直接返回或入库。摘要写库必须以 `UPDATE ... WHERE event_id = ?` 定位、`set` 中**仅含** `summary_zh`，禁止用 `INSERT ... ON CONFLICT` 模板或覆盖塌缩首建的 `representative_title`/`representative_raw_item_id`/`first_seen_at`/`published_at`/`*_score` 列。

#### 场景:对事件产出经校验的中文摘要
- **当** 向中文摘要 Agent 输入一条待推送事件
- **那么** Agent 返回经 Zod 校验通过的对象，其 `summary_zh` 为中文摘要文本，并写入对应事件行

### 需求:摘要校验失败可观测且不污染推送

当 LLM 返回的摘要结构不通过 Zod 校验时，系统禁止静默吞掉。系统必须记录错误日志并执行有限重试；重试仍失败则降级——该事件回退使用塌缩首建写入的 `representative_title`（该列在塌缩首建时已写、非 NULL；极个别为空串时再兜底到 `canonical_url`）或被剔除出当日日报，绝不把未校验或半截输出推送给用户或写入 `summary_zh`。

#### 场景:摘要失败时降级不推半截输出
- **当** 某事件的摘要在有限重试后仍无法通过 Zod 校验
- **那么** 系统记录错误日志并降级（回退代表标题或剔除该事件），不向用户推送未校验内容
