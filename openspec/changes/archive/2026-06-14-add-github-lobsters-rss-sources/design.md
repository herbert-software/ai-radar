## 上下文

ai-radar 的 RSS collector（`src/collectors/rss.ts`）已支持任意 feed：读 `env.RSS_FEEDS`（`url|vendor` 列表，由 `src/config/env.ts` 的 `rssFeedList` 解析为 `{url, vendor}[]`），每条目标成 `source='rss'` 并把 `{vendor, feed_url}` 落 `metadata`。新增 RSS 源通常**零代码**——上一轮接 Mistral / Microsoft AI 即纯改 `RSS_FEEDS`（commit `b4c135c`）。

本期三个候选已实测（2026-06，curl + 生产 `rss-parser` 双验）：
- GitHub Blog `https://github.blog/feed/` — 200 RSS，10 条，最新 06-12
- GitHub Changelog `https://github.blog/changelog/feed/` — 200 RSS，10 条，最新 06-12（含 Copilot / Actions 等产品更新）
- Lobsters `https://lobste.rs/rss` — 200 RSS，25 条，最新 06-12

与 T1 大厂官方源的区别：这三源**非 AI-only**。GitHub Blog/Changelog 是平台全量动态（含非 AI 内容），Lobsters 是泛技术社区聚合。引入后噪音上升，需明确治噪职责。

约束（不可违背，见 CLAUDE.md / QA.md）：源级筛选、去重、幂等、推送状态由程序 + DB 保障，不交给 LLM；LLM 只做语义价值判断。确定性工作流 + DB 状态 + Agent 语义判断分层不变。

## 目标 / 非目标

**目标：**
- 经纯配置接入上述 3 源，复用现有 RSS collector + vendor provenance，**不新增任何 `src/` 代码路径**。
- 把「次级 / 社区源的纳入策略 + 治噪职责 + vendor 多映射约定 + 告警链处置」登记进 `source-collectors` spec，使决策可追溯。

**非目标：**
- 不写专用 collector（GitHub Blog/Changelog/Lobsters 全是标准 RSS，RSS collector 已覆盖）。
- 不引入 feed 级 / 源级的 `should_push` 门槛或告警黑名单（噪音先靠既有闸）。
- 不接 HN Show HN、xAI、Perplexity、Anthropic、Meta（理由见 proposal 非目标）。
- 不改 `REALTIME_NEWS_SOURCES` 子集粒度（保持 source 级）。

## 决策

### D1：纯配置接入，复用 RSS collector，不写新代码
三源均为标准 RSS/Atom，`rss-parser` 已能解析（实测 GitHub Blog/Changelog 各 10 条、Lobsters 25 条，title / publishedAt / source_item_id fallback 链均正常）。
- **替代方案**：为 GitHub 写专用 collector（调 GitHub Blog API）/ 为 Lobsters 调其 JSON API。**否决**——无收益，RSS 已够；专用 collector 还要扩 `CollectorSource` 枚举、注册 registry、加测试，违背最小改动。

### D2：vendor 命名 —— GitHub Blog/Changelog 同标 `github`，Lobsters 标 `lobsters`
现有 vendor 取值是**公司/厂商名**（`openai` / `deepmind` / `huggingface` / `mistral` / `microsoft`）。
- GitHub Blog 与 Changelog 同属 GitHub 一家公司 → 两个 feed **共用 vendor=`github`**，`metadata.feed_url` 落不同值以**保留** blog/changelog 的细分维度（本期下游尚无消费方读取它，仅落库留存 provenance，供未来评分/展示消费——见 D2 末与风险条）。这引入「多 feed 映射同一 vendor」的新模式（既往是 1 feed = 1 vendor），但机制上无碍：`source_item_id` 用命名空间化 guid（`sha256(feed_url ‖ '\0' ‖ guid)`，分隔符为 NUL 字节，与 spec/code/test 一致）保证两 feed 不串号。
  - **替代方案**：`github_blog` / `github_changelog` 两个独立 vendor。**否决**——把 feed 类型塞进 vendor 字段，破坏「vendor = 公司」语义；blog/changelog 的区分已由 `feed_url` 承载，不必污染 vendor。
- 注意**不与 `source='github'`（GitHub Search API repo 采集器）冲突**：那是 `source` 字段取值、且其 `metadata` 是 `stargazers_count` 无 vendor；这里是 `source='rss'` + `metadata.vendor='github'`。两者 `source` 不同，可经 `source` 字段清晰区分「GitHub 平台博文」与「GitHub trending 仓库」。**无冲突的根本原因**：经全仓 grep 核实，`metadata.vendor` 当前**无任何代码按值读取/分支**（仅 env 解析时写入、入库留存），故新增 `github` / `lobsters` 取值不可能与任何下游逻辑冲突——vendor 是「写入待未来消费」的 provenance 标签。
- Lobsters 无单一厂商，但**取描述性来源标记 `lobsters` 而非 `null`**，保留 provenance（供未来评分/展示识别「来自社区聚合」；本期同样尚无消费方）。`null` 语义是「普通博客无映射」，而 Lobsters 是可识别的具名来源，标 `lobsters` 更诚实。
  - **替代方案**：vendor=`null`。**否决**——丢失来源身份，且与 Lobsters「可识别社区源」事实不符。

