## 新增需求

### 需求:测试环境必须隔离生产外部出口

系统必须保证：在测试环境（`process.env.VITEST` 为真）下，任何**外部出口**的**默认（真实）调用路径**被守卫拒绝（throw），强制测试注入 mock / 桩，绝不让用例静默触达生产。外部出口涵盖：

- **消息发送器**：`createTelegramSender`（grammY）与 `createFeishuSender`（webhook）。
- **LLM 调用**：三个 Agent 模块（value-judge / digest / published-at-inference）的默认 `generateObject` 调用路径（即未注入 `generateObjectFn` 时的兜底实现）。

根因：`config/env.ts` 经 `import 'dotenv/config'` 使测试自动加载 `.env`（含真实 `TELEGRAM_*` / `FEISHU_*` / `LLM_API_KEY`），且测试运行器无 env 中和；若默认真实路径无守卫，任一用例漏注入 mock 即静默真发到生产飞书/telegram 或真打生产 LLM（刷屏 + 费用 + 非确定性）。

守卫判据必须为 `process.env.VITEST`（vitest 恒设、生产恒不设），故**生产运行时行为完全不受影响**——provider / model / 重试 / 超时 / 降级 / 发送口径均不变。守卫必须卡在**真实网络出口路径**：发送器在「未注入真实 transport（telegram 的 api / 飞书的 fetchImpl）」时 throw；LLM 在默认 `generateObject` 实现（仅在未注入 `generateObjectFn` 时被调用）入口 throw——**不得**卡在 `createOpenAI`/`buildModel` 这类仅构造 provider、不触网的步骤上（否则误伤已注入 mock 的用例）。守卫抛错信息必须可操作（指明「测试禁止真实调用，请注入 mock」）。

> 本需求把 PR #10 已落地的发送器守卫与本次新增的 LLM 守卫合并为同一条跨切「测试隔离生产外部出口」不变量，作为单一事实来源，防新增 Agent / 发送器复制旧的无守卫默认路径使该泄漏类复发。

#### 场景:测试下默认 LLM 调用被守卫拒绝
- **当** 某测试用例调用某 Agent（value-judge / digest / published-at-inference）但**未注入** `generateObjectFn` mock，致其走默认真实 `generateObject` 路径
- **那么** 守卫在 `process.env.VITEST` 下直接 throw（可操作错误信息），**绝不发起真实 LLM 网络调用**（首要保证，绝对成立）；该用例随后经各自链路（value-judge/digest 逐条降级→熔断，published-at→backfill 判不出）失败暴露，而非静默通过

#### 场景:测试下默认发送器被守卫拒绝
- **当** 某测试用例使通道集回退到真实发送器（未注入 telegram 的 api / 飞书的 fetchImpl，未注入 mock sender、未钉 channels）
- **那么** `createTelegramSender` / `createFeishuSender` 在 `process.env.VITEST` 下 throw，该用例当场失败，绝不真发到生产 chat / webhook

#### 场景:注入 mock 或桩的用例不被守卫误伤
- **当** 用例已注入 `generateObjectFn` mock（LLM）或注入 transport 桩 / mock sender / 钉定 channels（发送器）
- **那么** 守卫不触发，用例正常执行——守卫只拦「漏注入而回退真实出口」，不拦正确注入的用例

#### 场景:生产运行时不受测试守卫影响
- **当** 应用在生产运行（`process.env.VITEST` 未设）执行日报 / 告警 / 评分 / 摘要 / 发布时间推断
- **那么** 默认真实发送器与 LLM 调用路径照常工作，守卫恒不触发，行为与守卫引入前完全一致
