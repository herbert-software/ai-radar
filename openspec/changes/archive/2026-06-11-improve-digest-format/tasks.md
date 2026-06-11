## 1. 数据库 Schema（platform-foundation MODIFIED）

- [x] 1.1 `ai_news_events` 新增 `headline_zh text`（可空，forward-only）；`src/db/schema.ts` 加列 `headlineZh: text('headline_zh')`（统一命名：DB 列/schema 字段/迁移均 snake `headline_zh`，TS 侧属性 camel `headlineZh`，selectTopN/DigestOutcome/SelectedEvent 一致用 `headlineZh`）
- [x] 1.2 新增迁移 `0003_*`（当前迁移仅到 `0002`，下一个空号即 `0003`；不重写既有 0000/0001/0002）做 `ALTER TABLE ai_news_events ADD COLUMN headline_zh text`；实跑 `drizzle-kit migrate` + 复跑验证 journal 幂等

## 2. Digest Agent 产出一句话要点（chinese-digest-agent MODIFIED）

- [x] 2.1 `src/agents/digest/schema.ts` 输出 schema 新增 `headline_zh`（严格 `.trim().min(1).max(HEADLINE_MAX)`，`HEADLINE_MAX=80` 定为单一常量供 schema 与 prompt 共用、防两处漂移 + 既有 mojibake 守卫 refine），与 `summary_zh` 并存
- [x] 2.2 `src/agents/digest/index.ts` 提示词增加"同时给出一句话要点 headline_zh（含主体+动作+影响，≤80 字）"；保持同一次 generateObject 产出两字段、既有重试/降级不变
- [x] 2.3 落库：写库 `UPDATE ... WHERE event_id=?` 的 `set` 由 `{summary_zh}` 扩为 `{summary_zh, headline_zh}`；仍禁止覆盖身份/时间/代表/评分列
- [x] 2.5 **扩 `DigestOutcome` 的 summarized 分支带 `headlineZh: string`**（`src/agents/digest/persistence.ts`）：`digestEvent` 成功路径把 `summarizeEvent` 输出的 headline_zh 透传进返回值，供 run-daily 本轮新摘要分支直接取（否则本轮新事件 headlineZh 无处可拿、恒走回退、改造目标落空）
- [x] 2.6 把 `HEADLINE_MAX=80` 定为**单一导出常量**（放 `src/agents/digest/` 一处），schema `.max()` 与 prompt 文案共用同一常量，防两处漂移
- [x] 2.4 单测：schema 接受合法 headline_zh、拒绝超长/空/mojibake；落库 set 仅含 summary_zh+headline_zh；digestEvent summarized 返回值含 headlineZh

## 3. 消费链改造：把 headline_zh + 链接接到渲染（telegram-push MODIFIED）

> 落地链贯穿 5 处，缺一环则 headline 取不出/编译失败，必须逐项改：

