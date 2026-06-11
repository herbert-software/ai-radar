## ADDED Requirements

### 需求:ai_news_events 承载日报一句话要点列

系统必须为 `ai_news_events` 提供 `headline_zh` 列（`text`，可空），承载中文摘要 Agent 产出的「一句话要点」，供 Telegram 日报渲染。该列由一次 forward-only 迁移 `ALTER TABLE ai_news_events ADD COLUMN headline_zh text` 添加（取当前下一个未用迁移序号 `0003`，不重写既有 0000/0001/0002）；`drizzle-kit migrate` 必须可重复执行幂等（journal 追加一条 entry、重跑跳过、结构无变化）。该列可空使旧事件（迁移前已落库、无要点）保持 `NULL`，由日报渲染层按固定顺序回退（`summary_zh` 截断 → `representative_title` → 仅标题），不阻塞。

> 本需求把 `headline_zh` 这一新增 schema 列归入 platform-foundation（schema 的单一事实来源），使「中文摘要 Agent 写 `ai_news_events.headline_zh`」与「schema 声明该列」一致，不产生"消费方要求某列但 schema 不声明"的断裂。

#### 场景:迁移添加 headline_zh 列且幂等
- **当** 对已落 P1 schema 的数据库执行新增迁移 `0003`，再次执行 `drizzle-kit migrate`
- **那么** `ai_news_events` 含可空 `headline_zh text` 列；第二次 migrate 被跳过、结构无变化、不报错

#### 场景:旧事件 headline_zh 为 NULL 不阻塞
- **当** 迁移前已存在的事件（`headline_zh` 为 NULL）进入当日 Top N
- **那么** 日报渲染按回退顺序取 `summary_zh` 截断/`representative_title`，不因 `headline_zh` 为 NULL 报错或漏推
