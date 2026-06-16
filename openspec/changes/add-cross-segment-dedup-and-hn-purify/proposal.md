## 为什么

日报「要闻」与「新品」两段会把**同一个项目同时推两遍**。生产实例已实锤：Show HN 帖「Vet turned founder, AI lawn diagnosis」（HN item id `48544823` / `grassdx.com`）被 `hacker_news` 源以 `post` 身份收进要闻，又被 `show_hn` 源以 `product` 身份收进新品。

根因有三层叠加：
1. HN `topstories` 采集（`hacker-news.ts`）对每条无差别打 `rawType:'post'`，**不过滤 Show/Ask/Launch/Tell HN 帖** → 产品发布/提问帖以 news 身份进要闻。
2. 两源 `(source, source_item_id)` 命名空间不同（`hacker_news` vs `show_hn`，刻意分离避免 ON CONFLICT 互覆），同一 HN id 的唯一约束**拦不住**。
3. `ai_news_events` 与 `ai_products` 分表去重，**无跨表（要闻↔新品）去重**，双段重复无法被发现。

这违反不变量「当天不重复推送」与「分层去重 + DB 唯一约束兜底」。运行数据还显示 `ai_news_events` 已积压 ≥10 条 Show HN 帖污染要闻候选池，且它们都拿到 `should_push=t`——证明下游 Value Judge 语义闸兜不住，**必须在采集期堵**。

另有一个独立缺陷（同批修）：纯 GitHub 仓库类产品（`canonical_domain` 为空、只有 `github_repo`，如「从零开始的C++光线追踪器」`themartiano/luz`）在新品段**没有「官网」链接**——候选查询只从 `canonical_domain` 派生链接。

## 变更内容

1. **HN 综合新闻流排除帖式前缀**：`collectHackerNews` 按**原始 title 行首前缀**（`Show HN` / `Ask HN` / `Launch HN` / `Tell HN`，大小写不敏感、仅行首）跳过，要闻段不再混入产品发布/提问/公司发布帖。前缀识别下沉为 `types.ts` 的共享纯函数。按 title 判定（HN `item.type` 不区分 Show/Ask HN）。
2. **要闻↔新品跨段去重抑制（确定性兜底）**：日报装配期按**产品归一三键组对齐**（复用 `extractProductMergeKeys`：要闻事件从 `canonical_url` 现提三键，产品用存储三键字段；域集排除命名常量 `PLATFORM_HOSTS` denylist——路径标识产品的平台 host，github 直链走 `github_repo`、PH 走 `product_hunt_slug`），任一非空键命中即判同项目，**从要闻段剔除、保留新品段**。用全通道产品候选**并集三键集合**剔一份 channel-blind 要闻（不破坏 Model B 单份语义）；被剔事件**不写 push_record**（保留跨天候选资格，次日不再被产品覆盖则回要闻段）。
3. **产品官网链接回退链**：候选查询在 `canonical_domain` 为空时按优先级回退 `github_repo`（`https://github.com/<owner>/<repo>`）→ `product_hunt_slug`（`https://www.producthunt.com/posts/<slug>`），皆空/畸形 → null 降级纯产品名。
4. **历史行处置（非代码）**：不主动清理，靠选品时效窗自然老化；提供一次性可选 SQL（命中前缀的事件置 `should_push=false`）作收尾，**不用** `merged_into`（那是语义合并 tombstone 专用语义，误用会破坏 collapse 改投逻辑）。

## 功能 (Capabilities)

### 新增功能
<!-- 无新增 capability，三处修改均落在现有 capability -->

