## 为什么

现有日报源偏 T1 大厂官方（OpenAI / DeepMind / Hugging Face / Mistral / Microsoft），覆盖「谁发布了什么」已充分，但缺两类信号：**开发者平台动态**（GitHub 自身的产品与变更，如 Copilot / Actions / API，`github.blog`）与**程序员社区热点**（技术圈正在讨论什么，Lobsters）。这两类对 ai-radar「AI 行业情报 + 工具选型顾问」的定位是有效补充。三源均已实测有原生 RSS、零鉴权、非空且近期（2026-06 实测：GitHub Blog 10 条 / Changelog 10 条 / Lobsters 25 条，均近 2 日内更新），可**零新代码**经现有 RSS collector 接入，成本极低。

为何走提案而非直接改 config（上一轮 Mistral/Microsoft 是直接改的）：这三源与 T1 不同，是**非 AI-only 的次级 / 社区源**，会引入噪音。需要把「为何纳入、靠什么治噪、是否进实时告警链、vendor 怎么标」这几个决策显式登记进 spec，而不是埋在一行 env 配置里——否则后续贡献者看到 feed 列表里混进 Lobsters 会困惑其去留。

## 变更内容

- **新增 3 个 RSS feed**（纯 `RSS_FEEDS` 配置，复用现有 `source='rss'` + vendor provenance 机制，**无新代码路径**）：
  - GitHub Blog `https://github.blog/feed/`，vendor=`github`
  - GitHub Changelog `https://github.blog/changelog/feed/`，vendor=`github`（与 Blog 同 vendor，由 `metadata.feed_url` 细分）
  - Lobsters `https://lobste.rs/rss`，vendor=`lobsters`
- **登记「RSS 源分层与噪音治理」策略**：明确 T1 大厂官方（高信号）与次级 / 社区源（GitHub Blog/Changelog、Lobsters，较低信号、非 AI-only）共用 `source='rss'`；噪音治理交给下游**既有闸**（`IMPORTANCE_FLOOR` + Value Judge + 日报 `should_push`），**采集期不做源级排除**。
- **登记 vendor 命名约定扩展**：允许**多个 feed 映射到同一 vendor**（GitHub Blog + Changelog 同为 `github`，由 `metadata.feed_url` 区分两个 feed）；社区聚合源（无单一厂商）取**描述性来源标记**（Lobsters=`lobsters`）而非 `null`，以保留 provenance。
- **登记实时告警链后果与本期决策**：因 `REALTIME_NEWS_SOURCES` 含 `rss` 且无 feed 级粒度，这三源条目会自动进高频告警链；本期**接受**此行为、依赖 `ALERT_IMPORTANCE_THRESHOLD`（默认 85，严于日报）过滤，**不**引入 feed 级告警黑名单（见非目标）。

## 功能 (Capabilities)

### 新增功能
（无——不引入新能力，RSS collector / registry / env schema 既有能力已覆盖采集机制。）

### 修改功能
- `source-collectors`: 新增一条「RSS 源分层与噪音治理 + vendor 多映射约定」需求，formalize：① 次级 / 社区源（非 AI-only）的纳入策略与下游治噪职责边界；② 多 feed 同 vendor 的标记约定与社区聚合源 vendor 取值；③ 次级源经实时告警链的本期处置（依赖 `ALERT_IMPORTANCE_THRESHOLD` 阈值而非源级排除）。**采集机制本身（`source_item_id` fallback 链、源内幂等、单源失败隔离、vendor provenance 落 `metadata`）不变**——仅新增策略性需求，不修改既有需求的判定。

## 影响

- **配置**：`.env.example` 的 `RSS_FEEDS` 追加 3 条 `url|vendor`；同步本地 `.env` 与远端 ts.mac-mini `~/ai-radar/.env`，`docker compose --profile app up -d --force-recreate --no-deps worker` 生效（运维流程，非代码）。
- **代码**：**无 `src/` 变更**。RSS collector、collector registry、env schema、告警链、日报链均不改。
- **下游**：每日候选与（满足告警全部条件时，含 `importance_score >= ALERT_IMPORTANCE_THRESHOLD`，默认 85）实时告警的输入条目增多；噪音由既有闸吸收——**Value Judge 输出语义布尔 `should_push`**（LLM 直出字段，非程序数值比较）+ **程序确定性闸 `IMPORTANCE_FLOOR`（默认 60）** + Top N 名额竞争。次级源须 Value Judge 判 `should_push=true` 且 `importance_score >= IMPORTANCE_FLOOR` 才进 Top N 排序（实际候选条件见 `src/selection/top-n.ts`；注：LLM 输出字段名为 `importance`，落库列名为 `importance_score`）。
- **spec**：`source-collectors` 增量需求，归档时同步进主规范。

## 非目标

- **不引入 feed 级告警黑名单 / 源级 `should_push` 门槛**：噪音先靠既有闸；若实测告警噪音偏高再单独提案加 feed 级粒度（届时才需改 `REALTIME_NEWS_SOURCES` 粒度或加 feed-level opt-out 代码）。
- **不接 HN Show HN**：走第三方 `hnrss.org` 还是改现有 HN collector 接官方 Algolia API 未定，单列后续提案。
- **不接 xAI / Perplexity**（整站 Cloudflare 拦 bot，`rss-parser` 拉不到）、**Anthropic / Meta**（无原生 RSS，属 T2 HTML 抓取，仍留 T2 次批）。
- **不改 `REALTIME_NEWS_SOURCES` 子集粒度**（保持 source 级）；不动 arXiv / Product Hunt / HN / GitHub-repo（`source='github'` Search API）等既有源。
- **不把确定性状态交给 LLM**：源级筛选、去重、幂等、推送状态仍由程序 + DB 保障，LLM 只做语义价值判断。
