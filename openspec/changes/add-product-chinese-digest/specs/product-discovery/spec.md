## MODIFIED Requirements

### 需求:每日产品发现推送

`ai_products` 必须提供中文展示列 `name_zh`（varchar，可空）+ `tagline_zh`（text，可空）；既有产品该列 NULL 视为未中文化、渲染回退英文 `name`；新增中文列与中文化步骤**绝不改**塌缩 / 硬规则合并 / merge_conflict / `selectProductCandidates` 选品口径。产品进入日报候选前必须经一次 **channel-blind 中文化前置步骤**（见 capability product-chinese-digest）：在产品塌缩之后、per-channel 候选之前执行（搭日报单例锁、不独立调度）。中文化候选 = **各 channel 正式推送候选的精确并集**——**直接复用 `selectProductCandidates`（每 channel 调用一次取 product_id）、在应用层 `Set` 去重并集**（**非手写 SQL UNION/`NOT EXISTS(inArray)`**——复用既有查询路径而非重写谓词、杜绝谓词漂移、dedup 免费；消除「channel-blind 单窗 + LIMIT」的覆盖边缘、不依赖「下次幂等补」这一对「已推 channel」不成立的自愈）；对并集中 `name_zh IS NULL` 且 **`name !== 占位常量`**（占位字面 `'(unnamed product)'` 与 product-collapse **单一来源共享**；排除防零信息输入诱发 LLM 幻觉译名）的产品 `LEFT JOIN raw_items` 取 content 中文化、落 `ai_products` 中文列；该步骤**永不向上抛**（单产品失败保持 NULL、回退英文、不拖垮新闻；整步失败数/失败率异常须告警，使 DB 断连等系统故障可观测、不静默黑洞）。`selectProductCandidates` 候选映射改为「中文译名优先回退英文」（`representativeTitle = name_zh ?? name`、产品要点 = `tagline_zh`），选品条件（merge_conflict 排除 + 跨天从未 success 窗口 + order + limit）**一字不变**。

#### 场景:产品候选携带中文译名与简介
- **当** 已中文化（name_zh/tagline_zh 非 NULL）的产品进入某 channel 候选
- **那么** 候选映射标题为中文译名、要点为中文简介；未中文化（NULL）则回退英文 `name`、无要点

#### 场景:中文化前置不改选品口径
- **当** 执行产品中文化前置步骤
- **那么** 不改变 merge_conflict 排除 / 跨天从未 success 窗口 / order / limit 选品规则，仅补充中文展示字段；中文化失败的产品仍按原规则入选（回退英文名）

#### 场景:中文化候选精确覆盖各 channel 推送候选
- **当** 某产品在 channel A 已 success 推过、在 channel B 从未 success（仍将进 B 的推送候选）
- **那么** 该产品在中文化候选的各 channel 并集内、被中文化（不因 channel-blind 单窗 LIMIT 漏覆盖某 channel 第 N 名）

#### 场景:塌缩占位名产品不中文化
- **当** 某产品 `name` 为塌缩兜底占位 `(unnamed product)`
- **那么** 不进中文化候选（零信息输入会诱发 LLM 幻觉译名）、保持占位英文、渲染回退
