## 上下文

日报「要闻」与「新品」两段会把同一项目推两遍。生产实例（ts.mac-mini）只读核验实锤：

- `raw_items` 同一 HN item id `48544823` / URL `grassdx.com` 被两源各收一行：`source='hacker_news'`/`raw_type='post'`（"Show HN: Vet turned founder, AI lawn diagnosis"）与 `source='show_hn'`/`raw_type='product'`（剥前缀后）。
- 前者进 `ai_news_events`（`should_push=t` → 要闻段），后者进 `ai_products`（`canonical_domain=grassdx.com` → 新品段）。
- `ai_news_events` 当前积压 ≥10 条 "Show HN:" 事件，污染要闻候选池，且均 `should_push=t`。
- 独立缺陷：`ai_products` 中 `themartiano/luz`（`canonical_domain` 空、仅 `github_repo`）在新品段无官网链接。

三层根因叠加：① `hacker-news.ts` 抓 HN topstories（首页热门含 Show HN）不过滤帖式前缀 → Show HN 以 news 进要闻；② `(source, source_item_id)` 命名空间 `hacker_news` ≠ `show_hn`（既有设计刻意分离，避免 ON CONFLICT 互覆），同一 HN id 的唯一约束拦不住；③ `ai_news_events` 与 `ai_products` 分表去重、无跨表去重，双段重复无法被发现。

约束：守第一架构原则（去重/幂等由程序与 DB 保障，绝不交给 LLM）；不改 schema、不加迁移；不破坏 Model B（channel-blind 单份 Top N 发放所有通道）与既有推送幂等。

## 目标 / 非目标

**目标：**
- 要闻段不再混入 Show/Ask/Launch/Tell HN 帖（采集期源身份净化）。
- 同一项目不再同时出现在要闻段与新品段（装配期确定性跨段去重兜底）。
- 纯 GitHub 仓库 / PH 类产品在新品段补全官网链接。
- 全程确定性键，无 LLM 参与跨段判定。

**非目标：**
- 不引入语义/embedding 做跨段去重。
- 不改 `raw_items`/`ai_news_events`/`ai_products` schema、不加迁移。
- 不动 `show-hn.ts` 的 `stripShowHnPrefix`（已被测试锁定）、不改 `message.ts` 渲染层。
- 不对历史泄漏行做物理删除或语义合并 tombstone（`merged_into`）。
- 不调整 Value Judge 评分维度/阈值。

## 决策

**D1：HN 帖式前缀过滤放 `collectHackerNews` 循环，不放 `mapHackerNewsItem`。**
`mapHackerNewsItem` 是导出纯函数、被 `collectors.test.ts` 直接调用且 fixture 含 `'Show HN'`；改其签名（`CollectedItem` → `… | null`）会破测试并污染映射职责。改在 `collectHackerNews` 的 settled 循环里、`mapHackerNewsItem` 之前按 `raw.title` 行首前缀跳过，与 `show-hn.ts` 把跳过判定放在 `collectShowHn`（而非 `mapShowHnHit`）同范式。
- 备选：依赖下游 Value Judge `should_push` 闸 —— **否决**，运行数据证明 10 条 Show HN 都拿到 `should_push=t`，语义闸兜不住。
- 备选：用 HN `item.type` 区分 —— **否决**，Show/Ask HN 的 `type` 都是 `story`，不可区分；必须按 title 前缀。

**D2：前缀识别共享纯函数放 `src/collectors/types.ts`。**
`types.ts` 已是三源共享、零 DB、零 env 的横切模块（hacker-news.ts 已 import 它）。新增 `isHackerNewsNonNewsPost(rawTitle)`，正则 `^\s*(show|ask|launch|tell)\s+hn\b`（行首锚定、大小写不敏感）。
- 备选：放 `product-keys.ts` —— 否决（领域是产品归一键，不搭）。
- 备选：hacker-news.ts 反向 import show-hn.ts 的 `SHOW_HN_PREFIX_RE` —— 否决（综合新闻采集器依赖产品采集器是层次倒置；且 show-hn 只认 Show HN 一种前缀）。

