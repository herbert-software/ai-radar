## MODIFIED Requirements

### 需求:每日定时单队列顺序编排

日报产品段编排必须在「产品塌缩（collapseProductsOnce，channel-blind 一次）之后、per-channel 产品候选之前」插入一次 **channel-blind 产品中文化步骤**（见 capability product-chinese-digest / product-discovery）；中文化候选 = 各 channel 推送候选的精确并集（消除覆盖边缘，见 product-discovery）。该步骤**永不向上抛**，且产品中文化失败**不累加任何熔断分母、不中止流水线**（events digest 降级率熔断是 events/judge 独立分母，产品段延续「失败不拖垮新闻」）；但整步失败数/失败率异常须单独告警（系统故障可观测，「不进熔断」≠「无监管」）。**失败语义与 events 编排不同规格**：Agent 内核（summarizeProduct）与 events 同规格，但编排零件对称 collapseProductsOnce（永不抛）、非 events digest 的「非业务异常 rethrow + 熔断」。日报新品段渲染必须由「仅英文产品名 + 链接」改为「中文译名（回退英文名）+ 中文简介要点行（套**产品专属上限 `PRODUCT_TAGLINE_MAX`** 截断、**非 events HEADLINE_MAX**、与 schema cap 同一常量；无则省略要点行、退纯标题）」，Telegram 与飞书两渲染口径一致；段共享预算 / 截断 / includedIds / 双段幂等口径不变。

#### 场景:产品中文化阶段编排在塌缩后候选前
- **当** 日报流水线执行到产品段（judge/digest 熔断之后、早退之前）
- **那么** 先 collapseProductsOnce（channel-blind 一次），再 channel-blind 产品中文化一次，再 per-channel 产品候选；中文化失败不中止流水线、不进熔断分母

#### 场景:新品段渲染中文译名与简介
- **当** 渲染日报新品段、产品已中文化
- **那么** 渲染中文译名 + 中文简介要点行（套既有长度上限 / 截断 / 转义）；未中文化的产品回退英文名、省略要点行

#### 场景:产品中文化失败不拖垮日报但可观测
- **当** 某产品中文化业务失败（ProductDigestFailureError）或整步遇系统异常（DB 断连）
- **那么** 该产品回退英文名照常推送，流水线不中止、不进 events 熔断分母、要闻段不受影响；但整步失败数异常须单独告警（不进熔断 ≠ 无监管、防系统故障静默）
