# source-collectors 规范

## 目的
待定 - 由变更 minimal-intel-pipeline 同步创建。归档后请更新目的。
## 需求
### 需求:三源确定性采集

系统必须提供一组确定性采集器（collector），以程序而非 Agent 自由采集的方式拉取数据，并将每条结果以统一结构写入 `raw_items`。统一结构必须至少包含 `source`、`source_item_id`、`url`、`title`、`content`、`published_at`、`raw_type` 字段（对齐 QA.md §10.1）。禁止用 LLM/Agent 决定采什么或是否采。

采集器编排必须**由数组驱动的 collector registry 承载**，而非把每个源写死成独立的编排分支：新增一个写入 `raw_items` 的源（如本期的 arXiv、Product Hunt、后续的厂商 HTML 源）必须只需向 registry 注册该 collector，**不需要修改 `CollectorSource` 联合类型以外的编排结构**（消除「加一源改两处」）。本期 registry 必须至少覆盖：RSS（含多个一线大厂官方 feed）、Hacker News、GitHub、arXiv、Product Hunt。**Product Hunt 也是写入 `raw_items` 的普通 collector**（`source='product_hunt'`、`raw_type='product'`，对齐 QA.md「输出统一写入 `raw_items`」与 `raw_type` 含 `product`）——产品塌缩进 `ai_products` 是下游确定性步骤（见 product-discovery），不绕过原始证据层。各源仍以 `Promise.allSettled` 并发、单源失败隔离。

registry 必须**支持按 `source` 字段筛选子集供不同工作流复用**：日报工作流调用全集，实时告警高频工作流只调实时新闻源子集 `{rss, hacker_news, github}`（见 realtime-alerts）。即 registry 暴露按 source 过滤的能力（如 `collectSources(registry, allowedSources)`），而非写死全量调用——避免高频链路被迫连 arXiv（非实时）/PH（配额受限）一起跑。

#### 场景:registry 注册即接入新源
- **当** 新增一个写入 `raw_items` 的采集源
- **那么** 仅需向 collector registry 注册该 collector 即可被每日采集编排并发调用，无需改动既有源的编排分支

#### 场景:多源各自拉取并统一入库
- **当** 每日流水线触发采集
- **那么** registry 中的各 collector 分别拉取并将结果按统一结构写入 `raw_items`，`source` 字段如实标记来源

#### 场景:单源失败不拖垮整批
- **当** 多源中某一源（如 GitHub API 限流或 arXiv 429）抓取失败
- **那么** 该源失败被记录错误日志，其余源照常完成入库，整批采集不因单源失败而中止

### 需求:源内幂等采集

系统必须为每条采集结果生成稳定且**非空**的 `source_item_id`，依赖 `raw_items` 的 `UNIQUE(source, source_item_id)` 约束保障同一源重复抓取不产生重复行。`source_item_id` 必须按 fallback 链取值：Hacker News 用 item id、GitHub 用 repo 稳定 id（如 full_name 或数值 id）、arXiv 用其稳定 arXiv id（如 `2406.12345` 或带版本的 OAI identifier）、Product Hunt 用其稳定 `product_hunt_slug` 或 PH 数值 id；各源稳定原生 id 缺失时统一 fallback 到 `canonical_url`（对 PH 即产品页规范化 URL）；`canonical_url` 也为空时，必须终端 fallback 到内容哈希（如 `sha256(title ‖ content)`），**绝不允许 `source_item_id` 为 NULL**——因为 Postgres 中 `NULL` 不等于 `NULL`，`UNIQUE(source, NULL)` 对多行全部放行，会使源内幂等静默失效。禁止用易变值（如原始 URL 含追踪参数、纯标题）当 `source_item_id`。fallback 链中用到的 `canonical_url` 由 URL 规范化纯函数在采集阶段即时生成（见 dedup-and-normalization）。

