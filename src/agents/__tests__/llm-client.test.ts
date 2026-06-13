/**
 * 共享 LLM 调用工厂的测试安全守卫单测（guard-tests-against-real-llm）。
 *
 * **纯单元、无需真实 key/DB、且零 env 残留**：`llm-client.ts` 静态 import `env`（config/env.ts
 * 加载期校验 DATABASE_URL/REDIS_URL/LLM_API_KEY/.../PRODUCT_HUNT_TOKEN 必填），故须先注入占位 env
 * 再**动态 import**（否则本套件加载期就因缺真实凭据 throw；讽刺：一个「防用真实 key」的守卫测试
 * 自己反而需要真 key 才能加载）。占位用 `vi.stubEnv` 注入、`afterAll` 经 `vi.unstubAllEnvs()`
 * **自动恢复**——不向同 worker 的后续套件遗留任何 env 改动（比 value-judge.test.ts 的 `||=` 无清理
 * 更稳；虽然 vitest isolate 默认按文件隔离已防泄漏，此处显式清理作纵深防御）。
 *
 * vitest 恒设 process.env.VITEST='true'，故 defaultGenerateObject 在本套件下必 throw——证明
 * 「测试漏注入 generateObjectFn mock 而走默认真实路径」被守卫拒绝、绝不发起真实 LLM 调用。
 * buildModel 仅内存构造 provider、不被守卫拦（注入 mock 的用例也走它，不可在此 throw）。
 */
import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest';

/** env.ts 当前全部必填项的占位值（仅过 import 期校验，不触达任何真实外部调用）。 */
const PLACEHOLDER_ENV: Record<string, string> = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/test',
  REDIS_URL: 'redis://localhost:6379',
  LLM_API_KEY: 'test-key',
  LLM_MODEL: 'openai/gpt-4o-mini',
  LLM_BASE_URL: 'https://example.invalid/v1',
  TELEGRAM_BOT_TOKEN: 'test-bot-token',
  TELEGRAM_CHAT_ID: 'test-chat-id',
  PRODUCT_HUNT_TOKEN: 'test-ph-token',
};

let buildModel: typeof import('../llm-client.js').buildModel;
let defaultGenerateObject: typeof import('../llm-client.js').defaultGenerateObject;

beforeAll(async () => {
  // vi.stubEnv 记录原值并设占位；afterAll 的 unstubAllEnvs 精确恢复，零残留（自包含、不污染他套件）。
  for (const [key, value] of Object.entries(PLACEHOLDER_ENV)) {
    vi.stubEnv(key, value);
  }
  const mod = await import('../llm-client.js');
  buildModel = mod.buildModel;
  defaultGenerateObject = mod.defaultGenerateObject;
});

afterAll(() => {
  vi.unstubAllEnvs(); // 恢复 beforeAll 经 stubEnv 改动的全部 env，不向后续套件遗留。
});

describe('llm-client 测试安全守卫', () => {
  it('VITEST 下 defaultGenerateObject 直接 throw（不发起真实 LLM 调用）', () => {
    expect(process.env.VITEST).toBeTruthy(); // 前提：vitest 恒设此变量。
    expect(() =>
      defaultGenerateObject({
        model: {} as unknown as ReturnType<typeof buildModel>,
        schema: {},
        prompt: 'x',
      }),
    ).toThrow(/VITEST|注入.*mock|禁止真实 LLM/);
  });

  it('buildModel 不被守卫拦（仅构造 provider、不触网；注入 mock 的用例也走它）', () => {
    // 守卫只卡真实网络出口 defaultGenerateObject，不卡 buildModel——否则误伤注入 mock 的用例。
    expect(() => buildModel()).not.toThrow();
  });
});