**D3：跨段去重对齐键 = 产品归一三键组（复用 `extractProductMergeKeys`），不是渲染域。抑制要闻段、保留新品段。**
两表无共享键，但二者都能经同一确定性键提取对齐。**关键修正（review round 1 blocker）**：早先设计用「规范化域」对齐，且产品侧从 `selectProductCandidates` 渲染的 `canonicalUrl` 提域——但修改 3 让 github-only 产品的 `canonicalUrl=https://github.com/owner/repo`、PH-only 的 `=producthunt.com/posts/slug`，提域得 `github.com`/`producthunt.com`；而 github 采集器产 `raw_type='repo'`、`canonical_url` host=`github.com`、经新闻塌缩进 `ai_news_events`，于是**每个 github 来源要闻都会被 `github.com` 域 mass 误抑制**。故改为：**两侧都经 `extractProductMergeKeys` 提三键组**（要闻侧从事件 `canonical_url`，产品侧用 `ai_products` 存储的 `canonical_domain`/`github_repo`/`product_hunt_slug` 字段、**非**渲染 `canonicalUrl`），任一非空键命中即抑制。`extractProductMergeKeys` 两侧一致地把 `github.com` 域置 null、改由 `github_repo` 精确对齐 → 既消除 mass 误抑制，又**顺带闭合** github 直链 news↔product 双段重复。grassdx 走 `canonical_domain` 命中。**平台 host 域 MUST 排除——一类缺陷而非两特例**（round 2→3 发现）：`extractProductMergeKeys` 只 null `github.com`；无 website 的 Show HN/PH 产品其 raw_item `url`=提交的平台 URL → 存储 `canonical_domain` 落成平台 host（PH→`producthunt.com`、gitlab 仓库→`gitlab.com`、npm 包→`npmjs.com`…）。任一平台 host 的要闻会被 mass 误抑制（与 round 1 `github.com`、round 2 `producthunt.com` 同类）。修法：抑制构建产品**域集**时剔除**命名常量 denylist** `PLATFORM_HOSTS`（`github.com`〔已 null〕/`producthunt.com`/`gitlab.com`/`gitee.com`/`bitbucket.org`/`codeberg.org`/`sourceforge.net`/`npmjs.com`/`pypi.org`/`crates.io`/`huggingface.co`），并注释「新增产品源若兜底 URL host 是平台 host MUST 加入」使耦合显式。**判据（避免误列）**：denylist 只收「**URL 路径**（而非子域）标识产品」的平台 host（`github.com/owner/repo`、`npmjs.com/package/x`、`producthunt.com/posts/slug`…）；**子域标识产品**的 PaaS（`myapp.vercel.app`/`x.github.io`/`x.netlify.app`）**不入** denylist——因 `extractCanonicalDomain` 取完整 host，`a.github.io ≠ b.github.io`，子域本就是产品唯一身份、不会撞域。所有 host 引用 MUST 指向该命名常量、不在调用点内联子集。**残留（accepted）**：denylist 不可证完备，未列入的平台 host 仍 bounded 误抑制（少推若干要闻、非破坏）；根治需产品塌缩按 website-vs-fallback 来源区分 canonical_domain（触及塌缩写入路径、超本次范围）。不在 `extractProductMergeKeys` 内 null 这些（会牵动产品塌缩既有合并行为）——仅在抑制域集构建处排除。
- 备选：「规范化域 + 产品 `canonicalUrl` 提域」—— **否决**（上述 blocker）。
- 备选：「规范化域 + 产品 `canonical_domain` 字段提域」—— 可消除 mass 误抑制，但仍漏 github 直链双段重复（产品 `canonical_domain` 为 null、域键永不命中）；三键组在同等成本下一并闭合，更完整。
- 备选：在 collapse/dedup 层做跨表去重 —— 否决（collapse 是 raw_items→事件/产品的塌缩，跨段重复是装配期问题，层次不符）。