**RSS guid 必须按 feed 命名空间化**：RSS 的 `guid` 仅保证**单个 feed 内**唯一（不少 feed 用裸序号/短 id 作 guid），而 RSS 全部 feed 共用 `source='rss'`，故直接用 guid 作 `source_item_id` 会让两个不同 feed 的相同 guid 在 `UNIQUE(source, source_item_id)` 下被误判为同一条而错误去重。因此 RSS 的 `source_item_id` 必须命名空间化为 `sha256(feed_url ‖ '\0' ‖ guid)`（guid 缺失时仍按上面的 `canonical_url` → 内容哈希 fallback，二者本身全局唯一、不受此影响）。

#### 场景:重复抓取同一条不产生重复行
- **当** 同一源在两次采集中返回同一条目（相同稳定标识）
- **那么** 第二次写入因 `UNIQUE(source, source_item_id)` 冲突而被跳过，`raw_items` 中该源该条目仅一行

#### 场景:RSS guid 缺失时回退 canonical_url
- **当** 某 RSS 条目缺少 guid
- **那么** 系统以其即时生成的 `canonical_url` 作为 `source_item_id`，仍保证源内幂等

#### 场景:不同 feed 相同 guid 不被误判为同一条
- **当** 两个不同大厂 feed 各有一条 `guid` 字面相同的条目
- **那么** 二者经 `sha256(feed_url ‖ '\0' ‖ guid)` 命名空间化后得到不同 `source_item_id`，`UNIQUE(source, source_item_id)` 不冲突，各自独立入库、不被误去重

#### 场景:arXiv 条目用稳定 arXiv id 作幂等标识
- **当** arXiv 采集返回某篇论文
- **那么** 系统以该论文稳定 arXiv id 作为 `source_item_id`，重复抓取该篇不产生重复行

#### 场景:Product Hunt 条目用稳定 slug 作幂等标识
- **当** Product Hunt 采集返回某产品并以 `source='product_hunt'`、`raw_type='product'` 写入 `raw_items`
- **那么** 系统以该产品稳定 `product_hunt_slug`（或 PH 数值 id）作为 `source_item_id`，重复抓取同一产品不产生重复 `raw_items` 行

#### 场景:guid 与 canonical_url 皆缺时终端回退内容哈希
- **当** 某条目既无稳定原生 id 又无可用 `canonical_url`
- **那么** 系统以内容哈希作为非空 `source_item_id`，源内幂等不失效

### 需求:采集外部调用带重试与错误日志

系统对所有外部源的网络调用必须带重试与错误日志（横切不变量）。失败时禁止静默吞掉，必须记录可观测的错误信息。

#### 场景:外部源瞬时失败时重试
- **当** 某外部源调用发生瞬时网络错误
- **那么** 系统按有限重试策略重试，并在最终失败时记录错误日志，不静默成功

### 需求:RSS 来源厂商标记

系统采集 RSS 时必须为每条目带上**来源厂商标记（vendor provenance）**并写入 `raw_items.metadata`（如 `{vendor, feed_url}`），使一线大厂官方发布（OpenAI / Google DeepMind / Hugging Face 等）与普通博客可区分。当前实现把所有 RSS 条目标成 `source='rss'` 并丢弃来源 feed，本期必须改为：每个配置的 feed 携带其厂商标识（由配置的 feed→vendor 映射决定），采集时落入 `metadata`，供后续重要性评分与日报展示区分「谁发布的」。`source` 字段可保持 `rss`（来源类别），厂商身份承载于 `metadata`，不得因加 vendor 标记而破坏既有 `source_item_id` fallback 链与源内幂等。

`RSS_FEEDS` 配置格式由「纯 URL 逗号列表」升级为「带 vendor 标记的 feed 配置」：**逗号分隔多个 feed 条目，每个条目必须含 `|` 分隔符、形如 `url|vendor`**。解析每个条目的算法必须钉死以下确定性顺序，消除「以是否含 `|` 区分新旧」与「URL 不得含 `|`」的环形依赖：① 按 **首个** `|` split 成两段；② 校验 split 出**恰好 2 段**（即条目含且仅含一个 `|`）——split 后第二段再含 `|`（即原 URL 含 `|`）则判**配置错误、启动报错**；③ 条目**不含 `|`**（split 仅 1 段）则判**旧裸 URL 格式、启动快速失败并提示新格式**。vendor 段（第二段）可空：`url|`（尾随空 vendor）→ `metadata.vendor` 取 `null`、不报错、不阻塞采集。这是破坏性 env 变更，禁止静默把所有 feed 的 vendor 置空入库。

