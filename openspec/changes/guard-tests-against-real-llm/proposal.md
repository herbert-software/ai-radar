## 为什么

`src/config/env.ts` 经 `import 'dotenv/config'` 在测试时自动加载 `.env`（含真实 `LLM_API_KEY`），且 `vitest.config.ts` 无任何 env 中和。三个 Agent 模块（`value-judge`、`digest`、`published-at-inference`）各自有一份 `defaultGenerateObject`——只在**未注入 `generateObjectFn` mock** 时才走、即真实 LLM 调用路径。当前靠「测试自觉注入 mock」防真调用：任何用例一旦漏注入，就会**静默打真实生产 LLM**（产生费用 + 非确定性 + 占配额），且静默——没有任何护栏会让它当场失败。

这是 PR #10（`createTelegramSender`/`createFeishuSender` 加 VITEST 守卫防误发到生产飞书/telegram）所堵的**发送泄漏**的**同类孪生**：同一根因（测试持生产凭据 + 默认真实路径无守卫），只是这次是 LLM 出口。现在堵上，对称收口「测试绝不触达生产外部出口」。

## 变更内容

- 给三处默认（真实）LLM 调用路径 `defaultGenerateObject`（`value-judge/index.ts`、`digest/index.ts`、`published-at-inference/index.ts`）各加一道**测试守卫**：`process.env.VITEST` 为真时直接 throw。因 `defaultGenerateObject` 仅在「未注入 `generateObjectFn`」时被调用，该守卫只在「测试漏注入 mock」时触发——**保证测试绝不发起真实 LLM 网络调用**（首要目标，绝对达成）；漏注入的用例随后经各自链路失败暴露而非静默通过（value-judge/digest 经逐条降级→阶段熔断，published-at 经 backfill「判不出」，最终使依赖真实产出的用例失败），并在日志留下守卫的可操作信息。注入 mock 的用例永不触达此路径，零影响。
- 可选（design 决策）：把三处近乎重复的 `defaultGenerateObject` + `buildModel` 抽成一个**共享的、带守卫的 LLM 调用工厂**，消除三份拷贝、守卫只写一处（DRY）。
- 同步把 PR #10 已落地的「发送器测试守卫」与本次「LLM 测试守卫」一并记入规范，作为一条跨切「测试隔离生产外部出口」不变量（补回 #10 当时未走规范的口径）。
- 验收：补单测断言守卫在 VITEST 下确实 throw；跑全量套件确认**零用例触发守卫**（即无任何用例漏注入 mock 而打真实 LLM），typecheck/lint 干净。

## 功能 (Capabilities)

### 新增功能
<!-- 无新增 capability -->

### 修改功能
- `platform-foundation`: 新增一条「测试环境必须隔离生产外部出口」需求——测试（`process.env.VITEST`）下，外部**发送器**（telegram/飞书）与外部 **LLM** 调用的默认真实路径必须被守卫拒绝（throw），强制测试注入 mock/桩；漏注入的用例绝不静默触达生产（守卫拒绝真实调用；用例经降级/熔断/断言失败暴露）。涵盖 PR #10 已实现的发送器守卫与本次新增的 LLM 守卫。

## 影响

- 代码：
  - `src/agents/value-judge/index.ts`、`src/agents/digest/index.ts`、`src/agents/published-at-inference/index.ts` 的 `defaultGenerateObject`（加守卫；若 DRY 抽取则改为复用共享工厂）。
  - 可能新增一个共享 LLM 调用工厂模块（如 `src/agents/llm-client.ts`），三模块改为引用（design 定夺；不抽取则各加一行守卫）。
  - 测试：三模块各补/复用一条「VITEST 下默认路径 throw」单测；全量套件须在守卫下保持全绿。
- 行为：仅测试期行为（守卫）；**生产运行时 LLM 调用路径、provider/model/重试/超时/降级口径完全不变**（守卫只看 `process.env.VITEST`，生产恒不设此变量）。
- 配置：不新增 env；不动 `.env.example`。
- 文档：`platform-foundation` spec 增「测试隔离生产外部出口」需求；与 PR #10 的发送器守卫口径合并陈述。

## 非目标

- 不改 LLM provider / model / baseURL / 重试 / 超时 / 降级等任何生产行为。
- 不移除 `generateObjectFn` 等依赖注入缝（它们正是测试注入 mock 的正道）。
- 不为测试引入独立 `.env.test` 或 dotenv 加载改造（守卫已是稳健兜底；env 隔离方案如需可另案）。
- 不动已由 PR #10 落地的发送器守卫实现（本次仅在规范层把它与 LLM 守卫合并陈述，不重写代码）。
- 不加运行时（生产）对 LLM key 的额外校验——`env.ts` 既有 `LLM_API_KEY` 必填校验不变。
