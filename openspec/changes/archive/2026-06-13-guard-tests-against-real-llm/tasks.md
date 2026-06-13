## 1. 共享带守卫的 LLM 调用工厂（design D1/D2/D3）

- [x] 1.1 新建 `src/agents/llm-client.ts`：导出 `buildModel()`（复用现三份相同的 `createOpenAI({ baseURL: env.LLM_BASE_URL, apiKey: env.LLM_API_KEY, headers })` + `provider(env.LLM_MODEL)`）与守卫默认调用 `defaultGenerateObject`（签名 `(args:{model,schema:unknown,prompt})=>Promise<{object:unknown}>`，schema 取 unknown、调用方传具体 Zod schema 靠参数逆变安全接受）：函数体**先** `if (process.env.VITEST) throw new Error('测试环境（VITEST）禁止真实 LLM 调用——请注入 generateObjectFn mock')`（可操作信息），再 `generateObject({ ...args, abortSignal: AbortSignal.timeout(env.LLM_TIMEOUT_MS) })`。守卫只卡此真实路径，**不**卡 `buildModel`（createOpenAI 仅构造 provider、不触网）。
- [x] 1.2 `src/agents/value-judge/index.ts` 改用共享 `buildModel` / `defaultGenerateObject`，删本地拷贝；`GenerateObjectFn` 注入类型、重试/降级循环、`buildPrompt`、`valueJudgeOutputSchema` 用法**保持不变**（仅替换默认实现来源）。
- [x] 1.3 `src/agents/digest/index.ts` 同 1.2 改用共享工厂、删本地拷贝，其余不变。
- [x] 1.4 `src/agents/published-at-inference/index.ts` 同 1.2 改用共享工厂、删本地拷贝（注意其 schema 由 `makePublishedAtInferenceSchema(now)` 构造，传入共享 `defaultGenerateObject`（schema: unknown）须类型自洽），其余不变。
- [x] 1.5 **回退分支（仅当 1.1 泛型 schema 签名导致三模块 tsc 难收敛时启用，见 design D2）**：放弃共享 `defaultGenerateObject` 抽取，改为在三模块各自的 `defaultGenerateObject` 入口各加一行 `if (process.env.VITEST) throw ...`（守卫目标同样达成）；若启用本回退，在此任务备注「已回退三处一行守卫」并跳过 1.1 的 defaultGenerateObject 抽取（buildModel 抽取可保留或一并回退）。
  - **未触发回退**：DRY 主方案（1.1）的非泛型 `schema: unknown` 签名 `pnpm typecheck` 通过，三模块均改用共享工厂，无需回退。

## 2. 单元测试（守卫行为）

- [x] 2.1 为共享工厂（或回退时为三模块各一条）补单测：`process.env.VITEST` 为真且未注入 `generateObjectFn` → 默认路径 throw（断言抛错 + 信息含「注入 mock」指引）；注入 `generateObjectFn` mock 时**不**触发守卫、正常返回。
- [x] 2.2 断言守卫不误伤 `buildModel`：注入 mock 的用例即便走 `buildModel`（createOpenAI 构造 provider）也不 throw（沿用三模块既有注入 mock 的成功用例即可佐证）。

## 3. 验收与回归

- [x] 3.1 全量 `pnpm test`（真实 DB/Redis）**全绿且零守卫触发**——确认现有用例都已正确注入 `generateObjectFn` mock（无任一用例漏注入而触发守卫 throw）；`pnpm typecheck`、`npm run lint` 干净。
- [x] 3.2 防绕过断言：确认三个 Agent 模块的默认 LLM 调用**都经共享守卫工厂**（无任何模块直接 `generateObject(...)` 绕过守卫）；可加一条 grep/测试固化「`generateObject(` 仅出现在 `llm-client.ts`」（回退分支则改为「三处 defaultGenerateObject 均含 VITEST 守卫」）。
- [x] 3.3 生产路径不变确认：守卫仅判 `process.env.VITEST`（生产恒不设），LLM provider/model/重试/超时/降级口径零变化；以 code review + 注释固化「守卫只影响测试期」。

## 4. 规范口径同步

- [x] 4.1 确认 `platform-foundation` 增量「测试环境必须隔离生产外部出口」已写（含 LLM + 发送器两类出口、生产不受影响场景）；apply 后代码与该需求一致（守卫位置、判据、可操作信息）。归档时由 sync 合并进主规范。
