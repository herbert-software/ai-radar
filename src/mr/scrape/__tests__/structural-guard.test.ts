/**
 * 抓取链 SSRF 结构守卫机械验证（design D10/D12）：把「必过 SSRF chokepoint」从纪律升为 lint 错误。
 *
 * 用 `ESLint().lintText` 对绕过出站原语的写法断言报错——`src/mr/scrape/` 下：
 * - 动态 import（`await import('node:http')`）绕 import 静态分析 → `no-restricted-syntax`；
 * - computed member（`globalThis['fetch']()`）绕 dotted member 守卫 → `no-restricted-syntax`；
 * 同时验证白名单内的合法写法（`import('playwright')`）不被这两条误伤。
 *
 * 纯逻辑（用项目 flat config 跑 lintText），无 DB / 网络 / LLM。
 */
import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';

const eslint = new ESLint();

// 首个 lintText 冷启动需加载整套 flat config + typescript-eslint（~6s），超默认 5s 超时。
const ESLINT_TIMEOUT_MS = 30_000;

/** 跑 lintText 并返回 no-restricted-syntax 报错数（按 filePath 映射 flat-config files glob）。 */
async function restrictedSyntaxErrors(code: string, filePath: string): Promise<number> {
  const results = await eslint.lintText(code, { filePath });
  return results[0]!.messages.filter((m) => m.ruleId === 'no-restricted-syntax').length;
}

describe('抓取链 SSRF 结构守卫：禁动态 import 出站原语 + computed globalThis fetch', () => {
  it("src/mr/scrape/ 动态 import('node:http') → eslint 报错", async () => {
    const code = `export async function x() { return await import('node:http'); }\n`;
    const n = await restrictedSyntaxErrors(code, 'src/mr/scrape/leak.ts');
    expect(n).toBeGreaterThan(0);
  }, ESLINT_TIMEOUT_MS);

  it("src/mr/scrape/ 动态 import('node:dns') → eslint 报错", async () => {
    const code = `export async function x() { return await import('node:dns'); }\n`;
    const n = await restrictedSyntaxErrors(code, 'src/mr/scrape/leak.ts');
    expect(n).toBeGreaterThan(0);
  }, ESLINT_TIMEOUT_MS);

  it("src/mr/scrape/ computed globalThis['fetch']() → eslint 报错", async () => {
    const code = `export function x() { return globalThis['fetch']('https://e.com'); }\n`;
    const n = await restrictedSyntaxErrors(code, 'src/mr/scrape/leak.ts');
    expect(n).toBeGreaterThan(0);
  }, ESLINT_TIMEOUT_MS);

  it("src/mr/scrape/ computed global['fetch']() → eslint 报错", async () => {
    const code = `export function x() { return global['fetch']('https://e.com'); }\n`;
    const n = await restrictedSyntaxErrors(code, 'src/mr/scrape/leak.ts');
    expect(n).toBeGreaterThan(0);
  }, ESLINT_TIMEOUT_MS);

  it("合法 import('playwright') 不被 SSRF 守卫误伤", async () => {
    const code = `export async function x() { return await import('playwright'); }\n`;
    const n = await restrictedSyntaxErrors(code, 'src/mr/scrape/browser-tier.ts');
    expect(n).toBe(0);
  }, ESLINT_TIMEOUT_MS);
});