#### 场景:大厂官方 RSS 条目带厂商标记入库
- **当** 采集 OpenAI / DeepMind / Hugging Face 官方 RSS feed
- **那么** 每条目的 `raw_items.metadata` 含其 vendor 标识与 feed_url，可据此区分发布厂商

#### 场景:加 vendor 标记不破坏源内幂等
- **当** 同一 feed 的同一条目被重复抓取
- **那么** vendor 标记写入 `metadata` 不改变 `source_item_id` 取值，第二次仍因 `UNIQUE(source, source_item_id)` 冲突被跳过

#### 场景:RSS_FEEDS 旧裸 URL 格式启动即报错
- **当** `RSS_FEEDS` 含不带 `|` 分隔符的裸 URL 条目（旧格式）并尝试启动
- **那么** env 校验以「条目无 `|`」机械判为旧格式、明确错误信息快速失败提示新格式，而非静默把 vendor 置空继续

#### 场景:url| 空 vendor 取 null 不阻塞
- **当** 某 feed 条目为 `url|`（含分隔符但 vendor 段为空）
- **那么** 其条目 `metadata.vendor` 为 `null`，采集照常完成、不报错

#### 场景:feed URL 含 | 字符时启动报错
- **当** 某 feed 条目按首个 `|` split 后第二段仍含 `|`（即原 URL 含 `|`、条目含多于一个 `|`）
- **那么** env 校验判为配置错误、启动快速失败，而非误把 URL 尾段当 vendor

### 需求:arXiv 采集遵守限流与退避

系统的 arXiv 采集器必须遵守 arXiv 的硬限流：**每 3 秒不超过 1 个请求、单连接串行**。采集必须内置**单采集进程内** ≥3 秒串行节流（前提：P2 采集由单实例承载，见下），并对 HTTP 429 响应做退避重试（2026-02 起 arXiv 收紧 429 执行）。退避重试必须**有上限**：超限则本轮该源放弃、记 error，由 `Promise.allSettled` 隔离——禁止无界退避让该源 promise 长期 pending 拖长整个 job；该放弃**不计入**「全部源采集返回 0」的系统级故障告警（仅单源失败）。arXiv 采集优先走 OAI-PMH 增量元数据接口（官方推荐的保持最新方式）。

**P2 范围限定**：arXiv 论文仅以 `raw_type='paper'` 采集落 `raw_items` 作**数据沉淀**，本期**不进事件塌缩、不进日报、不推送**（事件塌缩按 dedup-and-normalization 类型路由排除 `paper`；论文板块留 P3）。arXiv 作为**非实时源**，不得接入实时告警路径。

**OAI-PMH 增量游标必须 at-least-once**：增量游标（如上次 harvest 时间戳）**必须在条目成功入库后才推进**，禁止「先推进游标后入库」——否则进程在二者之间崩溃会跳窗漏论文（静默丢条）。重抓由 `UNIQUE(source, source_item_id)` 幂等吸收，故 at-least-once（宁可重抓不可漏窗）安全。

所有调用必须带重试与错误日志；但**鉴权类错误（HTTP 401/403）不进入退避重试**（重试不可恢复的鉴权错误只是浪费预算），直接按单源失败记 error、由 allSettled 隔离。

节流口径限定为**单采集进程内串行**：本期明确 arXiv（及全部采集）由单实例承载，进程内串行节流闸即满足 arXiv 侧限流；**不**承诺跨多 worker 的全局分布式节流（若未来多实例采集，再引入 Redis 令牌桶，不属本期）。

#### 场景:arXiv 请求按 ≥3 秒节流串行
- **当** arXiv 采集需要在单采集进程内发起多次请求
- **那么** 请求以 ≥3 秒间隔、单连接串行发出，不以并发连接绕过限流

