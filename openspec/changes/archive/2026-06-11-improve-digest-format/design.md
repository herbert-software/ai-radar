## 上下文

P1 日报当前把每条事件的完整中文摘要（`summary_zh`，数百字）堆叠成一条 Telegram 消息。真实运行 8 条 Top N 即超过单条 ~4000 字上限，触发截断（只发 6 条、2 条顺延）。`ai_news_events` 现有列：`representative_title`、`summary_zh`、`representative_raw_item_id`（回指代表 raw_item，其 `url`/`canonical_url` 是原文链接来源）。digest agent（`src/agents/digest`）经 generateObject 产出 `{summary_zh}`，已加 mojibake 守卫 + 重试/降级。message.ts 用 MarkdownV2 渲染、对全部 18 个 MarkdownV2 保留字符（外加反斜杠转义符）完整转义——但该转义器是**文本用**，链接 URL 需另一套规则（见 D3）。

## 目标 / 非目标

**目标：**
- 日报改为「每条：代表标题 + 一句话要点 + 原文可点击链接」，全部 Top N 常态一条消息装下、消除常态截断顺延，提升可读性。
- 长摘要 `summary_zh` 保留落库，供未来 KB（P3）/ Web（P6）。

**非目标：**
- 不改去重/塌缩、价值评分、Top N 选择、调度、单例锁、推送幂等（push_records 四元组 + 待发集合 MINUS 今日 success 全保留）。
- 不把长摘要塞进消息；不引入图片/富媒体。
- Telegraph 全文页本期可不做（列可选/后续）。

## 决策

### D1：digest 一次 LLM 调用产出 `{summary_zh, headline_zh}`，不新增第二个 Agent
**决策**：扩展现有 digest 的 Zod 输出 schema，新增 `headline_zh`（一句话要点，严格 `.trim().min(1).max(80)`，上限 80 定为单一常量 `HEADLINE_MAX` 供 schema 与 prompt 共用防漂移 + 既有 mojibake 守卫），与 `summary_zh` 并存，由**同一次** generateObject 产出。
**理由 / 替代**：另起一个"短摘要 Agent"会对每条事件多一次 LLM 调用（成本 / 延迟翻倍）。一次结构化输出同时要长摘要 + 一句话要点最省。两字段都走既有「Zod 校验 + mojibake 守卫 + 重试 + 降级」链路。

### D2：Telegram 用 headline_zh + 链接；summary_zh 落库不进消息
**决策**：日报每条渲染 = `序号 + 代表标题（粗体）+ 一句话要点 + 原文链接`。`summary_zh` 仍写入 `ai_news_events.summary_zh`（供 KB/Web），**不进消息**。
**理由**：消息只承载"扫一眼"信息，深入靠链接；长摘要的价值在沉淀/检索而非推送。

