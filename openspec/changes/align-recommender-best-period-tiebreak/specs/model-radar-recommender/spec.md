## 新增需求

### 需求:最佳周期平局规则必须确定性且与比价页一致

推荐器选定候选「最佳周期」时 MUST 使用确定性规则，MUST NOT 依赖 `periodPrices` 数组顺序（或任何输入排序）。在同币种候选口径（monthly canonical 月价 + 已核季/年有效月价）中，`effectiveMonthly` **严格更低**者始终胜出；当两个或多个口径 `effectiveMonthly` **相等（平局）**时，MUST 按固定偏好序择一：`monthly > annual > quarterly`。即：等价成本时 monthly 优先（不建议为零节省锁定预付周期）；两周期平局时择更长承诺的 **annual**，与比价页能力 `model-radar-compare-web` 的 `bestPeriod` 判定一致（避免同一 plan 在推荐器与比价页对同一平局给出相互矛盾的最佳周期）。Token Plan 不生成最佳周期（不变）。此规则仅决定「最佳周期」附加标注，MUST NOT 改变候选按 canonical 月价的 primary/alternative 排名。

#### 场景:同币种季年有效月价平局择年付
- **当** 某候选季付与年付 `effectiveMonthly` 相等、同币种、且均严格低于其 canonical 月价
- **那么** 最佳周期报「年付」（与比价页一致），且不因 `periodPrices` 顺序不同而改变

#### 场景:月付与周期等价成本报月付
- **当** 某候选 canonical 月价的有效月价与某已核周期有效月价相等，且无更低者
- **那么** 最佳周期报「月付」（等价成本不建议锁期），不报该周期

#### 场景:平局结果与输入顺序无关
- **当** 同一组周期价以 `[..., annual, quarterly]` 与 `[..., quarterly, annual]` 两种顺序分别输入
- **那么** 两次得到相同的最佳周期结论
