/**
 * Value Judge 完整往返可运行入口（任务 5.4 / 5.6）。
 *
 *   seed 假 raw_item → judgeRawItem(generateObject+Zod) → 按映射写 ai_news_events
 *   → 读回 → 比对各 *_score 列与 Agent 输出数值相等。
 *
 * 真实执行需 OpenRouter key（LLM_API_KEY/LLM_BASE_URL/LLM_MODEL）与可达 Postgres
 * （DATABASE_URL）。运行：`npm run roundtrip`。
 *
 * 审计证据（任务 5.6）：成功后把落库的 ai_news_events 行以结构化 JSON 打到 stdout，
 * 作为 PR artifact，而非仅自由文本描述。
 *
 * 数值比对（任务 5.5 原则）：NUMERIC(5,2) driver 可能返回 "82.00"/字符串，
 * 用 Number() 比较，禁用字面严格相等以免假阴性。
 */
import { pool } from '../../db/index.js';
import { judgeRawItem } from './index.js';
import {
  persistEventScores,
  readBackEventScores,
  seedRawItem,
} from './persistence.js';

function numericEqual(a: unknown, b: unknown): boolean {
  return Number(a) === Number(b);
}

async function main(): Promise<void> {
  const seed = await seedRawItem();
  console.error(`[roundtrip] seeded raw_item id=${seed.id.toString()}`);

  const output = await judgeRawItem({ title: seed.title, source: 'seed' });
  console.error('[roundtrip] judge output:', JSON.stringify(output));

  const eventId = await persistEventScores(seed.id, output, seed.title);
  const readback = await readBackEventScores(eventId);
  if (!readback) {
    throw new Error(`[roundtrip] 读回失败：event_id=${eventId} 不存在`);
  }

  const checks: Array<[string, unknown, unknown]> = [
    ['importance', output.importance, readback.importanceScore],
    ['novelty', output.novelty, readback.noveltyScore],
    ['developer_relevance', output.developer_relevance, readback.developerRelevanceScore],
    ['hype_risk', output.hype_risk, readback.hypeRiskScore],
  ];
  const mismatches = checks.filter(([, agent, db]) => !numericEqual(agent, db));
  const shouldPushOk = output.should_push === readback.shouldPush;

  if (mismatches.length > 0 || !shouldPushOk) {
    throw new Error(
      `[roundtrip] 往返比对失败：` +
        `mismatches=${JSON.stringify(mismatches)} shouldPushOk=${shouldPushOk}`,
    );
  }

  // 审计证据：落库行 dump 到 stdout（PR artifact）。
  console.log(
    JSON.stringify(
      {
        artifact: 'value-judge-roundtrip',
        seedRawItemId: seed.id.toString(),
        agentOutput: output,
        persistedEvent: readback,
        verified: true,
      },
      null,
      2,
    ),
  );
  console.error('[roundtrip] OK — 往返一致');
}

main()
  .catch((error) => {
    console.error('[roundtrip] 失败：', error);
    process.exitCode = 1;
  })
  .finally(() => {
    void pool.end();
  });