### D3：链接取 canonical_url，**独立的** URL 转义函数，缺失则不渲染链接
**决策**：链接 URL 取事件代表 raw_item 的 `canonical_url`（已去 utm/ref/gclid/fbclid/spm）；渲染为 MarkdownV2 内联链接 `[文本](url)`。**链接 URL 必须用一个独立的转义函数 `escapeMarkdownV2Url`（仅转义 `)` 与 `\`），不可复用现有 18 字符文本转义器** `escapeMarkdownV2`——后者会把 URL 里常见的 `.`/`-`/`_`/`=` 也加反斜杠，破坏 URL（点击跳错或发送失败）。链接文本（标题）仍用文本转义器。canonical_url 缺失时**不渲染链接、仅标题 + 要点**（本期不做"回退源 URL"中间级——run-daily 既有 `loadCanonicalUrls` 只加载 `canonical_url`、不加载 `raw_items.url`，加它会扩读路径；canonical_url 缺失多为 HN 文本帖，无链接可接受）。
**理由**：Telegram MarkdownV2 对**链接 URL** 与**普通文本**的转义规则不同（URL 内只转 `)`/`\`），混用文本转义器会破坏 URL——这是已知坑，须独立函数 + 单测覆盖含 `)` `\` `.` `-` 的 URL。

### D3b：消费链改造（headline_zh + canonical_url 必须贯通 5 处）
**决策**：headline 与链接要进消息，须改一条贯穿链：① `SelectedEvent` 接口加 `headlineZh: string|null` / `canonicalUrl: string|null` 字段；② `selectTopN` SELECT 加 `headline_zh`（映射进 headlineZh），并在逐字段构造 SelectedEvent 时**显式置 `canonicalUrl: null` 占位**（不 join raw_items，否则 map 缺必填字段 tsc 失败）；③ `canonicalUrl` 由 run-daily 用既有 `loadCanonicalUrls`（经 `representative_raw_item_id` 回指 raw_items，已对全量 Top N 加载）map 在构造 pushable 时**覆盖**占位 null；④ run-daily 构造 pushable 的**两处**透传——**已缓存分支 headlineZh 来自 selectTopN（`ev.headlineZh`）；本轮新摘要分支 headlineZh 来自 `DigestOutcome`，且必须按 status 收窄 `outcome.status === 'summarized' ? outcome.headlineZh : null`**（新摘要 push site 是 `summarized | fallback` 共用块，仅 summarized 变体有 headlineZh，无守卫直取会 tsc 失败；fallback 置 null 走渲染回退链）——故 `DigestOutcome` 的 summarized 分支必须扩出 `headlineZh` 字段、`digestEvent` 透传 `summarizeEvent` 输出（现状 DigestOutcome 不含 headline，不扩则本轮新事件 headlineZh 恒 null）；⑤ message.ts 改签名读这两字段。
**理由**：现状 `SelectedEvent` 仅 5 字段、`selectTopN` 不取 headline_zh、`DigestOutcome` 不返回 headline、pushable 不带链接——缺任一环则 headline 恒 null（改造对新事件首推落空）、链接恒缺、且 `tsc` 编译失败。此链（含 DigestOutcome 扩展与 selectTopN 占位 null）必须在 tasks 显式逐项覆盖；既有构造 SelectedEvent 的测试夹具也须同期补两字段。

### D4：长度预算使 Top N 常态一条装下，截断退化为兜底
**决策**：每条 = `序号 + 代表标题 + ≤80 字要点 + 链接`。`headline_zh` 有 `.max(HEADLINE_MAX=80)` 硬约束；`representative_title` 是裸 `text` 无上限，故 message 渲染时必须对标题做**渲染期截断**（按 Unicode code point 截至 `TITLE_MAX`——定为单一常量、如 120——加省略号，**且截断在 MarkdownV2 转义之前**：转义后截断会切断 `\x` 序列留孤立 `\` 致发送失败）。`TITLE_MAX` 与 `HEADLINE_MAX` 是有界项；**`canonical_url` 无硬长度上限（schema `text`），是预算里唯一无界项**——典型去追踪参数后的 URL 较短（~50–150 字），故 `TOP_N`（默认 8）条**典型**远低于 4000、一条装下；但极端（超长 URL 或全保留字符标题致转义膨胀）仍可能超限，由保留的 message.ts 截断兜底 + `[push] 消息截断` 告警 + 「只标实际发出 success、被截断保持 pending」语义处理。
**理由**：仅靠 headline≤80 不足——标题无上限是漏算项（review 抓出），补标题渲染期截断（且转义前、按 code point）。但 URL 无界，不能宣称「三者均有上界、绝不截断」；诚实表述为「典型一条装下，极端走兜底」，截断兜底正为此保留。

### D5：Telegraph 全文页 — 本期延后
**决策**：本期只做「一句话要点 + canonical_url 原文链接」最小形态。Telegraph（把 summary_zh 发布为页面、消息放 Telegraph 链接）列为可选后续——需 Telegraph API token + HTTP 集成，且原文链接已满足"深入"需求。
**理由**：最小形态即解决可读性 + 截断；Telegraph 是增量优化，不阻塞本期。

## 风险 / 权衡

- **[headline 质量]** 一句话要点可能过泛/丢关键信息。→ 缓解：prompt 明确要点应含主体+动作+影响；长摘要仍在库可对照；后续按真实数据调 prompt。
- **[headline 严格 80 拖累 summary 一起降级]** headline 与 summary 同一次 generateObject 产出、整对象 Zod 校验，headline 超 80 或 mojibake 会使整对象失败→重试→耗尽则连 summary 一起降级（比 P1 只校验 summary 时降级率略高）。→ 缓解：prompt 软约束 headline ≤80 降低触发；有限重试 + 降级回退 representative_title 兜底；可接受，记此权衡。
- **[MarkdownV2 链接转义]** URL 含 `)`、`_` 等会破坏链接渲染或发送失败。→ 缓解：链接文本与 URL 分别按 Telegram 规则转义，单测覆盖含 `() _ - = .` 的 URL。
- **[canonical_url 缺失]** 部分事件无干净 URL（HN 文本帖等）。→ 缓解：**不渲染链接、仅标题+要点**（本期不引入"源 URL"中间级，见 D3），不报错。
- **[既有 summary_zh 行]** 已落库的旧事件无 headline_zh。→ 本期 forward-only：新事件才产出 headline；推送渲染时 headline 缺失则回退用 summary_zh 截断前 80 字或代表标题。

## 迁移计划

- 一次轻量 migration `0003_*`（当前迁移仅到 `0002`——0000/0001/0002，下一个空号即 `0003`；不重写既有迁移）：`ALTER TABLE ai_news_events ADD COLUMN headline_zh text`（可空，forward-only，旧行为 NULL，渲染回退）。drizzle-kit migrate 幂等、journal 追加第 4 条 entry。此列归 `platform-foundation`（schema SOT），故本提案在 platform-foundation 下用 ADDED 增量追加一条「承载 headline_zh 列」需求声明该列。
- 无生产数据破坏（纯加列）。回滚 = drop column。

## 待解决问题

- `headline_zh` 字数上限定 80 还是按 Telegram 行宽调？实现期按真实渲染观感定，先 80。
- 链接放标题内联 `[标题](url)` 还是标题后单独「↗ 原文」？实现期按渲染观感定。
- 是否给"被截断顺延"的极少数情况也在消息尾部放一句"另有 N 条见下次"——已有，保留。
- Telegraph 是否进下一期：待本期最小形态上线观察后定。
