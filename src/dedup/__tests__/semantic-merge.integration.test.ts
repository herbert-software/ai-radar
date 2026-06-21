/**
 * semanticMergeEvents 编排入口集成测试（组 D 额外，**需本地 Postgres + pgvector**）。
 *
 * 验证编排：embedding bootstrap（注入 embed 桩）→ 候选检索 → 阈值分流 → 灰区 judge（注入桩）→ 合并。
 * - high-auto：两高相似事件经一轮编排合并为一（存活=较早）。
 * - llm-gray + judge 桩判 same → 合并；judge 桩判 diff → 不合并。
 * - 嵌入桩为不同事件返回相近/相远向量以控制相似度。
 * - 降级安全：embed 桩失败时不合并、不抛断。
 *
 * 缺 DATABASE_URL 时自动跳过。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../../db/schema.js';

process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
process.env.TELEGRAM_CHAT_ID ||= 'test-chat';
process.env.LLM_API_KEY ||= 'test-key';
process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph-token';

const { semanticMergeEvents } = await import('../semantic-merge.js');

const databaseUrl = process.env.DATABASE_URL;
const SOURCE = 'semmerge-itest';
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
const db = pool ? drizzle(pool, { schema }) : null;

/** 1536 维向量：idx0/idx1 放 (cos,sin)，与 [1,0,...] 余弦 = cos。 */
function vec(cos: number): number[] {
  const arr = new Array(1536).fill(0);
  arr[0] = cos;
  arr[1] = Math.sqrt(Math.max(0, 1 - cos * cos));
  return arr;
}

/** seed 一条事件（无 embedding，待 bootstrap 嵌入），返回 event_id。 */
async function seedEvent(args: {
  dedupKey: string;
  title: string;
  firstSeenAt: Date;
  rawItemId: bigint;
}): Promise<string> {
  const { rows } = await pool!.query<{ event_id: string }>(
    `INSERT INTO ai_news_events (dedup_key, representative_title, representative_raw_item_id, first_seen_at, last_seen_at, source_count)
     VALUES ($1,$2,$3,$4,$4,1) RETURNING event_id`,
    [args.dedupKey, args.title, args.rawItemId, args.firstSeenAt],
  );
  return rows[0]!.event_id;
}

async function seedRaw(sourceItemId: string, content: string): Promise<bigint> {
  const { rows } = await pool!.query<{ id: string }>(
    `INSERT INTO raw_items (source, source_item_id, title, content) VALUES ($1,$2,$3,$4) RETURNING id`,
    [SOURCE, sourceItemId, 'seed', content],
  );
  return BigInt(rows[0]!.id);
}

async function fetchEvent(eventId: string) {
  const { rows } = await pool!.query<{ merged_into: string | null; source_count: number }>(
    `SELECT merged_into, source_count FROM ai_news_events WHERE event_id=$1`,
    [eventId],
  );
  return rows[0];
}

function cleanup(): Promise<unknown> {
  return pool!
    .query(`DELETE FROM ai_news_events WHERE dedup_key LIKE $1`, [`${SOURCE}-%`])
    .then(() => pool!.query(`DELETE FROM ai_news_events WHERE representative_raw_item_id IN (SELECT id FROM raw_items WHERE source=$1)`, [SOURCE]))
    .then(() => pool!.query(`DELETE FROM raw_items WHERE source=$1`, [SOURCE]));
}

beforeAll(async () => { if (pool) await cleanup(); });
// 每个用例后清理：windowDays=3650 使全套件事件互为候选，须逐用例隔离防跨用例向量串扰。
afterEach(async () => { if (pool) await cleanup(); });
afterAll(async () => { if (pool) { await cleanup(); await pool.end(); } });

