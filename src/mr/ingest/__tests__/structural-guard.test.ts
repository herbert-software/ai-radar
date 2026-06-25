/**
 * 结构守卫机械验证（task 7.7，design D7）：「抓取改不了事实」从纪律降为 lint 错误。
 *
 * 用 `ESLint().lintText` 对一段含违例 import 的代码断言报错——`src/mr/scrape/` 与
 * `src/mr/freshness/event-consumer*` import `src/mr/ingest/` 事实 writer（`upsert*` / `recordPriceChange`）
 * 必须触发 `no-restricted-imports`；同时验证：
 * - 合法 import（`src/mr/write/`）在 scrape 路径下不报该规则；
 * - 非守卫路径（如 `src/mr/ingest/` 自身）import 事实 writer **不**报错（仅抓取链/事件消费者受限）。
 *
 * 纯逻辑（用项目 flat config 跑 lintText），无 DB / 网络 / LLM。
 */
import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';

const eslint = new ESLint();

/** 跑 lintText 并返回 no-restricted-imports 报错数（按给定 filePath 映射 flat-config files glob）。 */
async function restrictedImportErrors(code: string, filePath: string): Promise<number> {
  const results = await eslint.lintText(code, { filePath });
  return results[0]!.messages.filter((m) => m.ruleId === 'no-restricted-imports')
    .length;
}

describe('7.7 结构守卫：抓取链/事件消费者禁 import 事实 writer', () => {
  it('src/mr/scrape/ import recordPriceChange → eslint 报错', async () => {
    const code = `import { recordPriceChange } from '../ingest/record-price-change.js';\nexport { recordPriceChange };\n`;
    const n = await restrictedImportErrors(
      code,
      'src/mr/scrape/fingerprint.ts',
    );
    expect(n).toBeGreaterThan(0);
  });

  it('src/mr/scrape/ import upsertPlan → eslint 报错', async () => {
    const code = `import { upsertPlan } from '../ingest/upsert.js';\nexport { upsertPlan };\n`;
    const n = await restrictedImportErrors(
      code,
      'src/mr/scrape/http-extractor.ts',
    );
    expect(n).toBeGreaterThan(0);
  });

  it('event-consumer import 事实 writer → eslint 报错', async () => {
    const code = `import { recordPriceChange } from '../ingest/record-price-change.js';\nexport { recordPriceChange };\n`;
    const n = await restrictedImportErrors(
      code,
      'src/mr/freshness/event-consumer.ts',
    );
    expect(n).toBeGreaterThan(0);
  });

  it('src/mr/scrape/ import src/mr/write/（flag）→ 不报 no-restricted-imports', async () => {
    const code = `import { setReviewFlag } from '../write/flag.js';\nexport { setReviewFlag };\n`;
    const n = await restrictedImportErrors(
      code,
      'src/mr/scrape/fingerprint.ts',
    );
    expect(n).toBe(0);
  });

  it('非守卫路径（ingest 自身）import 事实 writer → 不受限', async () => {
    const code = `import { recordPriceChange } from './record-price-change.js';\nexport { recordPriceChange };\n`;
    const n = await restrictedImportErrors(code, 'src/mr/ingest/upsert.ts');
    expect(n).toBe(0);
  });
});