**D4：用全通道新品候选并集（三键集合）剔一份 channel-blind 要闻段；被剔事件不写 push_record；`pushableDeduped` 同喂早退与 dispatch。**
要闻段 `pushable` 是 channel-blind 单份（Model B），不能按单通道产品候选分别剔（破坏单份语义）。用 `productsByChannel` 各通道候选并集的三键集合剔一次得 `pushableDeduped`。被剔事件不写 `event` push_record（dispatcher 的 `computePendingSet` 只对入参事件算待发，故剔出即不写）→ 跨天候选资格保留 → 次日不再被产品覆盖即回要闻段，无永久漏推。`pushableDeduped` **同时**喂早退判断（防「全要闻被抑制 + 新品非空」时误早退）与 dispatch；表头 `要闻 X` 取 dispatch 后 `eventIncludedIds.length`、自然为抑制后数。位置：`productsByChannel` 之后、早退之前；运行于摘要循环之后（此时 `canonicalUrls`/`productsByChannel` 才齐备，被剔事件已耗的少量摘要 LLM 调用为可接受浪费）。
- **并集 vs 交集（accepted 权衡）**：并集会在「产品 P 仅 telegram 候选、同项目要闻 E 尚缺 feishu」时把 E 从 channel-blind 段剔除，致 feishu 当天两段皆无 E/P；但交集会在 telegram 留下 E+P 双段重复（即本提案要消灭的 bug）。选并集（防重复）+ E 不写 push_record（P 一生一次、success 后离开候选 → E 恢复）。**恢复有界（round 2 精确化）**：恢复以「P 清出候选 且 E 仍在 `FIRST_SEEN_WINDOW_DAYS` 时效窗内」为条件，通常 ≤1 天；若某通道持续 failed/pending 致 P 长期留候选，E 随之被持续抑制——但那本就是通道不可用期（该通道也投不出 E），非本抑制新增的丢失，非永久漏推反例。
- 备选：按 channel 分别剔 —— 否决（破坏 Model B 单份、实现复杂、与 push_records per-channel 幂等纠缠）。
- **layering（round 2 精确化）**：键比对纯函数放 `src/selection/cross-segment-dedup.ts`，**入参为已提取的键**、自身不 import `collectors/*`（不给 selection 层新增 collectors 依赖边）。**产品侧键无需现提取**——由 `selectProductCandidates` 让候选携带其存储三键（SELECT 已读，见 D5 + product-discovery「候选载体」），编排层从内存 `productsByChannel` 候选对象直接读、不回查 DB。**事件侧键现提取**——`run-daily-workflow.ts` 对每个 `pushable` 事件调 `extractProductMergeKeys({url})`；run-daily **已 import `collectAndStore`（`collectors/index`）** → pipeline→collectors 边已存在，`extractProductMergeKeys`（`collectors/product-keys`，零 DB/env 纯 leaf）为同向良性 import。（修正 round 1 笔误「run-daily 已 import product-collapse」——实际经 `collectors/index` 与 `./product-digest`，但 collectors 边确已存在。）

**D5：产品官网链接回退链 = 共享纯函数 `resolveProductUrl`，放 `src/collectors/product-keys.ts`，push 与 MCP get_today 共用一份。**
新增导出**纯函数** `resolveProductUrl(canonical_domain, github_repo, product_hunt_slug)` 按 `canonical_domain`→`github.com/owner/repo`→`producthunt.com/posts/slug` 回退，畸形落下一级、皆空 null；slug 含 `/` 或空白 = 畸形、落下一级（不 `%2F` 编码后强拼）。`selectProductCandidates` 用它产 `canonicalUrl`（SELECT 增 `github_repo`/`product_hunt_slug`）；`message.ts` 渲染层不改（只认 `canonicalUrl`）。
- **放置（round 4 定址）**：`resolveProductUrl` MUST 放 **`src/collectors/product-keys.ts`**——它已是零 `../db`/零 `../config/env` 纯 leaf（`extractProductMergeKeys`/`extractCanonicalDomain` 的同胞、由产品塌缩与采集器共用），是「产品键↔URL」纯派生的自然归属。这样 push（`product-digest` import collectors/product-keys，边已存在）与 MCP（`get-today.ts` import collectors/product-keys；MCP server.ts 的 top-level 禁 import 清单是 dispatcher/push-date/top-n/telegram/feishu，**不含 collectors**，纯 leaf 不触全局 env）都能 import，且 **push 不反向依赖 `mcp/`**。**MUST NOT** 放 `src/mcp/lib/canonical-url.ts`（会逼 product-digest 反向 import mcp/）。
- **MCP 一致性（round 3 发现，必须同步）**：mcp-query 的 `get_today_ai_digest` 要求「product 链接忠实于实际已推内容」，现用仅认 `canonical_domain` 的 `productCanonicalUrl`；push 改回退链后 github-only/PH-only 产品会「推时有链接、查时无链接」。故 **`get_today_ai_digest` 产品链接 MUST 改用 `resolveProductUrl`**（本变更新增 `mcp-query` MODIFIED 增量）。**`search_ai_products` 不在本次范围**：它是历史检索、无「忠实于已推」义务，**保留既有 `productCanonicalUrl`（canonical_domain-only）不动**——故 `productCanonicalUrl` 不删除、`mcp/lib/canonical-url.ts` 保留。get_today 与 search 的链接口径差异（前者三键回退、后者仅域）是「忠实还原 vs 通用检索」两契约的合理差异。
- **与 D3 的交互（已解决）**：`resolveProductUrl` 仅供**渲染/还原**用，跨段抑制（D3）**不**取它产出的 `canonicalUrl`、改取 `ai_products` 存储三键字段（域集排平台 host），故回退链引入的平台 host 渲染域不污染抑制键。

