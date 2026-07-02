## 1. 对齐 tie-break

- [x] 1.1 `src/mr/recommend/recommend.ts` `bestPeriodReason`：把 `reduce` 平局判定改为固定偏好序 `monthly > annual > quarterly`（rank 映射 monthly=3/annual=2/quarterly=1；`effectiveMonthly` 严格更低者先胜，相等时取 rank 更高者）；与 `periodPrices` 顺序无关。monthly 候选语义不变（D1/D2）。**rank 映射必须键于 `options` 的本地联合类型 `'monthly'|'quarterly'|'annual'`，不可用 `MrBillingPeriod`**（该 enum 仅 `quarterly|annual`、缺 monthly，会漏臂/编译失败——monthly 是从 `currentPrice` 合成的候选、非 periodPrice）
- [x] 1.2 确认严格更低分支先于平局分支求值，不影响「周期严格低于月价」正常胜出（D3 回归点）

## 2. 测试

- [x] 2.1 同币种 quarterly==annual 且均严格低于月价 → 报「年付」（与比价页一致）。**用 bit-精确相等的价**：季付价 30（→10）、年付价 120（→10），月付 > 10（如 15）；否则 `price/3` vs `price/12` 不 bit-相等会经 strict-lower 分支静默解决、根本不触发 rank 平局臂
- [x] 2.2 顺序无关：固定已核 monthly `currentPrice`（如 15）+ 两条 `periodPrices`（季付 30、年付 120，均 →10），以 `[annual, quarterly]` 与 `[quarterly, annual]` 两序输入均得「年付」（monthly 非 periodPrice、由 currentPrice 合成，勿放进 periodPrices 数组）
- [x] 2.3 monthly==annual 平局（无更低）→ 报「月付」（等价不锁期）：monthly `currentPrice`=10、年付价 120（→10）
- [x] 2.4 回归：某周期严格更低 → 仍报该周期；异币种周期不参与；token_plan 不生成最佳周期

## 3. 验收

- [x] 3.1 `npm run lint` + `vitest run src/mr/recommend` 通过（lint 0；tsc 0；recommend 20 passed）
- [x] 3.2 `openspec-cn validate align-recommender-best-period-tiebreak` 通过