### 修改功能（均在现有 capability 内新增/修改需求，capability 本身非新建）
- `source-collectors`: 在现有 capability 内**新增需求**——HN 综合新闻流采集 MUST 按原始 title 行首前缀排除 Show/Ask/Launch/Tell HN 帖（源身份净化，非新闻内容价值预筛）；并**修改**既有「Show HN 产品采集」需求的一条场景（Firebase 侧前缀过滤后不再进新闻流）。
- `daily-intel-pipeline`: 在现有 capability 内**新增需求**——日报装配 MUST 在选出要闻段与新品段后、推送前，按**产品归一三键组**（`canonical_domain`/`github_repo`/`product_hunt_slug`，复用 `extractProductMergeKeys`）对齐做要闻↔新品跨段去重抑制（保留新品段、剔要闻段；channel-blind 单份用并集键；被剔事件不写 push_record；`pushableDeduped` 同喂早退与 dispatch）。
- `product-discovery`: **修改需求**——产品候选 `canonicalUrl` 来源由「仅 `canonical_domain`」改为共享纯函数 `resolveProductUrl`（放 `src/collectors/product-keys.ts`）的「`canonical_domain` → `github_repo` → `product_hunt_slug`」回退链；候选额外携带存储三键供跨段对齐。
- `mcp-query`: **修改需求**——**仅** `get_today_ai_digest` 产品链接改用同一 `resolveProductUrl` 回退链，保持「忠实于实际已推内容」不变量（否则 github-only/PH-only 产品推时有链接、查时无链接）。`search_ai_products` **不在范围**（历史检索、无忠实义务，保留既有 `productCanonicalUrl`）。

## 影响

- **代码**：`src/collectors/hacker-news.ts`（采集期前缀过滤）、`src/collectors/types.ts`（新增 `isHackerNewsNonNewsPost`）、`src/collectors/product-keys.ts`（新增 `resolveProductUrl` 纯函数）、`src/selection/cross-segment-dedup.ts`（新建纯函数模块 + `PLATFORM_HOSTS` denylist 常量）、`src/pipeline/run-daily-workflow.ts`（跨段抑制接线 + 事件侧 `extractProductMergeKeys`）、`src/pipeline/product-digest.ts`（SELECT 增列 + 候选携带三键 + 用 `resolveProductUrl`）、`src/mcp/tools/get-today.ts`（**仅 get_today** 改用 `resolveProductUrl` + SELECT 增三键）。`src/push/message.ts`、`src/mcp/lib/canonical-url.ts`（`productCanonicalUrl` 保留给 search_products）、`src/mcp/tools/search-products.ts` **不改**。
- **测试**：`collectors/__tests__`（HN 前缀过滤 + 纯函数）、`selection/__tests__`（跨段去重纯函数）、`pipeline/__tests__`（run-daily-workflow / product-digest 集成）各新增用例。
- **数据/迁移**：**无 schema 变更、无迁移**。`ai_news_events` 历史泄漏行可选一次性 SQL 收尾（人工执行，非代码）。
- **行为**：要闻段不再含 Show/Ask/Launch/Tell HN 帖，可能略少几条（符合 `IMPORTANCE_FLOOR` 宁缺勿凑）；新品段 GitHub/PH 类产品补全官网链接。
- **不变量**：对**新增**条目强化「当天不重复推送」「分层去重 + 唯一约束兜底」；**历史已泄漏行**的「当天不重复」为 best-effort（靠时效窗老化 + 可选 SQL，非代码强保证）。跨段抑制是**确定性程序判定**（三键组对齐），不经 LLM。

## 非目标

- **不**引入语义/LLM 判断做跨段去重——「是否同一项目」由确定性产品归一三键组（`canonical_domain`/`github_repo`/`product_hunt_slug`）决定，绝不交给 LLM（守第一架构原则）。
- **不**改 `raw_items` / `ai_news_events` / `ai_products` schema，**不**加迁移。
- **不**动 `show-hn.ts` 的 `stripShowHnPrefix` 行为（已被测试锁定）；本次只在 `types.ts` 新增 HN 前缀识别。
- **不**改 `message.ts` 渲染层。
- **不**对历史泄漏行做物理删除或语义合并 tombstone（`merged_into`）。
- **不**调整 Value Judge 评分维度/阈值；采集期过滤不是对新闻内容做价值预筛，仅按 `raw_type` 源身份净化（Show HN 是产品不是 news）。
