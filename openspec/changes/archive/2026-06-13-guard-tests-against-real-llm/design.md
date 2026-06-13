## 上下文

`src/config/env.ts` 头部 `import 'dotenv/config'` 使任何测试 import `env` 时自动加载 `.env`（含真实 `LLM_API_KEY`）；`vitest.config.ts` 无 env 中和。三个 Agent 模块各自重复一份 `defaultGenerateObject` + `buildModel` + `createOpenAI`：

- `src/agents/value-judge/index.ts`（`judgeRawItem`）
- `src/agents/digest/index.ts`（中文摘要）
- `src/agents/published-at-inference/index.ts`（`inferPublishedAt`）

每处都是 `const run = options.generateObjectFn ?? defaultGenerateObject;`——`defaultGenerateObject` **仅在未注入 mock 时**被调用，即真实 LLM 网络路径。当前无护栏：测试一旦漏注入 `generateObjectFn`，就静默打真实生产 LLM。

PR #10 已对**发送器**（`createTelegramSender`/`createFeishuSender`）加了 `process.env.VITEST` 守卫堵住同类「测试误触生产出口」泄漏。本变更把同一模式延伸到 LLM 出口。

约束：① 生产运行时行为零变化（守卫只看 `process.env.VITEST`，生产恒不设）；② 不破坏现有依赖注入缝；③ `buildModel`（`createOpenAI`）只构造 provider 对象、不触网，真正的网络调用在 `generateObject`，故守卫边界在 `defaultGenerateObject` 而非 `buildModel`。

## 目标 / 非目标

**目标：**
- 测试环境下，默认（真实）LLM 调用路径被守卫拒绝（throw）——**保证测试绝不发起真实 LLM 网络调用**（首要目标，绝对达成）；漏注入 mock 的用例不再静默真打生产 LLM，而是经各自链路（value-judge/digest 逐条降级→熔断，published-at→backfill 判不出）失败暴露。
- 守卫成为**单一事实来源**，杜绝「新 Agent 复制旧的无守卫默认路径」使该泄漏类复发。
- 全量套件在守卫下零触发（确认现有用例都已正确注入 mock）。

**非目标：**
- 不改 LLM provider/model/baseURL/重试/超时/降级等生产行为。
- 不移除 `generateObjectFn` 注入缝。
- 不引入 `.env.test` 或 dotenv 加载改造。
- 不重写 PR #10 的发送器守卫实现（仅在规范层合并陈述）。

## 决策

### D1：守卫边界 = `defaultGenerateObject`（真实路径），判据 `process.env.VITEST`
在默认 LLM 调用实现处加 `if (process.env.VITEST) throw new Error(...)`。理由：
- `defaultGenerateObject` 只在 `options.generateObjectFn` 未注入时被 `??` 兜底调用——它**就是**「没人注入 mock」的真实路径。注入 mock 的用例永不触达，零误伤。故无需再判「是否注入」，进到这里即应拒。
- 守卫**不放 `buildModel`**：`createOpenAI` 仅在内存构造 provider（持 key、不触网），即便测试注入了 mock 也会走 `buildModel`（model 被传入但 mock 忽略），在此 throw 会误伤注入 mock 的正常用例。网络出口在 `generateObject`，故守卫必须在 `defaultGenerateObject`。
- 判据用 `process.env.VITEST`（vitest 恒设 `VITEST=true`），与 PR #10 发送器守卫同口径，生产恒不设。

### D2：DRY——抽取共享「带守卫的 LLM 调用工厂」，而非三处各加一行
**决策：新增 `src/agents/llm-client.ts`**，导出：
- `buildModel()`：复用现有三份完全相同的 `createOpenAI({ baseURL, apiKey, headers })` + `provider(env.LLM_MODEL)`。
- 一个**守卫默认调用** `defaultGenerateObject`：签名 `(args: { model, schema: unknown, prompt }) => Promise<{ object: unknown }>`（schema 取 `unknown`——`generateObject` 不透明消费 schema，phantom 泛型参数零收益；调用方各传具体 Zod schema，靠函数参数逆变安全接受，`tsc` 已验证），内部先 `if (process.env.VITEST) throw`，再 `generateObject({ ...args, abortSignal: AbortSignal.timeout(env.LLM_TIMEOUT_MS) })`。