describe.skipIf(!databaseUrl)('semanticMergeEvents 编排（embed/judge 注入桩）', () => {
  it('high-auto：两高相似事件一轮编排合并为一（存活=较早）', async () => {
    const ts = Date.now();
    const r1 = await seedRaw(`hi-1-${ts}`, 'OpenAI releases GPT-5 content');
    const r2 = await seedRaw(`hi-2-${ts}`, 'GPT-5 launched content');
    const older = await seedEvent({ dedupKey: `${SOURCE}-hi-older-${ts}`, title: 'OpenAI releases GPT-5', firstSeenAt: new Date('2026-06-01T00:00:00Z'), rawItemId: r1 });
    const newer = await seedEvent({ dedupKey: `${SOURCE}-hi-newer-${ts}`, title: 'GPT-5 launched', firstSeenAt: new Date('2026-06-02T00:00:00Z'), rawItemId: r2 });

    // embed 桩：按 values 顺序返回向量。两事件都返回与 base 余弦 0.95（彼此余弦也高）→ high-auto。
    // 为使两者互为高相似候选，给两者**同一**向量（余弦=1.0）。
    const embedManyFn = (async (args: { values: string[] }) =>
      ({ embeddings: args.values.map(() => vec(0.99)) })) as never;

    const result = await semanticMergeEvents(
      {
        thisRoundEventIds: [older, newer],
        embedding: { embed: { embedManyFn, logError: () => {} }, windowDays: 3650, logError: () => {} },
        search: { windowDays: 3650, highThreshold: 0.88, llmThreshold: 0.82 },
        judge: { generateObjectFn: (async () => { throw new Error('judge should not be called for high-auto'); }) as never },
        logError: () => {},
      },
      db!,
    );

    expect(result.embedding.embedded).toBeGreaterThanOrEqual(2);
    expect(result.highAutoMerged).toBeGreaterThanOrEqual(1);
    // 二者合并为一：一个成 tombstone（merged_into 指向另一个），存活=较早 older。
    const o = await fetchEvent(older);
    const n = await fetchEvent(newer);
    const merged = (o!.merged_into === null) !== (n!.merged_into === null); // 恰一个是 tombstone
    expect(merged).toBe(true);
    // 存活=较早 older（newer 被吞）。
    expect(o!.merged_into).toBeNull();
    expect(n!.merged_into).toBe(older);
    expect(Number(o!.source_count)).toBe(2); // 1 + 1
  });

  it('llm-gray + judge 桩判 same → 合并（存活=较早）', async () => {
    const ts = Date.now();
    const r1 = await seedRaw(`gs-1-${ts}`, 'content a');
    const r2 = await seedRaw(`gs-2-${ts}`, 'content b');
    const older = await seedEvent({ dedupKey: `${SOURCE}-gs-older-${ts}`, title: 'Gray same older', firstSeenAt: new Date('2026-06-01T00:00:00Z'), rawItemId: r1 });
    const newer = await seedEvent({ dedupKey: `${SOURCE}-gs-newer-${ts}`, title: 'Gray same newer', firstSeenAt: new Date('2026-06-02T00:00:00Z'), rawItemId: r2 });
    // 两事件向量间余弦 = 0.99（older=base [1,0,..]，newer=vec(0.99)），落灰区 (0.82, 0.995] → 交 judge。
    // 按 values 顺序对齐 eventId：bootstrap 先嵌本轮新事件（thisRoundEventIds=[older,newer] 同序），
    // 故第一个 values=older→base、第二个=newer→vec(0.99)。
    const embedManyFn = (async (args: { values: string[] }) =>
      ({ embeddings: args.values.map((_, i) => (i === 0 ? vec(1.0) : vec(0.99))) })) as never;
    const sameStub = (async () => ({ object: { same_event: true, same_product: false, reason: 'same' } })) as never;
    const result = await semanticMergeEvents(
      {
        thisRoundEventIds: [older, newer],
        embedding: { embed: { embedManyFn, logError: () => {} }, windowDays: 3650, logError: () => {} },
        search: { windowDays: 3650, highThreshold: 0.995, llmThreshold: 0.82 }, // 0.99 ∈ (0.82, 0.995] → 灰区
        judge: { generateObjectFn: sameStub },
        logError: () => {},
      },
      db!,
    );
    expect(result.llmConfirmedMerged).toBeGreaterThanOrEqual(1);
    expect((await fetchEvent(newer))!.merged_into).toBe(older);
  });

  it('llm-gray + judge 桩判 diff → 不合并', async () => {
    const ts = Date.now();
    const r1 = await seedRaw(`gd-1-${ts}`, 'content a');
    const r2 = await seedRaw(`gd-2-${ts}`, 'content b');
    const older = await seedEvent({ dedupKey: `${SOURCE}-gd-older-${ts}`, title: 'Gray diff older', firstSeenAt: new Date('2026-06-01T00:00:00Z'), rawItemId: r1 });
    const newer = await seedEvent({ dedupKey: `${SOURCE}-gd-newer-${ts}`, title: 'Gray diff newer', firstSeenAt: new Date('2026-06-02T00:00:00Z'), rawItemId: r2 });
    // 两事件间余弦 0.99 → 灰区；judge 桩判 diff → 不合并。
    const embedManyFn = (async (args: { values: string[] }) =>
      ({ embeddings: args.values.map((_, i) => (i === 0 ? vec(1.0) : vec(0.99))) })) as never;
    const diffStub = (async () => ({ object: { same_event: false, same_product: false, reason: 'different' } })) as never;
    const result = await semanticMergeEvents(
      {
        thisRoundEventIds: [older, newer],
        embedding: { embed: { embedManyFn, logError: () => {} }, windowDays: 3650, logError: () => {} },
        search: { windowDays: 3650, highThreshold: 0.995, llmThreshold: 0.82 },
        judge: { generateObjectFn: diffStub },
        logError: () => {},
      },
      db!,
    );
    expect(result.llmNotMerged).toBeGreaterThanOrEqual(1);
    // 不合并：两者 merged_into 都为 NULL。
    expect((await fetchEvent(older))!.merged_into).toBeNull();
    expect((await fetchEvent(newer))!.merged_into).toBeNull();
  });

  it('降级安全：embed 桩失败 → 该轮不合并、不抛断', async () => {
    const ts = Date.now();
    const r1 = await seedRaw(`ef-1-${ts}`, 'content a');
    const r2 = await seedRaw(`ef-2-${ts}`, 'content b');
    const older = await seedEvent({ dedupKey: `${SOURCE}-ef-older-${ts}`, title: 'Embed fail older', firstSeenAt: new Date('2026-06-01T00:00:00Z'), rawItemId: r1 });
    const newer = await seedEvent({ dedupKey: `${SOURCE}-ef-newer-${ts}`, title: 'Embed fail newer', firstSeenAt: new Date('2026-06-02T00:00:00Z'), rawItemId: r2 });
    const failEmbed = (async () => { throw new Error('embed API down'); }) as never;

    const result = await semanticMergeEvents(
      {
        thisRoundEventIds: [older, newer],
        embedding: { embed: { embedManyFn: failEmbed, maxAttempts: 1, logError: () => {} }, windowDays: 3650, logError: () => {} },
        search: { windowDays: 3650 },
        judge: { generateObjectFn: (async () => ({ object: { same_event: true, same_product: false, reason: 'x' } })) as never },
        logError: () => {},
      },
      db!,
    );
    // embedding 全失败 → 无事件有向量 → processed 可能为 0、无合并；不抛断。
    expect(result.highAutoMerged).toBe(0);
    expect(result.llmConfirmedMerged).toBe(0);
    expect((await fetchEvent(older))!.merged_into).toBeNull();
    expect((await fetchEvent(newer))!.merged_into).toBeNull();
  });

  // ── 护栏接线（harden-semantic-dedup-merge-precision）：纯函数已单测，此处验证注入 semanticMergeEvents 的行为。

  it('护栏：high-auto 高相似但 token 不同 → 否决、不合并、计数', async () => {
    const ts = Date.now();
    const r1 = await seedRaw(`gv-1-${ts}`, 'o1 content');
    const r2 = await seedRaw(`gv-2-${ts}`, 'o3-mini content');
    const older = await seedEvent({ dedupKey: `${SOURCE}-gv-older-${ts}`, title: 'OpenAI o1 system card', firstSeenAt: new Date('2026-06-01T00:00:00Z'), rawItemId: r1 });
    const newer = await seedEvent({ dedupKey: `${SOURCE}-gv-newer-${ts}`, title: 'OpenAI o3-mini system card', firstSeenAt: new Date('2026-06-02T00:00:00Z'), rawItemId: r2 });
    // 两者同向量（互余弦 1.0）→ high-auto；token 集 {1} vs {3} 不同 → 护栏否决。
    const embedManyFn = (async (args: { values: string[] }) =>
      ({ embeddings: args.values.map(() => vec(0.99)) })) as never;
    // 记录式 judge 桩：被调用即置位（judgeCalled 直证未被调用，不依赖抛错/降级语义）。
    let judgeCalled = false;
    const recordingJudge = (async () => { judgeCalled = true; return { object: { same_event: false, same_product: false, reason: 'judge must not be called' } }; }) as never;
    const result = await semanticMergeEvents(
      {
        thisRoundEventIds: [older, newer],
        embedding: { embed: { embedManyFn, logError: () => {} }, windowDays: 3650, logError: () => {} },
        search: { windowDays: 3650, highThreshold: 0.88, llmThreshold: 0.82 },
        judge: { generateObjectFn: recordingJudge },
        logError: () => {},
      },
      db!,
    );
    expect(result.vetoedByGuard).toBeGreaterThanOrEqual(1);
    expect(result.highAutoMerged).toBe(0);
    expect(judgeCalled).toBe(false); // high-auto 路本就不调 judge + 护栏否决 → judge 从未被调用
    expect((await fetchEvent(older))!.merged_into).toBeNull();
    expect((await fetchEvent(newer))!.merged_into).toBeNull();
  });

  it('护栏：灰区 token 不同 → 前置否决、不调 LLM（记录式 judge 桩证明从未被调用）', async () => {
    const ts = Date.now();
    const r1 = await seedRaw(`gz-1-${ts}`, 'mistral 3 content');
    const r2 = await seedRaw(`gz-2-${ts}`, 'mistral 3.1 content');
    const older = await seedEvent({ dedupKey: `${SOURCE}-gz-older-${ts}`, title: 'Mistral Small 3 release', firstSeenAt: new Date('2026-06-01T00:00:00Z'), rawItemId: r1 });
    const newer = await seedEvent({ dedupKey: `${SOURCE}-gz-newer-${ts}`, title: 'Mistral Small 3.1 release', firstSeenAt: new Date('2026-06-02T00:00:00Z'), rawItemId: r2 });
    // 互余弦 0.99 落灰区 (0.82, 0.995]；token 集 {3} vs {3.1} 不同。护栏在 judge 之前否决。
    const embedManyFn = (async (args: { values: string[] }) =>
      ({ embeddings: args.values.map((v) => (v.includes('3.1') ? vec(0.99) : vec(1.0))) })) as never;
    // 记录式 judge 桩：被调用即置位。**直证**护栏前置否决=judge 从未被调用——不能靠 skippedError，
    // 因 judgeSameEvent 吞错降级返回 sameEvent:false 而不抛，护栏缺失时 skippedError 仍为 0（不判别）。
    let judgeCalled = false;
    const recordingJudge = (async () => { judgeCalled = true; return { object: { same_event: false, same_product: false, reason: 'guard must veto before LLM' } }; }) as never;
    const result = await semanticMergeEvents(
      {
        thisRoundEventIds: [older, newer],
        embedding: { embed: { embedManyFn, logError: () => {} }, windowDays: 3650, logError: () => {} },
        search: { windowDays: 3650, highThreshold: 0.995, llmThreshold: 0.82 },
        judge: { generateObjectFn: recordingJudge },
        logError: () => {},
      },
      db!,
    );
    expect(judgeCalled).toBe(false); // 直证：灰区 token 不同 → 护栏前置否决、judge 从未被调用
    expect(result.vetoedByGuard).toBeGreaterThanOrEqual(1);
    expect(result.llmConfirmedMerged).toBe(0);
    expect(result.llmNotMerged).toBe(0); // 护栏缺失则 judge 降级 sameEvent:false → 此处会 =1（判别断言）
    expect((await fetchEvent(older))!.merged_into).toBeNull();
    expect((await fetchEvent(newer))!.merged_into).toBeNull();
  });

  it('护栏：否决最高相似候选后 continue（不 break），仍合并更低相似的真同事件候选', async () => {
    const ts = Date.now();
    const rq = await seedRaw(`cnb-q-${ts}`, 'gpt 5.5 query content');
    const rv = await seedRaw(`cnb-v-${ts}`, 'gpt 5.3 variant content');
    const rs = await seedRaw(`cnb-s-${ts}`, 'gpt 5.5 same content');
    // query 06-03；variant 06-01（最高相似但 token 不同→被否决）；same 06-02（略低相似但 token 一致→应合并）。
    const query = await seedEvent({ dedupKey: `${SOURCE}-cnb-q-${ts}`, title: 'GPT-5.5 launch query', firstSeenAt: new Date('2026-06-03T00:00:00Z'), rawItemId: rq });
    const variant = await seedEvent({ dedupKey: `${SOURCE}-cnb-v-${ts}`, title: 'GPT-5.3 launch variant', firstSeenAt: new Date('2026-06-01T00:00:00Z'), rawItemId: rv });
    const same = await seedEvent({ dedupKey: `${SOURCE}-cnb-s-${ts}`, title: 'GPT-5.5 launch same', firstSeenAt: new Date('2026-06-02T00:00:00Z'), rawItemId: rs });
    // 向量（按标题标记映射，顺序无关）：query=base[1,0]、variant=vec(0.99)、same=vec(0.97)。
    // sim(query,variant)=0.99 > sim(query,same)=0.97 > 0.88 → 均 high-auto；judge 桩抛错（high-auto 不应调）。
    // 护栏：query{5.5}↔variant{5.3} 否决、query{5.5}↔same{5.5} 放行 → 终态 query 并入 same（较早存活）、variant 独立。
    const embedManyFn = (async (args: { values: string[] }) =>
      ({ embeddings: args.values.map((v) => (v.includes('variant') ? vec(0.99) : v.includes('same') ? vec(0.97) : vec(1.0))) })) as never;
    let judgeCalled = false;
    const recordingJudge = (async () => { judgeCalled = true; return { object: { same_event: false, same_product: false, reason: 'high-auto must not call judge' } }; }) as never;
    const result = await semanticMergeEvents(
      {
        thisRoundEventIds: [query, variant, same],
        embedding: { embed: { embedManyFn, logError: () => {} }, windowDays: 3650, logError: () => {} },
        search: { windowDays: 3650, highThreshold: 0.88, llmThreshold: 0.82 },
        judge: { generateObjectFn: recordingJudge },
        logError: () => {},
      },
      db!,
    );
    // 依赖候选「相似度降序」契约（searchSimilarCandidates，距离升序）：先遇高相似 variant（被否决）、
    // 后遇 same（token 一致、合并）——正是 continue-not-break 要验的路径；若该排序契约变，本用例需同步调整。
    // 终态与处理顺序无关：token 一致的 (query,same) 合并、存活=较早 same；version-variant 始终被否决保持独立。
    expect(result.vetoedByGuard).toBeGreaterThanOrEqual(1);
    expect(result.highAutoMerged).toBeGreaterThanOrEqual(1);
    expect(judgeCalled).toBe(false); // 全 high-auto 路 → judge 不应被调用
    expect((await fetchEvent(query))!.merged_into).toBe(same); // 较低相似但 token 一致者被合并；若 continue 误改 break 则此处为 null
    expect((await fetchEvent(variant))!.merged_into).toBeNull(); // 最高相似但 token 不同者被否决、独立
    expect((await fetchEvent(same))!.merged_into).toBeNull(); // 存活者
  });
});
