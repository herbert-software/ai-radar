## 新增需求

### 需求:要闻段与新品段跨段去重抑制（同一项目双段重复兜底）

系统 MUST 在 `runDailyWorkflow()` 选出要闻段（channel-blind Top N，待推 `pushable`）与新品段（`productsByChannel`）之后、推送早退判断与 dispatch 之前，执行一道**确定性跨段去重抑制**：若同一项目既出现在要闻段又出现在新品段，MUST **从要闻段剔除该事件、保留新品段产品**（Show HN/Launch HN 等本质是产品，新品段是其正确归属、且带官网链接与中文简介）。

对齐键 MUST 为**产品归一三键组**（`canonical_domain` / `github_repo` / `product_hunt_slug`），复用既有导出纯函数 `extractProductMergeKeys`（与产品塌缩、Show HN 采集同一口径，避免漂移）：
- **要闻侧**：对每个待推事件取其代表 raw_item 的 `canonical_url`（经既有 eventId→canonical_url 映射 `loadCanonicalUrls`），调 `extractProductMergeKeys({ url: canonicalUrl })` 提出该事件的三键组。
- **新品侧**：取产品的**存储归一键**（`ai_products.canonical_domain` / `github_repo` / `product_hunt_slug` 字段本身，由 `selectProductCandidates` 随候选一并带出、见 product-discovery「链接来源」段的候选载体约定），**MUST NOT** 取经 `resolveProductUrl` 渲染出的 `canonicalUrl`（后者含 github/PH 回退、提域会得到 `github.com`/`producthunt.com`，致 mass 误抑制——见下）。
- **平台 host 域 MUST 排除（一类缺陷、非两个特例）**：构建产品「域集」时 MUST 剔除**平台 host**——即「代码托管 / 包注册 / 产品目录 / PaaS 等本身非某产品自有域、其上路径才是产品身份」的 host。根因：产品 `canonical_domain` 被重载——真实产品取自 `website` 字段（有意义身份键），但**无 website 的 Show HN/PH 产品**其 raw_item `url` 是提交的平台 URL，经 `extractProductMergeKeys`（`website = meta.website ?? input.url`）落成平台 host 域。`extractProductMergeKeys` **当前只对 `github.com` 置 null**（其余平台 host 不管）。若不排除，任一 `canonical_url` host 为该平台的要闻事件会被 mass 误抑制（与 round 1 的 `github.com`、round 2 的 `producthunt.com` **同一类缺陷**）。
  - **denylist MUST 为命名常量 `PLATFORM_HOSTS`**（所有排除引用点 MUST 指向它、禁止在调用点内联子集），至少含：`github.com`（已 null）、`producthunt.com`、`gitlab.com`、`gitee.com`、`bitbucket.org`、`codeberg.org`、`sourceforge.net`、`npmjs.com`、`pypi.org`、`crates.io`、`huggingface.co`。**收录判据**：只收「**URL 路径**而非**子域**标识产品」的平台 host（`github.com/owner/repo`、`npmjs.com/package/x`…）；**子域标识产品**的 PaaS（`myapp.vercel.app`/`x.github.io`/`x.netlify.app`）**不入**——`extractCanonicalDomain` 取完整 host，子域本就是产品唯一身份、不撞域。MUST 注释「**任何产品源（见 `PRODUCT_SOURCES`）的无 website 兜底 URL host 若是路径式平台 host，MUST 加入本常量**」，并在 `PRODUCT_SOURCES` 定义处加回引注释指向 `PLATFORM_HOSTS`，把「新增产品源 ↔ 新增平台 host 排除」的耦合在**两处编辑点**都显式化（防再以一次生产误抑制事故才发现）。
  - **残留（accepted）**：denylist 是确定性枚举、不可证完备；未列入的平台 host 仍可能 mass 误抑制一类该 host 的要闻——后果仅「少推若干要闻、新品段仍在、非数据损坏」，属可接受 bounded 残留（彻底根治需让产品塌缩按 `canonical_domain` 来源 website-vs-fallback 区分、对所有平台 host 一致置 null，那触及产品塌缩写入路径、超本次范围）。PH 产品的有效身份是 `product_hunt_slug`、github 产品是 `github_repo`——平台 host 域排除后它们走各自精确键对齐。
