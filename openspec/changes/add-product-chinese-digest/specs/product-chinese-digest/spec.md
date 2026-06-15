## ADDED Requirements

### 需求:产品中文化 Agent 产结构化译名与简介、确定性落库

系统必须提供产品中文化 Agent（capability: product-chinese-digest），对入选日报的产品用 LLM 生成中文译名 `name_zh` + 一句话中文简介 `tagline_zh`。其 **Agent 内核**与要闻 `chinese-digest-agent` **同规格**（注意**编排契约不同规格**——编排零件永不向上抛、失败告警可观测、不进熔断、对称 collapseProductsOnce，见 daily-intel-pipeline；实现者勿照抄 events digest 的「非业务异常 rethrow + 熔断」）：经 Vercel AI SDK `generateObject` 调用（provider/model 从 env 注入），输出必须经 Zod schema 校验（`name_zh`/`tagline_zh` 均非空字符串 + 各自长度上限 + mojibake 检查），校验失败记 error + 有限重试，仍失败则抛 `ProductDigestFailureError` 降级（绝不静默吞、绝不返回未校验/半截输出）。校验通过后 `UPDATE ai_products` **仅含** `name_zh`/`tagline_zh` 两列（禁碰 name/canonical_domain/metadata/merge_conflict/last_seen 等塌缩列、禁 `INSERT ... ON CONFLICT`）。中文化**只产展示文本、绝不参与确定性状态判定**（should_push / 推送幂等 / 塌缩合并由程序 + DB）。输入为产品 `name` + 原始英文描述 `raw_items.content`（经 `ai_products.representative_raw_item_id → raw_items.id`；content 缺则仅凭 name 产中文）。`generateObject` 经依赖注入，测试可 mock 不依赖真实 key。

#### 场景:产品中文化成功落库中文列
- **当** 对一个 `name_zh` 为 NULL 的入选产品调用中文化 Agent、LLM 产出经 Zod 校验通过的 `{name_zh, tagline_zh}`
- **那么** `UPDATE ai_products` 仅写 `name_zh`/`tagline_zh`（不碰塌缩/合并/状态列），后续候选与渲染读到中文

#### 场景:校验失败有限重试后降级回退英文名
- **当** LLM 调用抛错或输出未过 Zod 校验（空 / 超长 / mojibake），有限重试耗尽
- **那么** 抛 `ProductDigestFailureError`、该产品 `name_zh` 保持 NULL（渲染回退英文 `name`）、绝不写半截输出、不阻塞推送

#### 场景:已中文化产品幂等跳过 LLM
- **当** 产品 `name_zh` 已非 NULL
- **那么** 不再调用 LLM 中文化（幂等缓存复用，与 events 复用 summary_zh/headline_zh 同口径）

#### 场景:中文化不参与确定性状态
- **当** 产品中文化成功或失败
- **那么** 不改变 should_push / 推送幂等四元组 / 塌缩合并；中文化失败的产品仍按程序规则照常进入候选与推送（仅展示回退英文名）

#### 场景:系统异常与业务失败可观测区分
- **当** 中文化整步遇业务失败（单产品 `ProductDigestFailureError`）或系统级异常（如 DB 断连，非 `ProductDigestFailureError`）
- **那么** 两者整步均不向上抛（保护新闻链），但失败数/失败率异常须单独告警（系统故障可观测、不静默黑洞），且均不进 events 熔断分母、不中止流水线
