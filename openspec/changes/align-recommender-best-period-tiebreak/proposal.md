## 为什么

比价页（`add-model-radar-multi-period-web-view`，已合并 PR #57）新增的 `bestPeriod`（render.ts）对**同币种季/年付 `effectiveMonthly` 并列最低且均严格低于月价**的平局，确定性择 **annual**（更长承诺）。而 5e 推荐器 `recommend.ts` 的 `bestPeriodReason` 平局规则是**数组顺序相关**——`build.ts` 按 `billing_period` 排序使周期顺序为 `[annual, quarterly]`，reduce 的 `... === acc.effectiveMonthly && acc.billingPeriod !== 'monthly'` 会切到后出现的 **quarterly**。结果：同一 plan 在同一平局下，比价页显示「最佳周期·年付」而 MCP 推荐器话术说「最佳周期=季付」，两个展示面互相矛盾（review-loop 中 Codex/CR/RC 三方均命中，判为 out-of-scope followup，即本提案）。

## 变更内容

- **对齐平局规则（仅周期↔周期）**：把 `bestPeriodReason` 的 tie-break 从「数组顺序相关」改为**确定性偏好序**，与比价页一致——相等有效月价时，偏好序为 `monthly > annual > quarterly`（严格更低者始终胜出不变）。即：
  - 周期↔周期平局（如 quarterly==annual，均严格低于月价）→ 择 **annual**，与比价页 `bestPeriod` 一致。
  - **月付语义不变**：推荐器仍把 monthly 作为候选并在 monthly 最低（含 monthly 与某周期相等）时报「最佳周期=月付」——等价成本不建议锁期，与比价页「无周期徽标 = 默认月付」的可观测结果一致。这与比价页刻意不同的 monthly 处理（比价页只在周期**严格低于**月价时才标）保持各自语义，本期**不**改。
- 仅改 `bestPeriodReason` 内 `reduce` 的比较判定；不动召回、候选 schema、排名（仍按 canonical 月价）、解释模板、其他任何推荐逻辑。

### 非目标

- **不改比价页**（`bestPeriod`/components 已是对齐目标，不动）。
- **不统一两面的 monthly 语义**：比价页「周期须严格低于月价才标」与推荐器「monthly 作候选、可报最佳周期=月付」是既定的不同呈现语义；本期只对齐**周期↔周期平局**这一处分歧，不动 monthly 处理。
- **不处理「月价未核 + 某周期已核」的呈现分歧**：推荐器在 canonical 月价 `priceStatus!=='known'` 时，`currency` 回退 `preferredCurrency`、且**无严格低于基线的门控**，故会对 `insufficient_data` plan 也报「最佳周期=年付/季付」（recommend.ts:104/174 在 known-check 之前）；而比价页 `bestPeriod` 因无月价基线返回 null（无徽标）。这是**独立于本次 tie-break、且独立于 monthly-候选语义**的第三处分歧，**本期不处理**（是否让推荐器在无基线时也抑制最佳周期属另一处语义决策，留后续）。本提案「与比价页一致」的口径**仅限周期↔周期平局**，不主张两面在此情形下全等。
- **不抽取共享函数**：两处实现体量小、语义有意不完全相同（monthly 处理、无基线处理均不同），强行抽共享反增耦合；只对齐 tie-break 规则即可（若日后 monthly / 无基线语义也要统一再议）。
- 不改 cheapest/月价排名口径；不接 LLM/RAG（v1 仍模板）。

## 功能 (Capabilities)

### 新增功能

（无。）

### 修改功能

- `model-radar-recommender`: 明确「最佳周期」的**平局规则必须确定性且与比价页一致**——同币种周期并列最低时择 annual；等价成本下 monthly 优先于任何周期（不建议为零节省锁期）。此前 spec 未定义 tie-break，导致实现落到顺序相关。

## 影响

- **代码**：`src/mr/recommend/recommend.ts`（`bestPeriodReason` 的 `reduce` 比较判定，约 3 行）。
- **测试**：`src/mr/recommend/__tests__/`（新增/补：同币种 quarterly==annual 平局 → 报 annual；monthly==annual 平局 → 报 monthly；顺序无关——构造两种 periodPrices 顺序均得同结果）。
- **无 data/API/schema 改动**；无跨模块影响；不碰比价页与 money-path。
- **红线**：最佳周期是附加信息、不改月价排名；纯 tie-break 规则对齐。