#### 场景:遇 429 退避重试且有放弃上限
- **当** arXiv 返回 HTTP 429
- **那么** 采集器退避后重试、记录错误日志，不静默失败也不无视退避立即重打；持续 429 达重试上限时本轮该源放弃并记 error、由 allSettled 隔离，不无界 pending 拖长 job、不触发全失败告警

### 需求:RSS 源分层与次级源噪音治理

系统的 RSS 源清单 MUST 允许在 T1 大厂官方源（高信号，如 OpenAI / DeepMind / Hugging Face / Mistral / Microsoft）之外，纳入**次级 / 社区源**（较低信号、非 AI-only，如 GitHub Blog `github.blog/feed/`、GitHub Changelog `github.blog/changelog/feed/`、Lobsters `lobste.rs/rss`）。两类源 MUST 共用 `source='rss'`、**沿用**既有「三源确定性采集」「源内幂等采集」「RSS 来源厂商标记」需求的采集保障（`source_item_id` fallback 链 / 源内幂等 / 单源失败隔离 / vendor provenance 落 `metadata`）——本需求**不重定义**这些既有判定，仅声明次级源同样适用、不因信号高低而分裂出新 `source` 取值或新 collector。

次级源的**噪音治理 MUST 完全交由下游既有闸**承担，且 MUST 分清两类闸：① **LLM 语义判断**——Value Judge 输出的 `importance`（0-100，落库列 `importance_score`）评分与**语义布尔 `should_push`**（LLM 直出字段，非程序对 importance 的数值比较；prompt 不含任何如 75 的数值锚，代码亦无推导 `should_push` 的 `importance>=N` 程序闸——注意这指 `should_push` 的产生，不否认日报 `IMPORTANCE_FLOOR` 与告警 `ALERT_IMPORTANCE_THRESHOLD` 这两道独立的 importance 阈值闸）；② **程序确定性闸**——日报 `IMPORTANCE_FLOOR`（与噪音治理相关的必要闸为 `should_push=true AND importance_score >= IMPORTANCE_FLOOR`；这非 Top N 候选的完整条件，后者另含 `published_at` 时效窗口与 Model B 通道去重，见 `src/selection/top-n.ts`）与实时告警 `ALERT_IMPORTANCE_THRESHOLD`。系统 MUST NOT 在采集期对次级源做源级排除、关键词硬预过滤或专门的更高门槛——即「够好才挤进日报 / 告警」由上述语义判断 + 确定性闸共同把关，价值判断不下放给采集期规则（守「Agent 控语义、不把语义判断交给硬规则」分层原则）。**注意系统当前无「AI 相关性」确定性硬闸**（`is_ai_related` 经 schema 解析后被丢弃、无对应列），非 AI-only 内容的过滤依赖 Value Judge 的语义 `should_push` 判断而非规则。

#### 场景:次级源条目以 source='rss' 正常入库
- **当** 采集 GitHub Blog / GitHub Changelog / Lobsters 等次级 / 社区 RSS feed
- **那么** 每条目以 `source='rss'` 写入 `raw_items`，复用与 T1 源相同的 fallback 链与源内幂等，不被采集期源级排除

#### 场景:次级源噪音由下游评分闸吸收而非采集期硬筛
- **当** 某次级源条目经 Value Judge 评分后未获 `should_push=true`，或 `importance_score` 低于 `IMPORTANCE_FLOOR`
- **那么** 该条目自然不进日报候选 / 不占 Top N 名额，而采集层未对其做任何源级排除或关键词预过滤

### 需求:RSS vendor 多 feed 映射与社区源标记约定