- **判定**：事件的任一**非空**键命中任一产品对应键集合（`canonical_domain ∈ 产品域集`〔已排除平台 host〕 或 `github_repo ∈ 产品 repo 集` 或 `product_hunt_slug ∈ 产品 slug 集`）即判为同一项目、抑制该事件。

判定 MUST 纯由程序确定性键完成，MUST NOT 调用 LLM / embedding 做「是否同一项目」判断（守第一架构原则：跨表去重由程序与确定性键保障，绝不交给语义层）。

**为何用三键组而非渲染域**：`extractProductMergeKeys` 无条件令 `github.com` 域置 null（两侧一致）——github 来源的要闻事件（`raw_type='repo'`，`canonical_url` host=`github.com`，经新闻塌缩进 `ai_news_events`）与 github-only 产品都不以 `github.com` 域参与比对，改由 `github_repo`（`owner/repo`）精确对齐：既**杜绝**「所有 github 要闻被 github.com 域 mass 误抑制」（修改3 的回退 URL 提域会撞 `github.com` 的 blocker），又**顺带闭合** github 直链的 news↔product 双段重复（`themartiano/luz` 类）。`producthunt.com` 不被 `extractProductMergeKeys` 置 null，故 MUST 在构建产品域集时显式排除（见上「平台 host 域 MUST 排除」）。

**键提取的两侧不对称（设计如此，记录以防误用）**：要闻侧只传 `{ url: canonicalUrl }`（无 `metadata`），故 `product_hunt_slug` 与 `meta.canonical_domain`/`meta.github_repo` 分支对事件**永不触发**——事件只可能经 URL 推导的 `canonical_domain` 或 `github_repo` 命中。**注意**：事件侧的 `canonical_domain` **不经平台 host 排除**（事件键是 `extractProductMergeKeys({url})` 原样输出，仅 `github.com` 被该函数置 null，`producthunt.com` 等在事件侧仍保留）；抑制的安全性来自**产品域集排除平台 host**（命中需事件域 ∈ 产品域集，而产品域集已剔平台 host），不是事件键被擦洗。新品侧传存储字段（含 `product_hunt_slug`）。

**两侧是同一键空间的两次独立派生，同步义务 MUST 显式**：产品侧三键是 `extractProductMergeKeys` 在**塌缩时**写入 `ai_products` 的存储值（冻结），事件侧是**查询时**对 `canonical_url` 现调 `extractProductMergeKeys`；二者经同一函数派生、口径一致，但**平台 host denylist 是抑制层在两者之上额外施加的变换、不在 `extractProductMergeKeys` 内**。故「单一口径避免漂移」仅指 `extractProductMergeKeys` 本身；若该函数的 host 置 null 规则未来变化（如开始 null `producthunt.com`），MUST 同步检视抑制层 denylist（去重避免双重维护）。因此 PH-only 产品（域被排除、repo null、仅 slug）与任何要闻事件都**不命中**（事件侧产不出 slug 键）：这是**安全方向的欠抑制**（PH-host 要闻↔产品的双段重复本期不闭合，属可接受残留，PH 本是产品源、极少作要闻 canonical）。

> 动因：`ai_news_events`（要闻）与 `ai_products`（新品）分表去重、无跨表去重，同一项目经不同源进两表即双段重复（生产实锤：HN `48544823` / `grassdx.com` 同时进要闻与新品）。采集期前缀过滤（见 source-collectors）只堵 HN 一条路径；RSS/sitemap 转载产品发布等其它源仍可能与 PH/Show HN 同产品撞域，故 MUST 有装配期确定性兜底，闭合「当天不重复推送」「分层去重 + 唯一约束兜底」不变量。

