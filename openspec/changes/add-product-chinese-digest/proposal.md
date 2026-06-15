## 为什么

日报「新品段」只渲染英文产品名 + 链接、无中文译名与简介，与「要闻段」（`chinese-digest-agent` 产 `headline_zh`/`summary_zh`、有中文标题 + 简介）体验割裂——用户报告新品段「没翻译也没简介」即此缺口。

根因（已诊断、**非 merge-products(PR #14) 回归**）：产品流水线从 P2 起就缺中文化步骤——`ai_products` 无中文列（仅 `name`=英文原名 / canonical_domain / github_repo / product_hunt_slug / metadata）；`selectProductCandidates` 显式 `representativeTitle=name`(英文)、`summaryZh=null`、`headlineZh=null`；`message.ts` 日报产品段「产品无 headline/summary → 不渲染要点行」是当时**有意决定**；`chinese-digest-agent` 只处理 events。merge-products 只是忠实反映「产品本就无中文数据」。

中文化输入已具备：Product Hunt 采集已存英文描述（`raw_items.content` = `description || tagline` 二选一，经 `representative_raw_item_id` 回指）；Show HN content 恒 null、退回描述性标题（stripShowHnPrefix 后的 name）。

## 变更内容

对齐要闻段，给产品补中文化（确定性编排 + Agent 语义 + DB 落库），守住「确定性状态归程序/DB、LLM 只产展示文本」：

1. **数据**：`ai_products` 加中文展示列 `name_zh` + `tagline_zh`（与 events 的 `headline_zh`/`summary_zh` 对称、独立 nullable 列；既有产品该列 NULL=未中文化、渲染回退英文 name），无破坏性迁移。
2. **中文化 Agent**（新能力内核）：输入产品 `name` + `raw_items.content`（PH=`description||tagline`、Show HN 恒 null 仅凭 name，经 `representative_raw_item_id` 回指），LLM `generateObject` 产 `{ name_zh, tagline_zh }`，**整对象 Zod 校验**（非空 / 长度上限 / mojibake，与 digest/schema.ts 同规），校验通过后 `UPDATE ai_products` **仅含**中文列（不碰塌缩/合并/状态列）。重试 + 错误日志；失败抛 `ProductDigestFailureError`、渲染回退英文 `name`、**不阻塞推送**。
3. **编排**：日报产品**候选选出前**（塌缩后、per-channel 候选前，channel-blind 一次），对各 channel 候选并集中 `name_zh IS NULL`（且非塌缩占位名）的产品跑中文化（**精确覆盖将推产品、零边缘**）；**已有 `name_zh` 的跳过 LLM（幂等缓存复用，同 events 复用 summary_zh/headline_zh 口径）**。编排零件对称 `collapseProductsOnce`（永不向上抛、失败不拖垮新闻），非 events digest 的 rethrow+熔断模型。
4. **渲染**：`renderDailyDigest` 产品段渲染 `name_zh`（回退 `name`）+ `tagline_zh` 要点行（无则省略要点、退纯标题）；MCP `get_today_ai_digest` 产品段输出加中文字段（忠实呈现、回退英文名）。

## 功能 (Capabilities)

### 新增功能
- `product-chinese-digest`: 产品中文化 Agent——对入选日报的产品用 LLM 生成中文译名 + 简介（结构化 JSON + Zod 校验 + 重试 + 错误日志），校验通过落 `ai_products` 中文列；幂等缓存复用、失败回退英文名不阻塞推送、绝不参与确定性状态判定。

### 修改功能
- `product-discovery`: `ai_products` 加中文展示列 `name_zh`/`tagline_zh`（nullable、无破坏迁移）；中文化作为「产品进入日报前」的确定性编排步骤纳入——**不改塌缩/硬规则合并/merge_conflict/selectProductCandidates 选品口径**，仅补中文展示字段。
- `daily-intel-pipeline`: 日报新品段渲染由「仅英文名 + 链接」改为「中文译名（回退英文名）+ 简介要点行（无则省略）」；产品中文化阶段编排进日报顺序（产品塌缩后、候选前，channel-blind），与要闻 chinese-digest 对称。
- `mcp-query`: `get_today_ai_digest` 产品段输出（structuredContent）增加中文译名 / 简介字段，忠实呈现已推内容、缺则回退英文名。

## 影响

- **数据**：`ai_products` 加 `name_zh` / `tagline_zh` 列（nullable、无破坏性迁移；既有产品 NULL → 渲染回退英文名）。
- **代码**：新增产品中文化 Agent（`src/agents/product-digest/` 或扩展 `src/agents/digest/`，design 定）；改 `src/pipeline/product-digest.ts`（selectProductCandidates 带中文列）、`src/pipeline/run-daily-workflow.ts`（编排中文化步骤）、`src/push/message.ts`（产品段渲染中文）、`src/mcp/tools/get-today.ts`（产品段中文字段）。
- **LLM**：新增产品中文化调用（按当批入选产品数；幂等缓存后稳态每产品仅一次），复用既有 `llm-client` + 重试。
- **主流程**：日报 worker 加一中文化阶段（产品塌缩后、候选前）；零影响 events 链路 / 告警 / 周报调度。**周报新品段不受益**：`selectWeeklyProducts` 是独立 SQL、不读中文列，本提案不改它 → 周报新品段仍英文（已知缺口，见非目标）。

## 非目标

- 不改产品塌缩 / 硬规则合并 / 去重 / merge_conflict 口径，不改推送幂等四元组，不改 `selectProductCandidates` 选品 / 排序规则（仅补中文展示字段）。
- **不把确定性状态（should_push / 推送状态 / 塌缩合并）交给 LLM**——中文化只产展示文本，失败回退英文名、不影响是否推送。
- 不对历史存量产品批量回填中文（仅新入日报候选的产品中文化；存量回填若需另议、且遵守时效性策略——上线后不批量补推旧产品）。
- 不引入新采集源、不建知识库 / 语义检索（P3）、不做产品评分。
- **周报新品段本期不中文化（已知缺口、非收益）**：`selectWeeklyProducts`（weekly-report.ts:304）是与 `selectProductCandidates` 独立的 SQL、不读中文列，本提案不改它 → 周报新品段实装后仍英文；对齐周报另立提案（对称改 selectWeeklyProducts 的 SELECT + 映射）。
