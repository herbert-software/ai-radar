## 1. 修改 1：HN 综合新闻流排除帖式前缀

- [x] 1.1 `src/collectors/types.ts` 新增导出纯函数 `isHackerNewsNonNewsPost(rawTitle: string | null | undefined): boolean` 与正则 `^\s*(show|ask|launch|tell)\s+hn\b`（行首锚定、大小写不敏感）；**对 null/undefined 入参返回 false**（不抛）；不改动既有导出。**加注释**说明本正则比 `show-hn.ts` 的 `SHOW_HN_PREFIX_RE` 宽（用 `\b` 不强制分隔符），二者刻意不同、勿"统一"
- [x] 1.2 `src/collectors/hacker-news.ts`：import `isHackerNewsNonNewsPost`，在 `collectHackerNews` settled 循环里 `mapHackerNewsItem` 之前按 `raw.title` 命中即记日志跳过；`mapHackerNewsItem` 签名/行为不变
- [x] 1.3 `collectors.test.ts` 新增用例：topstories 含 Show/Ask/Launch/Tell HN 各一条 + 普通新闻一条 → 仅普通条发射、跳过条记日志；并验证 `mapHackerNewsItem` 既有 'Show HN' fixture 断言不变（确认过滤在 collect 层、不动 map）
- [x] 1.4 新增 `isHackerNewsNonNewsPost` 纯函数 table 测试：4 前缀 × 各分隔符（`: - – —`/空白）命中、行首正文 "Show HN" 不误命中、`"Show HNx"`（无词边界）不误命中、空字符串/null/undefined 返回 false

## 2. 修改 2：要闻段↔新品段跨段去重抑制

- [x] 2.1 新建 `src/selection/cross-segment-dedup.ts`：导出**纯函数**（**不 import `collectors/*`**，入参为已提取的键）`suppressEventsInProducts(eventsWithKeys, productKeySets)` —— `eventsWithKeys: Array<{event, keys:{canonicalDomain,githubRepo,productHuntSlug}}>`、`productKeySets:{domains:Set, repos:Set, slugs:Set}`；事件任一非空键命中对应集合即剔；返回 `{ kept, suppressedEventIds }`。键提取（调 `extractProductMergeKeys`）由 2.3 的编排层做。**新增导出命名常量 `PLATFORM_HOSTS` denylist**（判据=**URL 路径而非子域标识产品**的平台 host：`github.com`/`producthunt.com`/`gitlab.com`/`gitee.com`/`bitbucket.org`/`codeberg.org`/`sourceforge.net`/`npmjs.com`/`pypi.org`/`crates.io`/`huggingface.co`；子域标识的 PaaS 如 `*.vercel.app`/`*.github.io` 不入，子域本是唯一身份），带注释「新增产品源若无 website 兜底 URL host 是平台 host MUST 加入」；并在 `PRODUCT_SOURCES`（`src/collectors/index.ts`）处加一行**回引注释**指向 `PLATFORM_HOSTS`（使新增产品源的作者在编辑处即见此义务）；构建产品 `domains` 集合时剔除其中的 host
- [x] 2.2 `src/selection/__tests__/cross-segment-dedup.test.ts`：① `canonical_domain` 命中剔除（grassdx 类）；② `github_repo` 命中剔除（github 直链类）；③ **github 来源要闻不被 mass 误抑制**——事件键 `{domain:null, repo:'aaa/bbb'}` vs 产品集 `{repos:{'ccc/ddd'}}` → 保留（关键回归，防 round-1 blocker）；④ **平台 host 不致误抑制**——产品域集构建排除 `PLATFORM_HOSTS` 后，事件 `{domain:'producthunt.com'}`（及 `gitlab.com` 等任一 denylist host）vs 含该域的产品 → 保留（防 round-2/3 平台 host mass 误抑制）；⑤ `product_hunt_slug` 命中剔除；⑥ 三键全不命中 → 保留；⑦ 事件 url 为 null/无键 → 保留；⑧ 产品集全空 → 全保留
- [x] 2.3 `src/pipeline/run-daily-workflow.ts`：算出 `productsByChannel` 之后、早退判断之前——(a) 对每个 `pushable` 事件用 `canonicalUrls.get(eventId)` 调 `extractProductMergeKeys({url})` 提三键（import 自 `../collectors/product-keys.js`，纯 leaf）；(b) 对全通道产品候选并集，从**候选携带的存储三键字段**（task 3.2 让候选带 `productMergeKeys`，**非** `resolveProductUrl` 渲染的 `canonicalUrl`；**域集构建 MUST 用命名常量 `PLATFORM_HOSTS`（见 2.1）排除全部平台 host，禁止内联只排 2 个**。注：**事件侧键不做 `PLATFORM_HOSTS` 擦洗**——事件键是 `extractProductMergeKeys({url})` 原样输出，安全性来自产品域集排除，见 daily-intel spec）构 `productKeySets:{domains,repos,slugs}`；(c) `suppressEventsInProducts(eventsWithKeys, productKeySets)` 得 `pushableDeduped`；后续**早退判断与 dispatch 全改用 `pushableDeduped`**；记 `suppressedEventIds` 日志
- [x] 2.4 **幂等 + 唯一约束验证**（集成测）：seed 一事件其代表 raw_item `canonical_url` 域 = 某产品 `canonical_domain` → 断言要闻段不含该事件、**该 event 无 `push_records` 行写入**（不写 `event` 命名空间）、新品段含该产品且产品按 `target_type='product'` 正常写 `push_records`（`UNIQUE(target_type,target_id,channel,push_date)` 不冲突）
- [x] 2.5 **跨天候选资格 + 早退 + Model B 验证**（集成测）：① 被剔事件次日在「产品不再是候选」时仍满足「未投递所有通道」窗口、可正常进要闻段推送（无永久漏推）；表头 `要闻 X` 取抑制后实发数；② 全要闻段被抑制 + 新品非空 → 按 `pushableDeduped` 不早退、只推新品段；③ 产品仅 telegram 候选时，channel-blind 要闻段对该事件的抑制对两通道一致（并集口径）

