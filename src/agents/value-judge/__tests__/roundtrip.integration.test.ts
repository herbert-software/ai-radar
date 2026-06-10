/**
 * Value Judge 落库往返 integration 测试（任务 5.5 的落库部分）——mock LLM，不依赖真实 key。
 *
 * 覆盖：
 * - 校验通过 → 按映射写 ai_news_events → 读回各 *_score 列与 Agent 输出数值相等。
 * - 校验失败 → judgeRawItem 抛错 → 不写入 ai_news_events（DB 无该 event）。
 *
 * 读回比对按数值相等（NUMERIC(5,2) driver 返回 "82.00"/字符串，用 Number 比较，
 * 禁用字面严格相等以免假阴性）。
 *
 * 需一个已 migrate 的 Postgres（DATABASE_URL）。缺 DATABASE_URL 时整套件 skip，
 * 故映射/校验纯单元测试（value-judge.test.ts）无 db 也能跑。
 *
 * 注意：本套件依赖 src/db/index.ts，其在 import 时校验 env（含 LLM_API_KEY 等）。
 * 仅当 DATABASE_URL 存在时才动态 import，避免无 DB 环境因 env 校验失败而误红。
 */
import { afterAll, describe, expect, it } from 'vitest';

// 动态 import 的 index/persistence/db 会触发 env.ts **全量**校验（DATABASE_URL/REDIS_URL/LLM_*）；
// 本套件只 gate 在 DATABASE_URL（真实 DB），不使用 redis、mock LLM。为「设了 DATABASE_URL
// 但未设 REDIS_URL / LLM key」时套件仍能干净运行（而非 import 期因 env 校验失败误红），
// 给本套件不依赖的 REDIS_URL 与 LLM 注入占位（仅过校验，运行路径绝不真用 redis / 真调 LLM）。
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.LLM_API_KEY ||= 'integration-placeholder';
process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
process.env.LLM_BASE_URL ||= 'https://example.invalid/v1';

const databaseUrl = process.env.DATABASE_URL;

const VALID_OUTPUT = {
  is_ai_related: true,
  type: 'ai_product',
  category: 'AI Coding',
  importance: 82,
  novelty: 75,
  developer_relevance: 90,
  hype_risk: 35,
  should_push: true,
  reason: 'A new open-source coding agent.',
};

describe.skipIf(!databaseUrl)('Value Judge 落库往返（mock LLM）', () => {
  // 动态 import：仅在有 DATABASE_URL 时加载 db 相关模块（其 import 期会校验 env）。
  let mod: typeof import('../index.js');
  let persistence: typeof import('../persistence.js');
  let dbMod: typeof import('../../../db/index.js');

  async function load() {
    if (!mod) {
      mod = await import('../index.js');
      persistence = await import('../persistence.js');
      dbMod = await import('../../../db/index.js');
    }
    return { mod, persistence, dbMod };
  }

  afterAll(async () => {
    if (dbMod) await dbMod.pool.end();
  });

  it('校验通过：按映射写入并读回数值相等', async () => {
    const { mod, persistence } = await load();
    const generateObjectFn = async () => ({ object: VALID_OUTPUT });

    const seed = await persistence.seedRawItem();
    const output = await mod.judgeRawItem(
      { title: seed.title },
      { generateObjectFn, logError: () => {} },
    );
    const eventId = await persistence.persistEventScores(
      seed.id,
      output,
      seed.title,
    );
    const row = await persistence.readBackEventScores(eventId);

    expect(row).not.toBeNull();
    // 数值相等比对，非字面严格相等。
    expect(Number(row!.importanceScore)).toBe(VALID_OUTPUT.importance);
    expect(Number(row!.noveltyScore)).toBe(VALID_OUTPUT.novelty);
    expect(Number(row!.developerRelevanceScore)).toBe(
      VALID_OUTPUT.developer_relevance,
    );
    expect(Number(row!.hypeRiskScore)).toBe(VALID_OUTPUT.hype_risk);
    expect(row!.shouldPush).toBe(VALID_OUTPUT.should_push);
  });

  it('校验失败：judgeRawItem 抛错且不写入 ai_news_events', async () => {
    const { mod, persistence, dbMod } = await load();
    const { eq } = await import('drizzle-orm');
    const generateObjectFn = async () => ({
      object: { is_ai_related: 'not-a-bool' },
    });

    const seed = await persistence.seedRawItem();
    const eventId = `seed-${seed.id.toString()}`;

    await expect(
      mod.judgeRawItem(
        { title: seed.title },
        { generateObjectFn, maxAttempts: 2, logError: () => {} },
      ),
    ).rejects.toBeInstanceOf(mod.ValueJudgeFailureError);

    // 降级路径未落库：ai_news_events 不应有该 event。
    const rows = await dbMod.db
      .select({ eventId: dbMod.schema.aiNewsEvents.eventId })
      .from(dbMod.schema.aiNewsEvents)
      .where(eq(dbMod.schema.aiNewsEvents.eventId, eventId))
      .limit(1);
    expect(rows.length).toBe(0);
  });
});