- [x] 3.1 扩 `SelectedEvent` 接口（`src/selection/top-n.ts`）：新增 `headlineZh: string | null` 与 `canonicalUrl: string | null` 字段
- [x] 3.2 `selectTopN` 的 SELECT 子句加 `ai_news_events.headline_zh`（映射进 SelectedEvent.headlineZh）；`canonicalUrl` **不在 top-n 内 join**——selectTopN 构造 SelectedEvent 时显式置 `canonicalUrl: null` 占位（否则逐字段 map 缺该必填字段 tsc 失败），由 run-daily 在 §3.3 用既有 `loadCanonicalUrls`（经 `representative_raw_item_id` 回指 `raw_items.canonical_url`，已对全量 Top N 加载）map 覆盖填实值
- [x] 3.3 run-daily-workflow 构造 pushable 的**两处**显式补两字段：①已缓存跳过分支 `headlineZh: ev.headlineZh`（来自 selectTopN）；②本轮新摘要分支 `headlineZh: outcome.status === 'summarized' ? outcome.headlineZh : null`——**必须按 status 收窄**（与该 push site 既有 `summaryZh` 守卫同形）：`DigestOutcome` 仅 `summarized` 变体有 `headlineZh`，而新摘要 push site 是 `summarized | fallback` 共用块，直接写 `outcome.headlineZh` 会因 fallback 变体无此字段而 tsc 编译失败；fallback（摘要降级）分支置 `null`，交 message 回退链（§3.6）处理。两分支 `canonicalUrl: canonicalUrls.get(ev.eventId) ?? null`。不改推送状态机/幂等/待发集合/Top N
- [x] 3.4 `src/push/message.ts` 改签名读 `headlineZh`/`canonicalUrl`，渲染改为每条「序号 + 代表标题(粗体) + headline 一句话 + 原文可点击链接」，不再堆叠 summary_zh。**标题渲染期截断必须在 MarkdownV2 转义之前、按 Unicode code point（非 UTF-16 code unit，防中文/emoji 截半）截至 `TITLE_MAX`（定为单一常量，如 120）加省略号**——转义后再截断会切断 `\x` 转义序列留孤立 `\` 致发送失败
- [x] 3.5 **新增独立 URL 转义函数** `escapeMarkdownV2Url`（仅转义 `)` 与 `\`，**不复用** 18 字符文本转义器——后者会把 URL 里的 `. - _ =` 也加反斜杠破坏链接）；链接文本用既有 `escapeMarkdownV2`，URL 用新函数，组成 `[文本](url)`
- [x] 3.6 回退链（固定顺序）：headline_zh 缺失（旧事件/降级）→ `summary_zh` 截断前 ~80 字 → `representative_title` → 仅标题无要点；链接 canonical_url 缺失 → **不渲染链接**（仅标题+要点，本期不引入"源 URL"中间级，因 loadCanonicalUrls 不加载 raw_items.url）；均不报错、不阻塞整条日报
- [x] 3.7 保留既有截断兜底 + `[push] 消息截断` 告警 + 「只标实际发出 success、被截断保持 pending」语义不变；因 headline≤80 且标题渲染期截断，默认 Top N 常态不再命中截断

## 4. 测试

- [x] 4.1 单测：含特殊字符（`_ - . = ( )` 与字面反斜杠 `\`）的 canonical_url 经 `escapeMarkdownV2Url` 渲染为可点击链接（断言 URL 内 `)`/`\` 被转义、`. - _ =` **未**被加反斜杠）；链接文本经文本转义器转义；整条消息发送格式合法
- [x] 4.2 单测：headline 渲染；回退链逐级（headline 缺→summary 截断→标题→无要点）；canonical_url 缺失仅标题+要点不渲染链接
- [x] 4.3 单测/集成测：默认 `TOP_N`(8) 条**典型长度**（标题截断≤TITLE_MAX、要点≤80、常规 canonical_url）拼一条消息**不触发截断**（includedIds == 全部）；**另测一条超长原始标题在渲染期(转义前、按 code point)被截断、整条仍不超限**。注：URL 无硬长度上限，极端（超长 URL/全保留字符标题）仍可能触发既有截断兜底——这是有意保留的兜底，不在本断言范围；本断言只证"典型 Top N 一条装下"。推送幂等不变量（pushIdempotency）回归仍绿
- [x] 4.4 集成测：digest 落库 summary_zh + headline_zh 往返一致、不覆盖身份列；digestEvent summarized 返回 headlineZh 与落库值一致
- [x] 4.5 **更新既有测试夹具**：`SelectedEvent` 加 `headlineZh`/`canonicalUrl` 必填字段后，既有构造 SelectedEvent 的测试夹具（如 `src/push/__tests__/message.test.ts` 的 `ev()` 工厂、`dispatch.integration.test.ts`、`top-n` 测试）须补这两字段，否则 tsc/vitest 全红——与本变更同期改，保证全量绿

## 5. 收尾

- [x] 5.1 端到端冒烟（本地 docker-compose + 真实凭据）：手动触发一次，确认 Telegram 收到「短要点 + 链接」格式日报、全部 Top N 一条发出（无截断顺延）
- [x] 5.2 `tsc`/`eslint`/全量 `vitest` 全绿；README/.env.example（若加 headline 上限 env）更新