抑制 MUST 保持要闻段 channel-blind 单份语义（Model B）：MUST 用**所有已配置通道新品候选的并集**（`productsByChannel` 各通道候选并集）构成产品三键集合，剔一份 channel-blind 要闻段，MUST NOT 按单通道产品候选分别剔不同的要闻名单（否则破坏「同一份 Top N 发放给所有通道」）。**并集 + channel-blind 的已知权衡（accepted）**：某产品 P 仅为 telegram 候选（feishu 已 success 过 P 故不在 feishu 候选）、而同项目要闻事件 E 尚缺 feishu 投递时，E 会被从 channel-blind 要闻段剔除，致 feishu 当天既无该产品也无该要闻。这是 Model B「单份名单」与「产品 per-channel 一生一次」的固有张力下的取舍：选并集（防双段重复）优于交集（交集会在 telegram 留下 E+P 双段重复，即本提案要消灭的 bug）。E **不写 push_record**（见下）故跨天候选资格保留；产品 P 是 per-channel 一生一次、一旦在某通道 success 即离开该通道候选 → 并集域不再含 P → E 恢复。**恢复有界性（精确表述）**：E 的恢复以「P 清出候选」**且**「E 的 `published_at` 仍在 `FIRST_SEEN_WINDOW_DAYS` 时效窗内」为条件——通常 P 次日推完即恢复（≤1 天）；但若某通道**持续 failed/pending**（P 从未 success → 长期留候选），E 会随之被持续抑制直至该通道恢复或 E 时效窗过期。此为**通道不可用期的固有现象**（该通道本就投不出 E、不是本抑制新增的丢失），非永久漏推的反例；不引入 LLM、不加无界状态机来规避。

被抑制的要闻事件 MUST NOT 写入 `event` 命名空间的 `push_records`（不置 `pending`/`success`/`failed`）——它只是不进入本条日报消息；其跨天候选资格（「尚未投递给所有已配置通道」）MUST 保持不变，使其在某天不再被任一新品候选覆盖时能正常回到要闻段推送（不造成永久漏推）。**早退一致性**：抑制 MUST 产出 `pushableDeduped`，并由其**同时**喂给早退判断（`pushableDeduped.length === 0 且所有 channel 产品候选皆空` 才 `skipped-no-candidates`）与 dispatch（被剔事件不进 dispatch 的 `computePendingSet` 入参、故不写 push_record）；表头「要闻 X」取 dispatch 后 `eventIncludedIds.length`、自然为抑制后实发数。抑制位置在 `productsByChannel` 算出之后（依赖它）、早退判断之前；运行于中文摘要循环之后（`canonicalUrls`/`productsByChannel` 此时才齐备）——被剔事件已耗的摘要 LLM 调用为可接受的少量浪费（不另调度重排以省此开销）。

**纯函数 + 接线职责划分**：键比对 MUST 由 `src/selection/cross-segment-dedup.ts` 的**纯函数**承载，该模块**入参为已提取的键**（事件 `{eventId, keys}` 列表 + 产品三键集合）、**自身 MUST NOT import `src/collectors/*`**（保持 selection 层不新增 collectors 依赖边）。键来源分两侧：
- **产品侧（无需现提取，键随候选带出）**：`selectProductCandidates` MUST 让每个产品候选**携带其存储三键**（`canonical_domain`/`github_repo`/`product_hunt_slug`，见 product-discovery「候选载体」），编排层从内存中的 `productsByChannel` 候选对象直接读取构建产品键集合——**满足「复用 `productsByChannel`、MUST NOT 引入额外 DB 查询」**（键已随候选在内存，无需回查 `ai_products`）。
- **事件侧（现提取）**：编排层 `run-daily-workflow.ts` 对每个 `pushable` 事件用 `canonicalUrls.get(eventId)` 调 `extractProductMergeKeys({ url })` 提键。`run-daily-workflow.ts` 已 import `collectAndStore`（`../collectors/index.js`）→ **pipeline→collectors 依赖边已存在**；`extractProductMergeKeys` 在 `../collectors/product-keys.js`（零 `../db`/零 `env` 的纯 leaf 模块），import 它为同向良性边、不引入 DB 池、不成环。

