## 新增需求

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
