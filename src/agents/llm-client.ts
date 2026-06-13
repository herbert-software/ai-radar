/**
 * 共享 LLM 调用工厂（guard-tests-against-real-llm，design D1/D2/D3）。
 *
 * 三个 Agent 模块（value-judge / digest / published-at-inference）原本各自重复一份
 * `buildModel` + `defaultGenerateObject` + `createOpenAI`。本模块抽取为单一事实来源：
 * - `buildModel()`：按 env 构造 OpenAI 兼容 provider + model（仅内存构造、不触网）。
 * - `defaultGenerateObject(...)`：默认（真实）`generateObject` 调用——**仅在调用方未注入
 *   `generateObjectFn` mock 时**被 `??` 兜底使用，即真实 LLM 网络路径。
 *
 * **测试安全守卫（关键不变量，design D1）**：`process.env.VITEST` 为真时，`defaultGenerateObject`
 * 直接 throw——把「测试漏注入 mock 而走默认真实路径」从静默真打生产 LLM 变成失败。守卫只卡
 * `defaultGenerateObject`（真实网络出口），**不卡 `buildModel`**（createOpenAI 仅构造 provider、
 * 不触网，且注入 mock 的用例也会走 buildModel，在此 throw 会误伤）。判据 `process.env.VITEST`
 * 与发送器守卫（push/telegram.ts、push/feishu.ts）同口径，**生产恒不设此变量、行为零变化**。
 *
 * 注：与发送器守卫同理，守卫只保证「测试绝不发起真实 LLM 网络调用」；漏注入的用例随后经各自
 * 链路的降级/熔断/断言失败暴露（value-judge/digest 逐条降级→阶段熔断；published-at→backfill
 * 判不出；最终都使依赖真实产出的用例失败），并在日志留下本守卫的可操作信息。
 */
import { generateObject } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { env } from '../config/env.js';

/** OpenAI 兼容 language model 句柄类型（三模块 GenerateObjectFn 的 model 形参类型）。 */
export type LlmModel = ReturnType<ReturnType<typeof createOpenAI>>;

/** 默认 LLM 调用的最小入参（schema 用 unknown：各模块传各自的 Zod schema，宽松兼容）。 */
export interface DefaultGenerateObjectArgs {
  model: LlmModel;
  schema: unknown;
  prompt: string;
}

/**
 * 按 env 构造 provider + model（仅内存构造、不触网）。三模块共用，消除重复。
 */
export function buildModel(): LlmModel {
  const provider = createOpenAI({
    baseURL: env.LLM_BASE_URL,
    apiKey: env.LLM_API_KEY,
    headers: { 'X-Title': 'ai-radar' },
  });
  return provider(env.LLM_MODEL);
}

/**
 * 默认（真实）`generateObject` 调用，带超时；仅在调用方未注入 `generateObjectFn` 时被兜底使用。
 *
 * **测试守卫**：`process.env.VITEST` 下 throw（见模块头）——保证测试绝不发起真实 LLM 网络调用。
 * 注入了 `generateObjectFn` mock 的用例永不触达本函数，零影响。
 */
export function defaultGenerateObject(
  args: DefaultGenerateObjectArgs,
): Promise<{ object: unknown }> {
  if (process.env.VITEST) {
    throw new Error(
      'llm-client: 测试环境（VITEST）禁止真实 LLM 调用——某 Agent 未注入 generateObjectFn mock ' +
        '而走到默认真实路径。请在测试中注入 generateObjectFn（或对应 mock），' +
        '不要让默认路径触达生产 LLM。',
    );
  }
  // 加 abortSignal 超时：防一条挂起的 LLM 响应卡死阶段（超时抛错 → 走调用方既有重试/降级链路）。
  return generateObject({
    ...args,
    abortSignal: AbortSignal.timeout(env.LLM_TIMEOUT_MS),
  } as unknown as Parameters<typeof generateObject>[0]) as unknown as Promise<{
    object: unknown;
  }>;
}