### D3：噪音治理 —— 全交给既有下游闸，采集期不做源级排除
次级源条目和 T1 一样进 `raw_items` → 事件塌缩 → Value Judge 评分。能否进日报由**两道既有闸**把关，分清 LLM 语义判断与程序确定性闸：① **Value Judge 输出语义布尔 `should_push`**（LLM 直出字段，非程序对 importance 的任何数值比较；经核实 prompt 仅列字段名与 `0-100` 取值范围、**不含任何如 75 的数值锚**，代码也无推导 `should_push` 的 `importance>=N` 程序闸——数字 75 仅见于 `env.ts` 注释与 realtime-alerts 主规范的**陈旧文字表述**（均措辞偏旧、按现实现 `should_push` 已是 LLM 直出布尔、与 75 无程序绑定；属既有技术债、非本提案范围），既非 prompt 内容也非运行路径）；② **程序确定性闸 `IMPORTANCE_FLOOR`（默认 60）**——与噪音治理相关的日报必要闸为 `should_push=true AND importance_score >= IMPORTANCE_FLOOR`（**这并非 Top N 候选的完整条件**，后者另含 `published_at` 时效窗口与 Model B 通道去重，见 `src/selection/top-n.ts`；注：LLM 输出字段名为 `importance`，mapping 后落库列名为 `importance_score`）。低价值的 GitHub Blog / Lobsters 条目靠 Value Judge 判 `should_push=false` 或评分低于 floor 被挡在日报外。**注意系统无「AI 相关性」硬闸**（`is_ai_related` 经 schema 解析后被丢弃、无对应列、无 gate），「非 AI-only 内容被滤掉」依赖 Value Judge 的语义判断而非确定性规则——这正是「价值判断交 LLM」分层原则的体现。**但该语义判断当前仅以代表标题为输入**（`score-events.ts` 只传 `representativeTitle`，不传 content/source/vendor），judge 既不知条目来自次级源、判别力也以标题信息量为限——见下方风险条「治噪有效性受限于 judge 仅得标题」，此乐观度边界须诚实登记。
- **替代方案**：给次级源加专门的更高 `should_push` 门槛 / 采集期按关键词预过滤。**否决**——① 属过早优化，无真实噪音数据；② 关键词预过滤是确定性硬筛，易误杀（如 Lobsters 上讨论 AI 的高价值帖）；③ 价值判断本就是 Value Judge 的职责，加源级硬门槛是把语义判断下放给规则，违背分层原则。若上线后实测日报被次级源噪音稀释，再单独提案。

### D4：实时告警链 —— 接受次级源流入，依赖 `ALERT_IMPORTANCE_THRESHOLD` 过滤
`REALTIME_NEWS_SOURCES = {rss, hacker_news, github}` 含 `rss` 且为 **source 级**粒度——无法「某 feed 进日报但不进告警」。故三源条目会进高频告警链采集与评分；是否真告警仍服从 realtime-alerts 主规范的**全部候选条件**（`importance_score IS NOT NULL AND >= ALERT_IMPORTANCE_THRESHOLD`（默认 85，纯程序）+ `published_at` 非空且在时效窗口内 + 按 **Model B**（channel-agnostic：尚未 alert-success 投递给所有已配置通道）去重 + 单轮上限 `ALERT_MAX_PER_SCAN`），`ALERT_IMPORTANCE_THRESHOLD` 只是其中 source-neutral 的重要性门槛、非唯一条件。
- 告警阈值 85 严于日报的程序闸 `IMPORTANCE_FLOOR`(60)，且告警还叠加多条候选条件（见 D4 末与 realtime-alerts 主规范：`published_at` 非空且在窗口内、Model B 一生一次去重（尚未投递给所有已配置通道）、单轮上限）。GitHub Blog / Lobsters 的日常噪音几乎不可能达 85；而 GitHub Changelog 偶有重大发布（如某次 Copilot 能力跃迁）达 85 且满足其余条件时告警**正是想要的**。故接受流入。
- **替代方案**：把 `rss` 从告警子集摘除 / 加 feed 级告警 opt-out。**否决**——① 摘除会误伤 T1 大厂官方 RSS（OpenAI 重大发布正需实时告警），不可接受；② feed 级 opt-out 需改 `REALTIME_NEWS_SOURCES` 数据结构与 `collectSources` 过滤逻辑（变成代码改动），无数据支撑其必要性。本期靠阈值兜底，留 Open Question 观察。