## 3. 修改 3：产品官网链接回退链

- [x] 3.1 在 **`src/collectors/product-keys.ts`**（既有零 env/db 纯 leaf）新增导出**纯函数** `resolveProductUrl(canonical_domain, github_repo, product_hunt_slug)`（push 与 MCP 查询链均 import 它；**MUST NOT** 放 `mcp/lib/`——否则 push 反向依赖 mcp/）：`canonical_domain`（沿用既有畸形校验）→ `https://github.com/<owner>/<name>`（`github_repo` 恰两段非空，否则落下一级）→ `https://www.producthunt.com/posts/<slug>`（slug **含 `/` 或空白即判畸形、落下一级**，不 `%2F` 编码后强拼；通过则直接拼）→ 皆空/畸形 null
- [x] 3.2 `selectProductCandidates` 的 SELECT 增 `github_repo`/`product_hunt_slug` 两列；映射 `canonicalUrl = resolveProductUrl(...)` 取代仅 `canonical_domain` 派生；**并让每个产品候选额外携带存储三键 `productMergeKeys:{canonicalDomain,githubRepo,productHuntSlug}`**（供 task 2.3 跨段对齐从内存读、不回查 DB）。载体类型 = `SelectedEvent`（`src/selection/top-n.ts` 导出、产品候选复用之）上加**可选** `productMergeKeys?` 字段，**事件侧候选不填**（与既有 `headlineZh` 复用为产品 tagline 等 product-only 复用同范式）；`message.ts` 不改
- [x] 3.2b （可选 DRY）`canonical_domain→URL` 严格校验当前在 `product-digest`/`mcp/lib/canonical-url.ts(productCanonicalUrl)` 各有一份；`resolveProductUrl` 的 step① 落地后，宜让 `productCanonicalUrl(domain)` 委托 `resolveProductUrl(domain,null,null)`（或加注释标注「域校验单一 SOT 在 product-keys、canonical-url 须同步」），避免 search 与 get_today 的域校验谓词漂移
- [x] 3.3 `resolveProductUrl` 纯函数单测：三级回退各命中、畸形/含斜杠/空白降级、三键全空 → null
- [x] 3.4 `product-digest.integration.test.ts`：seed `canonical_domain=NULL, github_repo='owner/repo'` → 候选 `canonicalUrl='https://github.com/owner/repo'`；seed 仅 `product_hunt_slug='foo'` → `https://www.producthunt.com/posts/foo`
- [x] 3.5 **MCP get_today 忠实还原同步（仅 get_today，不动 search_products）**：`src/mcp/tools/get-today.ts` 产品链接改用 `src/collectors/product-keys.ts` 的 `resolveProductUrl`，其 product 查询 SELECT 须增取 `github_repo`/`product_hunt_slug`；核查 MCP top-level import 该纯函数不触全局 env（守 stdio/env 纪律）。**`search-products.ts` 与 `mcp/lib/canonical-url.ts` 的 `productCanonicalUrl` 不动**（历史检索无忠实义务、保留 canonical_domain-only）。`src/mcp/__tests__` 加用例：已推 github-only 产品（`canonical_domain=NULL, github_repo` 有值）→ get_today 还原出 `https://github.com/...` 链接（与已推一致，不丢链接）

## 4. 回归与验收

- [x] 4.1 `npm run typecheck`（或 tsc）+ lint 通过
- [x] 4.2 全量 `vitest` 通过（含新增用例）；确认测试不触发真实推送（沿用 VITEST 守卫 / sender mock）
- [ ] 4.3 本地 smoke（`npm run smoke` 或等价）跑一次日报流程：人工核对要闻段不含 Show/Ask/Launch/Tell HN、无要闻↔新品同项目重复、github 类产品有官网链接 ——【需用户在受控环境跑：需 Postgres/Redis/真实凭据，会触发真实日报推送，编排器不自动执行】

## 5. 规格同步与历史行处置

- [ ] 5.1 `openspec-cn validate` 通过；`/opsx:apply` 完成后 `/opsx:archive` 同步增量 spec 进主规范。**归档核查**：MODIFIED 块（mcp-query「查询当日已推日报」、source-collectors「Show HN 产品采集」、product-discovery「每日产品发现推送」）须**整块替换**主规范对应需求（含被改名/拆分的场景，如 mcp-query「畸形域降级一致」→「三键回退一致」+「畸形降级与已推一致」），确认不残留旧场景
- [ ] 5.2 历史泄漏行决策：默认不主动清理（靠时效窗自然老化）；部署后观察一两天，若仍见要闻段残留 Show HN 才由用户人工执行 design.md 的一次性 `should_push=false` SQL（只读核对命中行数后执行，**不用** `merged_into`）。**已知局限**：该 SQL 按 `representative_title` 匹配前缀，而塌缩可能选了同簇非 Show-HN 标题作 representative，故对这类行会 under-match——属可接受（opt-in、bounded、非破坏）