**D6：历史泄漏行靠时效窗自然老化，不主动清理。**
Top N 候选按 `published_at` 时效窗 + 「未投递所有通道」过滤，旧 Show HN 事件自然退出候选；已推过的已写 success 退出。仅「窗内+未推完+对应产品已跨天推完」的极少数会再被推一次。彻底干净可选一次性 SQL 把命中前缀的事件置 `should_push=false`（人工执行）。
- 否决用 `merged_into`：那是语义合并 tombstone 专用语义（须指向存活 event_id），误用会让 collapse 的 tombstone 改投逻辑异常。

## 风险 / 权衡

- [前缀过滤误伤真新闻] → 正则 `^\s*` 仅锚行首，正文含 "Show HN" 不误排；HN 非要闻段权威源（官方 blog/RSS 优先），残余误伤可接受。
- [过滤后某天要闻候选不足] → 符合既有 `IMPORTANCE_FLOOR` 宁缺勿凑；要闻主力是 RSS 大厂官方/sitemap/GitHub，HN 帖式帖本不该撑要闻。
- [github 来源要闻被 github.com 域 mass 误抑制]（round 1 blocker，已解决）→ 对齐改用 `extractProductMergeKeys` 三键组，两侧 `github.com` 域置 null、改由 `github_repo` 精确对齐，github 要闻不再撞 `github.com`。
- [producthunt.com 域致误抑制]（round 2 发现，已解决）→ 无 website PH 产品存储 `canonical_domain='producthunt.com'`（`extractProductMergeKeys` 不 null 它）；抑制构建产品域集时显式排除平台 host `producthunt.com`，PH 走 slug 对齐；producthunt.com host 的要闻不被误抑制。
- [github 直链闭合依赖产品存储键已填充]（accepted，best-effort）→ 产品塌缩 UPDATE 命中既有行时只更 `lastSeenAt` 等、不回填后出现的新键（pre-existing 行为）；若某产品首见无 `github_repo`、后见才有，存储键仍旧 → 该产品的 github 直链闭合 best-effort（不影响正确性、不误抑制，仅少闭合一例）。回填属产品塌缩独立议题、非本变更范围。
- [厂商同 `canonical_domain` 下真实要闻被产品域键误剔]（accepted）→ 域级对齐的固有假阳性；确定性手段无法区分「同项目冗余」与「同域异内容」（语义区分被第一架构原则禁），后果仅「少推一条要闻、新品段仍在」、非数据损坏。
- [共享同一完整 host 的不同产品互撞]（accepted，bounded）→ `extractCanonicalDomain` 取完整 host（非 eTLD+1），`a.github.io` ≠ `b.github.io`，PaaS 子域天然不撞；仅同一裸 host 才撞、极罕见。
- [Model B 并集 + channel-blind 致要闻在某通道延迟]（accepted）→ 见 D4：选并集防双段重复，被剔事件不写 push_record，恢复以「产品清出候选 且 事件仍在时效窗」为界（通常 ≤1 天）；通道持续故障期 E 随 P 持续被抑制，但那是通道不可用（也投不出 E）、非新增丢失。
- [PH URL 格式假设 `producthunt.com/posts/<slug>`] → slug = PH 原生 `post.slug`，`/posts/<slug>` 是 PH 产品页标准路径；若 PH 改版最坏链接 404，不影响推送其余部分，与既有 `canonical_domain` 链接同等「不保证 200」。
- [被剔事件永久漏推] → 不写 push_record + 跨天候选资格保留 → 次日不被产品覆盖即回要闻，无永久漏推。

## 迁移计划

- **无 DB 迁移、无 schema 变更**；纯代码 + 测试。
- 部署经既有容器化流程（`docker compose --profile app up -d --build` 或镜像）；worker 重启即生效。
- **回滚**：revert 提交即可；无数据形态变更、无需数据回滚。
- **可选历史收尾**（部署后观察一两天，若仍见泄漏再执行；非代码、人工只读核对命中行后跑）：
  ```sql
  UPDATE ai_news_events
  SET should_push = false, updated_at = now()
  WHERE should_push = true AND merged_into IS NULL
    AND representative_title ~* '^\s*(show|ask|launch|tell)\s+hn\b';
  ```

## 开放问题

- Launch HN（YC 公司发布）是否一律排除出要闻？本设计按「产品/公司发布帖、非中立行业新闻」排除；若未来希望保留 YC 重大融资/发布作要闻，需改由 RSS/官方源以 news 形态进入（不回退到 topstories 收录）。
- 跨段抑制是否再扩「规范化 URL 完整路径」键？本期三键组（`canonical_domain`/`github_repo`/`product_hunt_slug`）已覆盖 grassdx（域）+ github 直链（repo）+ PH（slug）三类；同一产品挂在子路径（如 `site.com/product-a` vs `site.com/product-b` 两个不同产品共域）的细分留待真实出现再议，非本期必须。