系统的 vendor provenance 约定 MUST 支持**多个不同 feed 映射到同一 vendor**：当同一厂商提供多个 feed（如 GitHub Blog 与 GitHub Changelog 同属 GitHub，vendor 均为 `github`）时，两 feed MUST 共用同一 `metadata.vendor` 值，并 MUST 由 `metadata.feed_url` 落不同值以保留具体 feed 维度。此时跨 feed 的源内幂等（同 guid 不串号）由既有「源内幂等采集」需求的命名空间化 `source_item_id`（含 feed_url）保障——该不变量的键是 `feed_url`、**与 vendor 无关**，故本需求不重复定义它，仅声明「多 feed 同 vendor」不破坏该既有保障。

vendor 字段语义为「来源身份标识」（既往取值为公司名），且当前为**仅写入、下游尚无消费方按值读取**的 provenance 标签（保留以供未来评分 / 展示消费）。对**可识别的社区聚合源**（无单一厂商，如 Lobsters），系统 MUST 取**描述性来源标记**（如 `lobsters`）而非 `null`，以保留 provenance；`null` 仅保留给「无来源映射的普通博客」。此约定 MUST NOT 破坏既有「`url|` 空 vendor 取 null 不阻塞」与「feed→vendor 由配置映射决定」的行为。

#### 场景:多 feed 映射同一 vendor 由 feed_url 保留细分维度
- **当** 配置 GitHub Blog 与 GitHub Changelog 两个 feed、vendor 均标为 `github`
- **那么** 两 feed 的条目 `metadata.vendor` 均为 `github`，但 `metadata.feed_url` 落不同值，保留两 feed 的细分维度（本期仅落库留存 provenance，下游消费留待未来），且 `metadata.vendor` 共用 `github` 不会因此被任何下游逻辑误读（当前无代码按 vendor 值分支）

#### 场景:社区聚合源取描述性 vendor 而非 null
- **当** 采集 Lobsters（`lobste.rs/rss`）且配置 vendor 为 `lobsters`
- **那么** 其条目 `metadata.vendor` 为 `lobsters`（非 null），保留可识别的来源身份

### 需求:次级源经实时告警链由阈值过滤而非源级排除

由于实时告警高频链路的源子集 `REALTIME_NEWS_SOURCES` 含 `rss` 且为 **source 级粒度**（无 feed 级开关），纳入的次级 RSS 源条目 MUST 与 T1 RSS 源一样进入告警链采集与评分。是否真告警 MUST 继续服从 **realtime-alerts 主规范定义的全部候选条件**（不在本需求重复定义其判定）——其中 `ALERT_IMPORTANCE_THRESHOLD`（纯程序判定，严于日报）只是 **source-neutral 的重要性门槛、非唯一条件**：另含 `published_at` 非空且在时效窗口内、该事件按 realtime-alerts 的 **Model B（channel-agnostic「一生一次」：尚未 alert-success 投递给所有已配置通道）** 去重、单轮上限 `ALERT_MAX_PER_SCAN` 等。本需求不简化、不绕过这些既有候选条件。系统 MUST NOT 为压制次级源而把 `rss` 从告警子集摘除（会误伤 T1 大厂官方 RSS 的重大发布实时告警），本期亦 MUST NOT 引入 feed 级告警黑名单——次级源告警噪音的兜底是高阈值 + realtime-alerts 全部候选条件 + Model B 一生一次去重。

#### 场景:次级源与 T1 源同等套用 realtime-alerts 全部候选条件
- **当** 某次级源（如 GitHub Changelog）条目经评分，且满足 realtime-alerts 主规范的全部候选条件（含 `importance_score >= ALERT_IMPORTANCE_THRESHOLD`、`published_at` 在时效窗口内、按 Model B 尚未 alert-success 投递给所有已配置通道）
- **那么** 该事件按既有告警链触发实时告警（与 T1 源同等对待，达阈值是必要而非充分条件）

#### 场景:次级源未达阈值不告警且不被源级摘除
- **当** 某次级源条目 `importance_score` 低于 `ALERT_IMPORTANCE_THRESHOLD`（或不满足 realtime-alerts 其余候选条件，如时效窗口 / Model B 通道去重）
- **那么** 该事件不触发告警，但 `rss` 仍保留在 `REALTIME_NEWS_SOURCES` 中（T1 RSS 源的告警能力不受影响）

