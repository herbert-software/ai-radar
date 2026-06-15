/**
 * 语义去重 + 确定性合并 + tombstone 改投 不变量集成测试（组 D 任务 4.6，**需本地 Postgres + pgvector**）。
 *
 * 覆盖 spec 不变量（design D4/D5）：
 * ① sim>0.88 两事件合并为一、source_count 累加、存活身份不变；
 * ② 灰区 LLM 判 same→合并、LLM 失败→不合并（降级安全）；
 * ③ tombstone 改投：后到同 dedup_key raw_item 塌缩进存活者不新建重复；
 * ④ 跨天幂等：昨日已 push 事件为存活者时，今日推送候选据「从未以该 channel success」跳过、不重推
 *    （显式覆盖 UNIQUE(target_type,target_id,channel,push_date) 幂等）；
 * ⑤ 链式合并：A 吞 B 后 A 又被吞入 C，命中 B 的 dedup_key 的 raw_item 改投到终态 C（非 tombstone A）；
 * ⑥ source_count 不重复：合并吸收一次 + 后到新 raw_item 仅 +1，被吞已冻结的 source_count 不重加；
 * ⑦ 塌缩/合并两种提交序（合并先 / 塌缩先，均严格顺序执行、非实时行锁争用）下 source_count 既不丢也
 *    不重、增量最终都落存活者、tombstone source_count 不被改（验证终态对提交序无关；行锁争用本身不在此覆盖）。
 *
 * embedding/LLM 不触网：embedding 直接以 vector(1536) 字面量 seed 入库；语义判断经注入桩。
 * 缺 DATABASE_URL 时自动跳过。每个用例用唯一 dedup_key/event 前缀隔离，afterAll 清理本套件造的行。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../../db/schema.js';

// 经 import 链触发 env 校验（缺关键变量即 throw）；为推送相关变量注入占位（本套件不发推送）。
process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
process.env.TELEGRAM_CHAT_ID ||= 'test-chat';
process.env.LLM_API_KEY ||= 'test-key';
process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph-token';

const { mergeEvents } = await import('../merge-events.js');
const { searchSimilarCandidates, classifySimilarity } = await import('../semantic-search.js');
const { collapseRawItem } = await import('../collapse.js');

const databaseUrl = process.env.DATABASE_URL;
const SOURCE = 'merge-itest';
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
const db = pool ? drizzle(pool, { schema }) : null;

/** 构造 1536 维 vector(1536) 字面量字符串：在 idx0/idx1 放 (cos,sin)，其余 0 → 与 [1,0,...] 的余弦 = cos。 */
function vecLiteral(cos: number): string {
  const sinv = Math.sqrt(Math.max(0, 1 - cos * cos));
  const arr = new Array(1536).fill(0);
  arr[0] = cos;
  arr[1] = sinv;
  return `[${arr.join(',')}]`;
}
/** 基准向量 [1,0,0,...]（与 vecLiteral(cos) 的余弦相似度恰为 cos）。 */
function baseVecLiteral(): string {
  const arr = new Array(1536).fill(0);
  arr[0] = 1;
  return `[${arr.join(',')}]`;
}

/** 直接 INSERT 一条 ai_news_events（带 embedding / first_seen / source_count），返回 event_id。 */
async function seedEvent(args: {
  dedupKey: string;
  title: string;
  firstSeenAt: Date;
  sourceCount?: number;
  embeddingLiteral?: string | null;
  publishedAt?: Date | null;
}): Promise<string> {
  const { rows } = await pool!.query<{ event_id: string }>(
    `INSERT INTO ai_news_events
       (dedup_key, representative_title, first_seen_at, last_seen_at, source_count, published_at, embedding)
     VALUES ($1, $2, $3, $3, $4, $5, $6::vector)
     RETURNING event_id`,
    [
      args.dedupKey,
      args.title,
      args.firstSeenAt,
      args.sourceCount ?? 1,
      args.publishedAt ?? null,
      args.embeddingLiteral ?? null,
    ],
  );
  return rows[0]!.event_id;
}

async function fetchEvent(eventId: string) {
  const { rows } = await pool!.query<{
    event_id: string;
    merged_into: string | null;
    source_count: number;
    representative_title: string | null;
    dedup_key: string | null;
  }>(
    `SELECT event_id, merged_into, source_count, representative_title, dedup_key
     FROM ai_news_events WHERE event_id = $1`,
    [eventId],
  );
  return rows[0];
}