三个 Agent 模块改为 import 共享 `buildModel` / `defaultGenerateObject`，删除各自的本地拷贝；各自的 `GenerateObjectFn` 注入类型、重试/降级循环、prompt 构造**保持不变**（仅替换默认实现来源）。

**理由（为何 DRY 而非三处一行）**：① 守卫是**安全不变量**，单一事实来源能防「第 4 个 Agent 复制旧无守卫默认路径」——而三份拷贝正是本泄漏类的结构性根源（与 PR #10 发送器两处拷贝同形）；② 三份 `defaultGenerateObject`/`buildModel` 本就近乎逐字重复，抽取顺带消除既有重复；③ 守卫逻辑只写一次、不漂移。

**替代方案（考虑后不采为主，留作回退）**：三处各加一行 `if (process.env.VITEST) throw`。优点是零结构改动、最低风险；缺点是三份守卫拷贝、易漂移、不防复制扩散。**回退条件**：若 apply 期共享 `schema: unknown` 签名导致三模块 tsc 类型不兼容难以收敛，则退回三处各加一行守卫（安全目标同样达成），并在 tasks 标注采用了回退。

### D3：抛错信息可操作
守卫 throw 的信息须指明「测试环境禁止真实 LLM 调用——请注入 `generateObjectFn` mock」，与发送器守卫信息同风格，让漏注入的用例一眼知道怎么修。

### D4：规范层把发送器守卫 + LLM 守卫合并为一条跨切不变量
在 `platform-foundation` 增「测试环境必须隔离生产外部出口」需求，统述：测试下外部发送器与 LLM 的默认真实路径必须被守卫拒绝、强制注入 mock。这补回 PR #10 发送器守卫当时未走规范的口径，并把本次 LLM 守卫纳入同一不变量（单处规范、避免日后两套口径漂移）。

## 风险 / 权衡

- [DRY 抽取触碰三个在跑模块 → 引入回归] → 三模块的注入缝/重试/降级/prompt 全部保持不变，仅换默认实现来源；apply 后跑全量套件 + typecheck 验证；共享 `schema: unknown` 签名若难收敛则按 D2 回退三处一行。
- [守卫漏判某真实路径（如某模块未来直接调 `generateObject` 不走共享工厂）] → D4 规范不变量 + code review 守住「所有外部 LLM 调用走共享守卫工厂」；可选加一条 grep 断言（CI/测试）防绕过。
- [某测试本意就是打真实 LLM（冒烟）被守卫挡住] → 现有套件无此用例（全部注入 mock）；如未来需真实冒烟，应放在显式、默认跳过、需真 key 才跑的专门冒烟脚本（非 VITEST 单测），不破坏本守卫。
- [VITEST 之外的测试运行器] → 本仓库统一用 vitest（`VITEST` 恒设）；若引入他者另议。

## 迁移计划

1. 新增 `src/agents/llm-client.ts`（共享 `buildModel` + 守卫 `defaultGenerateObject`）；三模块改用之、删本地拷贝（或按 D2 回退三处一行守卫）。
2. 补单测：三模块（或共享工厂）各一条「VITEST 下默认路径 throw」断言。
3. 跑全量 `pnpm test`：确认零用例触发守卫（无漏注入）、全绿；`pnpm typecheck`、`npm run lint` 干净。
4. 同步 `platform-foundation` 规范增量（D4）。
5. 回滚：纯代码回滚（revert）即恢复；无 DB/配置迁移。

## 待解决问题

- 无（DRY vs 三处一行已在 D2 决定，且给了明确回退条件）。