**误抑制边界（accepted，确定性无更优解）**：① 同一 `canonical_domain` 下厂商既有真实要闻文章又有自家产品（如 `acme.ai` 博客新闻 + `acme.ai` 产品）→ 域键命中会剔掉该要闻；这是域级对齐的固有假阳性，后果仅「少推一条要闻、新品段仍在、非数据损坏」，确定性手段无法区分「同项目冗余」与「同域异内容」（语义区分被第一架构原则禁止）。② 两个不同产品共享**同一完整 host**（`extractCanonicalDomain` 取完整 host 去 www、**非** eTLD+1，故 `a.github.io` ≠ `b.github.io`，PaaS 子域天然不撞；仅同一裸 host 才撞，极罕见）。两类均 bounded、非破坏，记为 accepted。

#### 场景:同一项目同域同时进要闻与新品 → 要闻段剔除
- **当** 某事件 `canonical_url` 经 `extractProductMergeKeys` 得 `canonical_domain` = 某新品候选的 `canonical_domain`（如 `grassdx.com` 同时在要闻段与新品段）
- **那么** 该事件从要闻段剔除、不进日报要闻段、不写 `event` push_record；对应产品保留在新品段照常推送

#### 场景:github 直链同项目经 github_repo 对齐剔除
- **当** 某要闻事件 `canonical_url` 为 `https://github.com/owner/repo`（经 `extractProductMergeKeys` 得 `canonical_domain=null`、`github_repo='owner/repo'`），且某 github-only 新品候选 `github_repo='owner/repo'`
- **那么** 两侧 `github_repo` 命中 → 该要闻事件被抑制（闭合 github 直链 news↔product 双段重复，不依赖已被置 null 的域键）

#### 场景:github 来源要闻不被 github.com 域 mass 误抑制
- **当** 某 github 来源要闻事件（`raw_type='repo'`，`canonical_url=https://github.com/aaa/bbb`）与某无关 github-only 产品（`github_repo='ccc/ddd'`）同日出现
- **那么** 两侧 `canonical_domain` 均经 `extractProductMergeKeys` 置 null（不以 `github.com` 撞域），`github_repo` 不同（`aaa/bbb` ≠ `ccc/ddd`）→ **不**抑制，该 github 要闻正常推送

#### 场景:producthunt.com 域不致误抑制（平台 host 排除）
- **当** 某无 website 的 PH 新品候选其存储 `canonical_domain='producthunt.com'`（由 `extractProductMergeKeys` 从 PH 帖 URL 推出），与某 `canonical_url` host 为 `producthunt.com` 的要闻事件同日出现
- **那么** 构建产品域集时 `producthunt.com` 被显式排除（平台 host），二者不以 `producthunt.com` 撞域 → 该要闻不被误抑制（PH 产品改靠 `product_hunt_slug` 对齐）

#### 场景:要闻事件三键均不命中任何新品键 → 保留
- **当** 某要闻事件的 `canonical_domain`/`github_repo`/`product_hunt_slug` 三键与所有通道新品候选并集的对应键集合均无交集
- **那么** 该事件保留在要闻段，正常推送，不受抑制影响

#### 场景:全要闻段被抑制 + 新品非空 → 仍推新品段（早退用 pushableDeduped）
- **当** 抑制后 `pushableDeduped` 为空但存在新品候选
- **那么** 早退判断按 `pushableDeduped`（非原始 `pushable`）判定不早退、只渲染推送新品段；表头 `要闻 0·新品 Y`

#### 场景:抑制不破坏被剔事件跨天候选资格
- **当** 某事件今日因被新品段覆盖而从要闻段抑制、未写 `event` push_record
- **那么** 次日若它不再被任一新品候选覆盖，仍满足「尚未投递给所有已配置通道」候选窗口、可正常进入要闻段推送（无永久漏推）

#### 场景:跨段抑制用全通道并集三键集合保持 channel-blind
- **当** 某产品在 telegram 新品候选、不在 feishu 新品候选（或反之）
- **那么** 抑制用两通道新品候选的**并集三键集合**（域集〔排平台 host〕/ repo 集 / slug 集）剔一份 channel-blind 要闻段（只要任一通道会推该产品 → 要闻段就剔对应事件），不按通道分别剔不同要闻名单

#### 场景:表头计数取抑制后实发数
- **当** 跨段抑制从要闻段剔除 K 条后再 dispatch
- **那么** 表头「AI Radar 每日情报（要闻 X·新品 Y）」的 X 取抑制后实发事件数（`eventIncludedIds.length`），不含被剔事件
