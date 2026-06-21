## 上下文

P3 语义去重在 prod（ts.mac-mini）过度误合。审计 2362 事件/8 天的 114 条 tombstone（`sim = 1 - (embedding <=> embedding)`，标题肉眼比对）：全相似度区间误合，最高 0.988，主体是**版本/系列/序号/年份变体**（o1↔o3-mini、Gemma↔Gemma2、Update #2↔#4、Part 1↔2、Mistral 3↔3.1、GPT-5.3↔5.5、Scholars 2019↔2020）。这类标题在 embedding 空间近同形，余弦相似度天然区分不了。

`semantic-dedup` spec 既有需求「embedding 相似度候选检索与阈值分流」对 `cosine_sim > SEMANTIC_DEDUP_HIGH`（默认 0.88）做 high-auto 直接合并、`(LLM, HIGH]` 灰区交 LLM，且自登记「过合并是危险方向」并要求 provenance 可回滚。本设计在合并落库前加一道**确定性**前置否决。

约束：守第一架构原则（去重事实由程序+DB 兜底、不交 LLM）；ponytail（不引依赖、不加抽象/配置、最短可用 diff）。

## 目标 / 非目标

**目标：**
- 在 `mergeEvents` 之前加纯确定性护栏，否决「数字/版本 token 集不同」的候选合并，覆盖 high-auto 与 llm-confirmed 两路。
- 残留偏差只允许落在欠合并方向，零新增过合并。
- 一个纯函数 + 一个纯函数单测，可观测仅加一个计数。

**非目标：**
- 不抓专名差变体（Europe/Asia、Schibsted/Guardian、Teen/Child）——见风险。
- 不改 `SEMANTIC_DEDUP_HIGH`/`LLM` 分流逻辑；prod env `SEMANTIC_DEDUP_LLM` 0.75→0.82 是独立运营动作，不在本变更代码内（仅补 `.env.example` 注释）。
- 不引依赖、不加配置项、不加抽象层、不下沉到 `mergeEvents` 入口。

## 决策

**D1：吃原始 `representative_title`，不复用 `normalizeTitle`。** `normalize.ts` 第 6 步 `replace(/[^\p{L}\p{N}\s]/gu,'')` 删 `.`/`#`：`3.1→31`、`#4→4`、`GPT-5.3→gpt53`，区分 token 全毁。故护栏自带轻量小写归一。注入点两路拿到的都是 raw `representative_title`，天然满足。备选（复用 normalize）：直接否掉。

**D2：token 抽取正则 `/\d+(?:\.\d+)+|\d+/g`，小数当原子串、用 Set。** 左分支优先吞整段小数/多段版本（`5.3`、`1.2.3`），右分支整数兜底。**决定性论证**：`GPT-5 {5}` vs `GPT-5.5` 必须否决（@0.988 误合）；若把 `5.5` 拆成 `{5}` 会与 `{5}` 相等→漏判→误合保留。故小数必须原子串，不可拆。用 Set 而非多重集：`Part 2/2` 的两个 `2` 不携带额外区分信息，去重为 `{2}` 才能与 `Part 2` 同系列放行。备选（拆数字 / 多重集）：被 GPT-5↔5.5 反例与 Part 2/2 否掉。

**D3：否决谓词 = 两 Set 不相等（对称差非空）。** 都空→相等→放行（覆盖跨源同新闻、大小写差）；一侧有一侧无→否决（Gemma↔Gemma2）；完全相等→放行（GPT-5↔GPT-5 for developers）。不用「子集放宽」——D2 已证拆数字+子集会漏 5↔5.5。

**D4：护栏放编排层 `semantic-merge.ts`，不放 `mergeEvents` 入口；且前置于 LLM 调用。** 编排层 `ev.representativeTitle` 在手、候选侧有 `loadTitle` helper，无需 `mergeEvents` 多查两次标题；且落库原语不应长标题语义判断（职责分离）。在候选循环 `no-merge` 提前退出之后、tier 分支之前统一 `loadTitle(cand)` 一次，供护栏 + 灰区路 judge 复用（省一次 DB 往返）。护栏放在灰区 LLM 调用**之前**：灰区 token 不同的对直接否决、**不调 LLM**，省真实 LLM 成本（审计显示大量灰区误合正是 token 不同的版本变体）。

**D5：否决后 `continue`（不 break）。** 候选按相似度降序，但「最高相似度」≠「最该合并」——最高那条可能正是版本变体误合，真同事件可能在更低相似度的下一候选。故否决须继续扫描。与既有两个 `break`（`no-merge` 提前退出、`merged` 后退出）不冲突，`continue` 插其间。

**D6：可观测仅加计数 `vetoedByGuard`。** 被否决=没发生合并=无状态变更=无需回滚审计，计数足够；不默认 per-veto 日志（每轮会刷噪声）。需调试时临时挂一行 `logError` 即可，默认不开。

## 风险 / 权衡

- **专名差误合不抓**（Europe/Asia、Schibsted/Guardian、Teen/Child @0.896~0.923）→ 缓解：灰区部分靠 `SEMANTIC_DEDUP_LLM` 回 0.82 交 LLM 收；auto 区残留记合并 provenance（spec 既有要求）事后审计、待后续迭代。不上确定性专名护栏：标题共享大量专名，「非共享专名即否决」会大面积误否决正确跨源合并，违反「不误否决真同事件」，且专名识别需 NER/词典（违反 ponytail）。
- **欠合并方向的 false-veto**：一源点名版本号、另一源完全不含数字的同一事件会被否决，留一条重复 → 缓解：按铁律「误合比漏合更糟」这是主动选的安全方向；AI 新闻里「一方完全不提任何数字」少见，代价仅偶发一条重复。
- **嵌入式数字噪声**（`R1` 的 `1`、`o3` 的 `3` 入集）→ 对「同系列不同序号」是正确信号；对「同事件一处含代号数字一处不含」落入上一条欠合并方向，可接受。
- **非阿拉伯数字序号**（罗马数字 II/III、中文一/二/三）不处理 → 证据里序号均为阿拉伯数字，YAGNI，不预先支持。
- **千分位逗号与全角数字**不归一（`\d` 仅 ASCII）：`1,000`↔`1000` 抽出 `{1,000}`↔`{1000}` 不等 → 否决；全角 `５`↔半角 `5` 同理不匹配 → 否决。两者均落**欠合并安全方向**（最多留一条重复），不新增过合并 → 维持 YAGNI 不做 NFKC 归一；真出现高频再加。
- **护栏仅护 `semanticMergeEvents` 路径**：当前 `mergeEvents` 仅此一个调用方；若未来新增直连调用方需各自接护栏，或那时再下沉入口。

## 迁移计划

无 schema/数据迁移、无依赖变动。部署 = 常规重建镜像（worker 拉新代码）。回滚 = 回退代码即恢复旧合并行为（护栏只减合并，回滚不丢数据，tombstone 仍可回溯）。

独立运营动作（不在本变更代码内，交付清单提示用户执行）：prod `/Users/herbertgao/ai-radar/.env` 的 `SEMANTIC_DEDUP_LLM` 0.75→0.82 + 重建 worker；本变更在 `.env.example` 补注释固化「不应低于 0.82，附原因」。

## 待解决问题

- 无阻断性未决项。auto 区专名残留是否值得后续单独立项（如带轻量二次确认），留作运营观察后再定。
