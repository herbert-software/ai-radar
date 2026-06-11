## 为什么

P1（minimal-intel-pipeline）已端到端上线、真实推送到 Telegram 验证通过。但首次真实运行暴露了日报**输出格式**的体验问题：每条事件用数百字的完整中文摘要堆叠，8 条 Top N 拼成一条消息超过 Telegram 单条 ~4000 字上限被截断——实跑里只发出 6 条、2 条顺延到下次（虽因「保持 pending、跨天 never-success 重选」不丢失，但延迟、且日报臃肿难读）。用户希望改为「短消息 + 链接」形式：一眼能扫完、想深入再点链接。

（注：同次实跑发现的 summary_zh 偶发 mojibake 乱码是**编码正确性 bug**，已单独快修——digest/value-judge 输出加 mojibake 守卫→重试→降级；本提案只管**格式**，不重复。）

## 变更内容

- **digest 产出一句话要点（修改 chinese-digest-agent）**：在现有结构化输出里新增 `headline_zh`（一句话要点，约 ≤80 字），与既有 `summary_zh`（长摘要）并存。`headline_zh` 用于 Telegram 日报；`summary_zh` 长摘要保留（落库，供未来知识库 P3 / Web 控制台 P6 使用，本期不入消息）。两者均经 Zod 校验 + mojibake 守卫 + 重试/降级。
- **日报改短摘要 + 原文链接（修改 telegram-push）**：每条渲染为「序号 + 代表标题 + 一句话要点 + 原文可点击链接」，不再堆叠长摘要。链接取事件代表 `raw_item` 的 `canonical_url`（去追踪参数后的干净 URL；MarkdownV2 下用独立的 URL 转义规则渲染为可点击链接）；canonical_url 缺失则不渲染链接（本期不引入"源 URL"中间级）。
- **长度预算回归常态不截断**：`TOP_N`（默认 8）条「标题+一句话+链接」单条消息远低于 4000 字，**截断顺延从常态退化为极少触发的兜底**（截断逻辑与告警保留不变，只是几乎不再命中）。
- **Telegraph 全文页（可选，本期可延后）**：评估对长摘要价值高的条目生成 Telegraph 页、消息放 Telegraph 链接。倾向本期先做「一句话要点 + 原文链接」最小形态，Telegraph 列为可选/后续期次。

## 功能 (Capabilities)

### 新增功能
<!-- 无新增独立能力；均为对既有能力的格式/字段修改 -->

### 修改功能
- `platform-foundation`: `ai_news_events` 新增 `headline_zh text`（可空）列承载一句话要点，经一次 forward-only `ALTER ADD COLUMN` 迁移（序号 `0003`）添加。把该 schema 列归入 schema SOT，避免「digest 写该列但 schema 不声明」的断裂。
- `chinese-digest-agent`: 输出新增 `headline_zh`（一句话要点字段，严格 `.max(80)`），与 `summary_zh` 长摘要并存；二者均 Zod 校验 + mojibake 守卫 + 降级。`headline_zh` 供日报、`summary_zh` 落库留待 KB/Web。
- `telegram-push`: 日报消息渲染由「堆叠长 summary_zh」改为「代表标题（渲染期截断 ≤TITLE_MAX）+ headline_zh 一句话 + 原文可点击链接（URL 用独立转义规则，仅转 `)`/`\`）」；标题（渲染期截断）与要点（≤80）有界、canonical_url 无硬上界但典型较短，使 Top N **典型情形**一条装下、**极端**（超长 URL 等）走截断兜底（告警与「只标实际发出 success」语义保留，不宣称"绝不截断"）。**需配套消费链改造**（SelectedEvent 加 headlineZh/canonicalUrl、selectTopN SELECT headline_zh、run-daily 透传、message 读取——见 tasks §3）。

## 影响

- **数据库**：`ai_news_events` 需承载 `headline_zh`（新增列）——一次轻量 migration（ALTER ADD COLUMN，可空）。`summary_zh` 列保留不变。
- **代码**：digest schema/agent 产出 headline_zh；message.ts 渲染改 headline + link；run-daily 把 headline 透传给 message。push 状态机/幂等/Top N/塌缩**不动**。
- **配置**：可选新增 headline 长度上限 env；Telegraph 若做需 token（本期延后则不引入）。
- **依赖**：最小形态无新依赖（用现有 grammY MarkdownV2 + canonical_url）；Telegraph 若做需 HTTP 集成（延后）。
- **非目标（明确不做）**：不改去重/塌缩、价值评分、Top N 选择、调度、单例锁、推送幂等（push_records 四元组 + 待发集合 MINUS 今日 success 全部保留）；不把长摘要塞进消息；不引入图片/富媒体；Telegraph 全文页本期可不做（列为可选后续）。**确定性状态（幂等、唯一约束、Top N、截断兜底）仍由程序与 DB 保障，不交给 LLM；LLM 只多产出一句话要点这一语义字段。**
- **依赖前置**：本变更修改 `chinese-digest-agent` 与 `telegram-push` 两个能力，其主规格随 `minimal-intel-pipeline` 归档后进入 `openspec/specs/`。建议**先归档 minimal-intel-pipeline**，再 apply 本变更，使 MODIFIED 增量规格干净对齐主规格。
