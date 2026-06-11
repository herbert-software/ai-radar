## MODIFIED Requirements

### 需求:结构化中文摘要契约

系统必须提供中文摘要 Agent，为入选事件生成中文摘要。该 Agent 必须通过 Vercel AI SDK 的 `generateObject` 调用 LLM，并以 Zod schema 约束输出。输出必须在**同一次调用**中同时包含两个字段：`summary_zh`（完整中文摘要正文，落库供知识库/Web 等后续用途）与 `headline_zh`（一句话要点，供 Telegram 日报渲染；长度严格受 Zod `.trim().min(1).max(80)` 约束，80 为单一常量供 schema 与 prompt 共用）。两字段均必须经 Zod 校验通过、且通过 mojibake 守卫（检出 UTF-8-被当-Latin-1 的乱码即视为校验失败走重试），校验通过后分别写入 `ai_news_events.summary_zh` 与 `ai_news_events.headline_zh`；禁止把摘要以非结构化文本形式直接返回或入库。摘要写库必须以 `UPDATE ... WHERE event_id = ?` 定位、`set` 中**仅含** `summary_zh` 与 `headline_zh`，禁止用 `INSERT ... ON CONFLICT` 模板或覆盖塌缩首建的 `representative_title`/`representative_raw_item_id`/`first_seen_at`/`published_at`/`*_score` 列。

#### 场景:对事件产出经校验的长摘要与一句话要点
- **当** 向中文摘要 Agent 输入一条待推送事件
- **那么** Agent 返回经 Zod 校验通过的对象，含 `summary_zh`（长摘要）与 `headline_zh`（≤80 字一句话要点），二者写入对应事件行的 `summary_zh` 与 `headline_zh` 列

#### 场景:headline 与 summary 均受 mojibake 守卫
- **当** LLM 返回的 `summary_zh` 或 `headline_zh` 含 mojibake 乱码
- **那么** 该输出视为校验失败，走有限重试；重试仍乱码则降级，绝不把乱码写入任一列或推送

### 需求:摘要校验失败可观测且不污染推送

当 LLM 返回的摘要结构不通过 Zod 校验（含 mojibake 守卫命中）时，系统禁止静默吞掉。系统必须记录错误日志并执行有限重试；重试仍失败则降级——该事件回退使用塌缩首建写入的 `representative_title`（该列在塌缩首建时已写、非 NULL；极个别为空串时再兜底到 `canonical_url`）或被剔除出当日日报，绝不把未校验或半截输出推送给用户或写入 `summary_zh`/`headline_zh`。

#### 场景:摘要失败时降级不推半截输出
- **当** 某事件的摘要在有限重试后仍无法通过 Zod 校验
- **那么** 系统记录错误日志并降级（回退代表标题或剔除该事件），不向用户推送未校验内容