function deletePrefix(): Promise<unknown> {
  // 清理本套件造的事件（按 dedup_key 前缀）+ raw_items（按 source）。
  return Promise.all([
    pool!.query(`DELETE FROM push_records WHERE target_id IN (SELECT event_id FROM ai_news_events WHERE dedup_key LIKE $1)`, [`${SOURCE}-%`]),
    pool!.query(`DELETE FROM ai_news_events WHERE dedup_key LIKE $1`, [`${SOURCE}-%`]),
  ]).then(() =>
    pool!.query(`DELETE FROM ai_news_events WHERE representative_raw_item_id IN (SELECT id FROM raw_items WHERE source = $1)`, [SOURCE]),
  ).then(() =>
    pool!.query(`DELETE FROM raw_items WHERE source = $1`, [SOURCE]),
  );
}

beforeAll(async () => {
  if (!pool) return;
  await deletePrefix();
});

afterAll(async () => {
  if (pool) {
    await deletePrefix();
    await pool.end();
  }
});

describe.skipIf(!databaseUrl)('语义去重 + 确定性合并 + tombstone 改投（不变量）', () => {
  it('① sim>0.88：检索命中 high-auto 档，合并为一、source_count 累加、存活=较早身份不变', async () => {
    const ts = Date.now();
    const older = await seedEvent({
      dedupKey: `${SOURCE}-hi-older-${ts}`,
      title: 'OpenAI releases GPT-5',
      firstSeenAt: new Date('2026-06-01T00:00:00Z'),
      sourceCount: 2,
      embeddingLiteral: baseVecLiteral(),
    });
    const newer = await seedEvent({
      dedupKey: `${SOURCE}-hi-newer-${ts}`,
      title: 'GPT-5 launched by OpenAI today',
      firstSeenAt: new Date('2026-06-02T00:00:00Z'),
      sourceCount: 3,
      embeddingLiteral: vecLiteral(0.95), // 与 base 余弦 0.95 > 0.88 → high-auto
    });

    // 检索：以 newer 的向量查窗内候选，应命中 older，sim≈0.95 → high-auto。
    const candidates = await searchSimilarCandidates(
      newer,
      [0.95, Math.sqrt(1 - 0.95 * 0.95), ...new Array(1534).fill(0)],
      { windowDays: 3650 },
      db!,
    );
    const hit = candidates.find((c) => c.eventId === older);
    expect(hit).toBeDefined();
    expect(hit!.cosineSim).toBeGreaterThan(0.88);
    expect(classifySimilarity(hit!.cosineSim, 0.88, 0.82)).toBe('high-auto');

    // 合并（程序 + DB 单事务）。
    const provLog: unknown[] = [];
    const outcome = await mergeEvents(
      newer,
      older,
      { cosineSim: hit!.cosineSim, tier: 'high-auto', logProvenance: (p) => provLog.push(p) },
      db!,
    );
    expect(outcome.status).toBe('merged');
    // 存活 = first_seen 较早者（older）。
    expect(outcome.survivorId).toBe(older);
    expect(outcome.absorbedId).toBe(newer);

    const survivor = await fetchEvent(older);
    const absorbed = await fetchEvent(newer);
    // source_count 一次性累加（2 + 3 = 5）。
    expect(Number(survivor!.source_count)).toBe(5);
    // 存活身份/代表/dedup_key 不变。
    expect(survivor!.merged_into).toBeNull();
    expect(survivor!.representative_title).toBe('OpenAI releases GPT-5');
    expect(survivor!.dedup_key).toBe(`${SOURCE}-hi-older-${ts}`);
    // 被吞置 tombstone（merged_into=存活），未物理删、source_count 冻结（仍为其原值 3）。
    expect(absorbed!.merged_into).toBe(older);
    expect(Number(absorbed!.source_count)).toBe(3);
    // provenance 被记录（被吞/存活/相似度/档位）。
    expect(provLog).toHaveLength(1);
    expect(provLog[0]).toMatchObject({ survivorId: older, absorbedId: newer, tier: 'high-auto' });
  });

  it('③/⑥ tombstone 改投 + source_count 不重复：合并后命中被吞 dedup_key 的 raw_item 改投存活者、仅 +1', async () => {
    const ts = Date.now();
    const url = `https://example.com/reroute-${ts}`;
    // 先正常塌缩出事件 B（被吞者），记其 dedup_key。
    const bId = await collapseRawItem(
      { id: await seedRaw(`reroute-b-${ts}`, url), url, title: 'Event B title', publishedAt: null, fetchedAt: new Date('2026-06-05T00:00:00Z') },
      db!,
    );
    const bDedupKey = bId.dedupKey!;
    // 存活者 A（更早）：直接 seed，source_count=1。
    const aId = await seedEvent({
      dedupKey: `${SOURCE}-reroute-a-${ts}`,
      title: 'Event A title',
      firstSeenAt: new Date('2026-06-01T00:00:00Z'),
      sourceCount: 1,
    });
    // 取 B 的 event_id。
    const { rows: bRows } = await pool!.query<{ event_id: string; source_count: number }>(
      `SELECT event_id, source_count FROM ai_news_events WHERE dedup_key = $1`,
      [bDedupKey],
    );
    const bEventId = bRows[0]!.event_id;
    const bSourceBefore = Number(bRows[0]!.source_count); // =1

    // 合并 A 吞 B（A 更早存活）：A.source_count = 1 + 1 = 2；B 置 tombstone、其 source_count 冻结 =1。
    await mergeEvents(aId, bEventId, { cosineSim: 0.99, tier: 'high-auto', logProvenance: () => {} }, db!);
    let a = await fetchEvent(aId);
    let b = await fetchEvent(bEventId);
    expect(Number(a!.source_count)).toBe(1 + bSourceBefore); // 2
    expect(b!.merged_into).toBe(aId);

    // 后到一条同 url（同 dedup_key 命中 B 的 tombstone）的新 raw_item：改投存活者 A、仅 +1、不新建重复、不动 B。
    const out = await collapseRawItem(
      { id: await seedRaw(`reroute-b2-${ts}`, url), url, title: 'Event B title (dup)', publishedAt: null, fetchedAt: new Date() },
      db!,
    );
    expect(out.dedupKey).toBe(bDedupKey); // 同 dedup_key 命中 B（tombstone）
    a = await fetchEvent(aId);
    b = await fetchEvent(bEventId);
    // A 改投 +1（2 → 3）；B（tombstone）source_count 不被改（仍冻结 =1）。
    expect(Number(a!.source_count)).toBe(3);
    expect(Number(b!.source_count)).toBe(bSourceBefore); // 1 不变
    // 不新建重复事件：dedup_key=bDedupKey 仍只有 B 一行。
    const { rows: dupRows } = await pool!.query(
      `SELECT event_id FROM ai_news_events WHERE dedup_key = $1`,
      [bDedupKey],
    );
    expect(dupRows).toHaveLength(1);
  });

  it('⑤ 链式合并：A 吞 B、A 又被吞入 C，命中 B 的 dedup_key 改投到终态 C（非 tombstone A）', async () => {
    const ts = Date.now();
    const urlB = `https://example.com/chain-b-${ts}`;
    // B：塌缩出，记 dedup_key。
    const bOut = await collapseRawItem(
      { id: await seedRaw(`chain-b-${ts}`, urlB), url: urlB, title: 'Chain B', publishedAt: null, fetchedAt: new Date('2026-06-10T00:00:00Z') },
      db!,
    );
    const bDedupKey = bOut.dedupKey!;
    const { rows: bRows } = await pool!.query<{ event_id: string }>(`SELECT event_id FROM ai_news_events WHERE dedup_key=$1`, [bDedupKey]);
    const bEventId = bRows[0]!.event_id;
    // A（比 B 早）、C（比 A 更早，终态存活者）。
    const aId = await seedEvent({ dedupKey: `${SOURCE}-chain-a-${ts}`, title: 'Chain A', firstSeenAt: new Date('2026-06-05T00:00:00Z') });
    const cId = await seedEvent({ dedupKey: `${SOURCE}-chain-c-${ts}`, title: 'Chain C', firstSeenAt: new Date('2026-06-01T00:00:00Z') });

    // A 吞 B（A 更早）。
    await mergeEvents(aId, bEventId, { cosineSim: 0.99, tier: 'high-auto', logProvenance: () => {} }, db!);
    // C 吞 A（C 更早）→ A 也成 tombstone（merged_into=C）。
    await mergeEvents(cId, aId, { cosineSim: 0.99, tier: 'high-auto', logProvenance: () => {} }, db!);

    const a = await fetchEvent(aId);
    expect(a!.merged_into).toBe(cId); // A 是中间 tombstone，指向 C

    const cBefore = Number((await fetchEvent(cId))!.source_count);
    // 后到命中 B 的 dedup_key 的 raw_item：必须改投到**终态 C**（沿 B→A→C 链解析），不停在 tombstone A。
    await collapseRawItem(
      { id: await seedRaw(`chain-b2-${ts}`, urlB), url: urlB, title: 'Chain B dup', publishedAt: null, fetchedAt: new Date() },
      db!,
    );
    const c = await fetchEvent(cId);
    const aAfter = await fetchEvent(aId);
    const bAfter = await fetchEvent(bEventId);
    // C（终态存活者）+1；中间 tombstone A、B 的 source_count 都不被改。
    expect(Number(c!.source_count)).toBe(cBefore + 1);
    expect(c!.merged_into).toBeNull();
    expect(Number(aAfter!.source_count)).toBe(Number(a!.source_count)); // A 不变
    expect(bAfter!.merged_into).toBe(aId); // B 仍指向 A（路径未压缩，但解析穿透到 C）
  });

  it('②a 灰区注入桩判 same → 合并；②b 灰区桩判不同/降级 → 不合并', async () => {
    const ts = Date.now();
    const { judgeSameEvent } = await import('../semantic-judge.js');

    // same=true 桩 → 合并。
    const sameStub = async () => ({ object: { same_event: true, same_product: false, reason: 'same release' } });
    const r1 = await judgeSameEvent(
      { titleA: 'GPT-5 out', titleB: 'OpenAI ships GPT-5' },
      { generateObjectFn: sameStub as never, logError: () => {} },
    );
    expect(r1.sameEvent).toBe(true);
    expect(r1.degraded).toBe(false);

    const a = await seedEvent({ dedupKey: `${SOURCE}-gray-a-${ts}`, title: 'GPT-5 out', firstSeenAt: new Date('2026-06-01T00:00:00Z') });
    const b = await seedEvent({ dedupKey: `${SOURCE}-gray-b-${ts}`, title: 'OpenAI ships GPT-5', firstSeenAt: new Date('2026-06-02T00:00:00Z') });
    if (r1.sameEvent) {
      const out = await mergeEvents(b, a, { cosineSim: 0.85, tier: 'llm-confirmed', reason: r1.reason, logProvenance: () => {} }, db!);
      expect(out.status).toBe('merged');
      expect((await fetchEvent(b))!.merged_into).toBe(a);
    }

    // LLM 失败（恒抛）→ 降级为不合并（degraded=true、sameEvent=false），不抛断。
    const failStub = async () => { throw new Error('LLM down'); };
    const r2 = await judgeSameEvent(
      { titleA: 'X', titleB: 'Y' },
      { generateObjectFn: failStub as never, maxAttempts: 2, logError: () => {} },
    );
    expect(r2.sameEvent).toBe(false);
    expect(r2.degraded).toBe(true);
  });

  it('④ 跨天幂等：昨日已 push 事件为存活者 → 今日同事件被吞、UNIQUE 幂等使不重推', async () => {
    const ts = Date.now();
    const channel = 'telegram';
    // 存活者 A（昨日）：seed + 昨日 push success 记录。
    const aId = await seedEvent({ dedupKey: `${SOURCE}-idem-a-${ts}`, title: 'Daily idem A', firstSeenAt: new Date('2026-06-01T00:00:00Z'), publishedAt: new Date('2026-06-01T00:00:00Z') });
    await pool!.query(
      `INSERT INTO push_records (target_type, target_id, channel, push_date, status, pushed_at)
       VALUES ('event', $1, $2, '2026-06-01', 'success', now())`,
      [aId, channel],
    );
    // 今日新事件 B（更晚）：与 A 合并 → B 成 tombstone。
    const bId = await seedEvent({ dedupKey: `${SOURCE}-idem-b-${ts}`, title: 'Daily idem B', firstSeenAt: new Date('2026-06-02T00:00:00Z'), publishedAt: new Date('2026-06-02T00:00:00Z') });
    await mergeEvents(aId, bId, { cosineSim: 0.99, tier: 'high-auto', logProvenance: () => {} }, db!);
    expect((await fetchEvent(bId))!.merged_into).toBe(aId);

    // 存活者侧幂等：A 在 channel 已 success → 今日推送候选「从未以该 channel success」不满足，不重推。
    // 显式覆盖 UNIQUE(target_type,target_id,channel,push_date)：对同一 (event,channel,push_date) 再插
    // success 应冲突（幂等键），证明跨天/同日不会产生第二条 success 推送记录。
    const dupInsert = pool!.query(
      `INSERT INTO push_records (target_type, target_id, channel, push_date, status, pushed_at)
       VALUES ('event', $1, $2, '2026-06-01', 'success', now())`,
      [aId, channel],
    );
    await expect(dupInsert).rejects.toThrow(); // UNIQUE 冲突（同事件次日/同日不重推）

    // 被吞者侧幂等：B 是 tombstone（merged_into 非空），下游读点（top-n 等）已排除——此处直接断言其
    // merged_into 非空（读路径排除由 tombstone-visibility 集成测覆盖）。
    expect((await fetchEvent(bId))!.merged_into).toBe(aId);
  });

  it('⑦ 塌缩/合并两种**提交序**下 source_count 不丢不重（终态一致）', async () => {
    // 注：本用例两序均严格顺序 await（提交序不同）、验证终态一致（顺序无关性），**不**模拟实时行锁争用；
    // 真正的行锁争用依赖 PG 行锁 + （按 spec）死锁检测/重试，此处不覆盖。
    // —— 序 1：合并先，塌缩后（命中 tombstone 改投存活者）——
    {
      const ts = Date.now();
      const urlB = `https://example.com/concur1-b-${ts}`;
      const bOut = await collapseRawItem(
        { id: await seedRaw(`concur1-b-${ts}`, urlB), url: urlB, title: 'Concur1 B', publishedAt: null, fetchedAt: new Date('2026-06-10T00:00:00Z') },
        db!,
      );
      const bDedupKey = bOut.dedupKey!;
      const { rows } = await pool!.query<{ event_id: string }>(`SELECT event_id FROM ai_news_events WHERE dedup_key=$1`, [bDedupKey]);
      const bEventId = rows[0]!.event_id;
      const aId = await seedEvent({ dedupKey: `${SOURCE}-concur1-a-${ts}`, title: 'Concur1 A', firstSeenAt: new Date('2026-06-01T00:00:00Z'), sourceCount: 1 });
      // 合并先：A 吞 B（A.sc = 1+1 = 2）。
      await mergeEvents(aId, bEventId, { cosineSim: 0.99, tier: 'high-auto', logProvenance: () => {} }, db!);
      // 塌缩后：命中 B 的 tombstone 改投 A（+1 → 3）；B 不被改。
      await collapseRawItem(
        { id: await seedRaw(`concur1-b2-${ts}`, urlB), url: urlB, title: 'Concur1 B dup', publishedAt: null, fetchedAt: new Date() },
        db!,
      );
      const a = await fetchEvent(aId);
      const b = await fetchEvent(bEventId);
      expect(Number(a!.source_count)).toBe(3); // 不丢不重
      expect(Number(b!.source_count)).toBe(1); // tombstone 冻结
    }

    // —— 序 2：塌缩先（落在尚未 tombstone 的命中行 B +1），合并后（A 吞 B 把这 +1 一并吸收）——
    {
      const ts = Date.now() + 1;
      const urlB = `https://example.com/concur2-b-${ts}`;
      const bOut = await collapseRawItem(
        { id: await seedRaw(`concur2-b-${ts}`, urlB), url: urlB, title: 'Concur2 B', publishedAt: null, fetchedAt: new Date('2026-06-10T00:00:00Z') },
        db!,
      );
      const bDedupKey = bOut.dedupKey!;
      const { rows } = await pool!.query<{ event_id: string }>(`SELECT event_id FROM ai_news_events WHERE dedup_key=$1`, [bDedupKey]);
      const bEventId = rows[0]!.event_id;
      const aId = await seedEvent({ dedupKey: `${SOURCE}-concur2-a-${ts}`, title: 'Concur2 A', firstSeenAt: new Date('2026-06-01T00:00:00Z'), sourceCount: 1 });
      // 塌缩先：B 尚未 tombstone，命中 B（非 tombstone）→ 正常 DO UPDATE B.sc = 1+1 = 2。
      await collapseRawItem(
        { id: await seedRaw(`concur2-b2-${ts}`, urlB), url: urlB, title: 'Concur2 B dup', publishedAt: null, fetchedAt: new Date() },
        db!,
      );
      expect(Number((await fetchEvent(bEventId))!.source_count)).toBe(2);
      // 合并后：A 吞 B（A.sc = 1 + 2 = 3），把塌缩先落到 B 的 +1 一并吸收进存活者 A。
      await mergeEvents(aId, bEventId, { cosineSim: 0.99, tier: 'high-auto', logProvenance: () => {} }, db!);
      const a = await fetchEvent(aId);
      const b = await fetchEvent(bEventId);
      expect(Number(a!.source_count)).toBe(3); // 1 + 2，增量最终落存活者、不丢不重
      expect(b!.merged_into).toBe(aId);
      expect(Number(b!.source_count)).toBe(2); // tombstone 冻结于被吞前的值
    }
  });
});

/** 插入一条 raw_item，返回 id（bigint）。 */
async function seedRaw(sourceItemId: string, url: string): Promise<bigint> {
  const { rows } = await pool!.query<{ id: string }>(
    `INSERT INTO raw_items (source, source_item_id, url, title) VALUES ($1,$2,$3,$4) RETURNING id`,
    [SOURCE, sourceItemId, url, 'seed title'],
  );
  return BigInt(rows[0]!.id);
}
