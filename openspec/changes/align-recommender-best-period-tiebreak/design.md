## 上下文

两处独立的「最佳周期」实现：
- 比价页 `src/mr/web/render.ts` `bestPeriod(plan)`（PR #57）：只在同币种周期 `effectiveMonthly` **严格低于** canonical 月价时返回该周期；平局择 annual。monthly 是**基线**、不作候选（无周期严格更低 → 无徽标）。
- 5e 推荐器 `src/mr/recommend/recommend.ts` `bestPeriodReason(plan, preferredCurrency)`：把 monthly **也作候选**（可报「最佳周期=月付」），在 monthly + 已核季/年中取最低。当前平局用 `reduce`：`option.effectiveMonthly === acc.effectiveMonthly && acc.billingPeriod !== 'monthly'` → 切到后出现者。`build.ts` 周期排序令 options = `[monthly, annual, quarterly]`，故 quarterly==annual 平局落到 **quarterly**，与比价页的 annual 相矛盾。

## 目标 / 非目标

**目标：** 让推荐器与比价页对**周期↔周期平局**给出一致的最佳周期（annual），消除同一 plan 跨面矛盾；平局判定确定性、与输入顺序无关。

**非目标：**
- 不改比价页（`bestPeriod` 是对齐目标）。
- 不统一两面 monthly 语义（比价页「周期须严格低于月价才标」vs 推荐器「monthly 作候选、可报月付」是既定不同呈现，本期不动）。
- 不处理「月价未核 + 某周期已核」分歧：推荐器无基线时仍报周期最佳（recommend.ts:104/174 在 known-check 前、无严格低于门控），比价页返 null——**第三处分歧，独立于 tie-break 与 monthly-候选语义，本期不碰**；「与比价页一致」仅限周期↔周期平局。
- 不抽共享函数（两处 monthly / 无基线语义有意不同，强抽增耦合；只对齐 tie-break）。
- 不改召回 / 候选 schema / 月价排名 / 解释模板。

## 决策

**D1 — tie-break 改为固定偏好序 `monthly > annual > quarterly`。** 把 `bestPeriomReason` 的 `reduce` 平局判定从「顺序相关」换成基于该偏好序的比较：`effectiveMonthly` 严格更低者胜；相等时取偏好序更高者。用一个小的 rank 映射（monthly=3, annual=2, quarterly=1）实现，`reduce` 与迭代序无关。
- 备选「与比价页共用一个函数」被否：比价页把 monthly 当基线不作候选、推荐器把 monthly 当候选，语义不同，强抽会把差异塞进参数分支、反更脆。只对齐平局规则成本最低、风险最小。
- 备选「只把 `acc.billingPeriod !== 'monthly'` 改成偏好比较但不引入 rank」也可，但 rank 表达偏好序最清晰、可读、无遗漏臂。

**D2 — 保留 monthly 候选语义（推荐器专属）。** monthly 仍是推荐器候选、仍可报「最佳周期=月付」。偏好序把 monthly 置最高，等价成本时报月付（不建议锁期），与比价页「无周期徽标=默认月付」的可观测结果一致，不改推荐器既有对外语义。

**D3 — 覆盖测试锁死顺序无关。** 新增/补推荐器单测：同币种 quarterly==annual 且均严格低于月价 → 报 annual；以两种 periodPrices 顺序输入均得 annual；monthly==annual 平局 → 报 monthly；strict-lower 仍胜（回归）。

## 风险 / 权衡

- **平局极罕见**（需同币种季/年折算后**精确相等**且均低于月价）→ 影响面小，但一旦发生就是可见的跨面矛盾；确定性对齐一劳永逸。缓解：单测钉死。
- **两处仍是两份实现** → 未来若再改最佳周期语义有再次漂移风险 → 缓解：spec 明确「平局规则须与比价页一致」，为将来对齐留约束；本期不抽共享函数（monthly 语义差异使抽取不划算）。
- **偏好序把 monthly 置顶用于平局** → 确认这不会把「周期严格更低」的情形误判成月付：strict-lower 分支先行，仅在**相等**时才用偏好序，故不影响严格更低的周期胜出。