## 风险 / 权衡

- **[日报被次级源噪音稀释 Top N 名额]** → Top N 的核心门槛 `should_push=true（LLM 语义判断）AND importance_score >= IMPORTANCE_FLOOR(60，程序闸)`（完整候选另叠加 `published_at` 时效窗口与 Model B 通道去重）已是高门槛；次级源须 LLM 判 should_push 且评分过 floor 才占名额，等于「够好才挤进来」，可接受。上线后观察 Top N 中次级源占比，异常再提案加门槛。
- **[实时告警误报上升]** → 阈值 85 极高 + 告警一生一次去重。风险低。Open Question 留观察点。
- **[GitHub Blog/Changelog 同 vendor 导致下游误以为同 feed]** → `metadata.feed_url` 区分；`source_item_id` 命名空间化（含 feed_url）保证不串号。既有「不同 feed 相同 guid 不被误判」场景已覆盖此不变量。
- **[Lobsters 体量大刷条数]** → 25 条/次，远小于现有源合计；且经 Value Judge 与去重，入日报受 importance 闸约束。无放大风险。
- **[次级源治噪有效性受限于 Value Judge 仅得标题]** → 经核实评分流水线（`src/agents/value-judge/score-events.ts`）当前**只把代表标题喂给 Value Judge**，不传 content / source / vendor——故 judge 判 `should_push` 时**不知道条目来自次级 / 社区源**、判别全压在标题信息量上。这意味着「噪音由 Value Judge 语义判断吸收」的有效性弱于「judge 有来源感知」的直觉印象：标题信息量低的低价值次级源条目可能漏判进候选。缓解：importance 闸（`IMPORTANCE_FLOOR` / `ALERT_IMPORTANCE_THRESHOLD`）+ Top N 名额竞争 + 去重仍是兜底；judge 输入面扩展见 Open Question。本期接受此边界（属既有 judge 实现，不在「零代码」范围内修）。
- **[远端 `.env` 漂移]** → 远端用 rsync/手改且与本地 `.env` 易漂移（见部署 memory）。缓解：本地 `.env` 与 `.env.example` 与远端 `.env` 三处 RSS_FEEDS 同步改，并备份远端 `.env` 后用精确字符串替换。

## 迁移计划

纯配置 + spec，无 schema 迁移、无代码部署。步骤（沿用上一轮 Mistral/Microsoft 验证过的流程）：
1. `.env.example` 与本地 `.env` 的 `RSS_FEEDS` 追加 3 条 `url|vendor`。
2. `npx tsx` 验证 env 解析出（改动前条数 + 3）个 feed、新增 3 条 vendor 正确（确定性、不触网）；用生产 `collectRss` 实拉 3 新 feed 作一次性人工 spot-check（不进 CI），publishedAt 允许为 null（由 inference 回填）。
3. 远端 ts.mac-mini：`cp -p .env .env.bak.$(date +...)` → python3 精确 str.replace 追加新 3 条（带断言、勿假设远端绝对条数） → `docker compose --profile app up -d --force-recreate --no-deps worker` → `printenv RSS_FEEDS` 确认含新 3 条 + 启动日志出现 `已启动 N 条调度链`。
4. `/opsx:sync` 把增量规范并入主规范后归档。

**回滚**：从 `.env.bak.*` 还原远端 `.env` + force-recreate；本地 `git revert` 配置提交。无状态变更，回滚无残留。

## 待解决问题

- **次级源是否真带来增量价值**：上线后观察 GitHub Changelog / Lobsters 条目进入 Top N 与告警的实际占比与质量。若长期零入选 → 该源信号不足，提案移除；若噪音明显 → 提案加 feed 级门槛（此时才需引入 feed-level 粒度的代码改动）。
- **GitHub Blog vs Changelog 是否都要**：Changelog 偏产品更新（高信号、与工具选型定位贴合），Blog 偏综合（噪音多）。本期都接以收集数据；观察后或只保 Changelog。
- **是否给 Value Judge 传 content/source 以增强次级源判别**：当前 judge 仅得代表标题（`score-events.ts`；`JudgeRawItemInput` 虽支持 `content`/`source` 字段但流水线未传）。次级 / 社区源噪音多、标题常为裸技术名词，仅凭标题判 `should_push` 判别力有限。若上线后实测次级源噪音漏判进日报，考虑扩 judge 输入面（传 content/source/vendor 以增强判别与来源感知）——属 value-judge-agent 的代码改动、超本提案「零代码」范围，单独提案。
