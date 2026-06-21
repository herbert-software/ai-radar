/**
 * 经验链编排集成测试（组 D 任务 4.5，**需本地 Postgres + pgvector**）。
 *
 * 在**函数层**测（直接调组 D 的函数，不需 runDailyWorkflow）。注入 mock mineExperience（产固定卡片）、
 * **绝不真调 LLM、绝不真发飞书/Telegram**。覆盖 spec blogger-experience-mining / knowledge-base 不变量：
 * - 经验类被路由进提炼链产卡片、不进 ai_news_events（4.1 排除 + 选条）；新闻类不误入经验链。
 * - 跨 feed 同 URL（不同 source_item_id）不产生重复卡片（ON CONFLICT 收敛）。
 * - **同批同 URL 只调一次 LLM**（DISTINCT ON 批内去重）。
 * - 高价值（≥70）入 KB、低价值（<70）不入 KB；经验入库**不要求已推送**。
 * - **纯经验-全已推日**：直接调 runExperienceKbIngestion 断言新 ≥70 卡片仍入 KB（与 push 状态无关）。
 * - published_at 为空卡片入 KB（eventDate 回退当日）但不进推送候选（recency 窗口对 NULL 求假）。
 * - canonical_url 为空的经验条目被选条排除、不提炼。
 *
 * 缺 DATABASE_URL 时本套件自动跳过。每个用例用唯一 source_item_id / URL 前缀隔离，afterAll 清理。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../../db/schema.js';

// 经 import 链触发 env 校验（缺关键变量即 throw）；为推送/LLM 相关变量注入占位（本套件不触网）。
process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
process.env.TELEGRAM_CHAT_ID ||= 'test-chat';
process.env.LLM_API_KEY ||= 'test-key';
process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph-token';

const {
  runExperienceMiningOnce,
  runExperienceKbIngestion,
  selectExperiencesForChannel,
} = await import('../experience-chain.js');
const { collapseUncollapsedRawItems } = await import('../../dedup/collapse.js');
const { getPushDate } = await import('../../push/push-date.js');
import type { MineExperienceFn } from '../experience-chain.js';
import type { ExperienceCard } from '../../agents/experience-mining/index.js';

const databaseUrl = process.env.DATABASE_URL;
const PREFIX = 'exp-chain-itest';
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
const db = pool ? drizzle(pool, { schema }) : null;

/** 固定经验卡片桩工厂（long_term_value 可调）。 */
function card(longTermValue: number): ExperienceCard {
  return {
    scenario: '用 Cursor 重构遗留代码的场景',
    tools: ['Cursor', 'Claude'],
    techniques: '先让 Agent 读全局再分步改，每步跑测试',
    applicability: '适用于有测试覆盖的 TypeScript 仓库',
    long_term_value: longTermValue,
    headline_zh: 'Cursor 重构遗留代码的实战要点',
    summary_zh: '分步改 + 每步跑测试，避免一次性大改引入回归。',
  };
}

/** mineExperience 桩：返回固定卡片并记录调用次数（断言 channel-blind / 批内去重只调一次）。 */
function mineStub(longTermValue: number) {
  const fn = vi.fn<MineExperienceFn>(async () => card(longTermValue));
  return fn;
}

/** 插入一条 blogger/experience raw_item（入库即 collapsed=true，含可空 canonical_url）。返回 id。 */
async function seedExperienceRaw(args: {
  sourceItemId: string;
  canonicalUrl: string | null;
  title: string;
  content?: string | null;
  publishedAt?: Date | null;
}): Promise<bigint> {
  const { rows } = await pool!.query<{ id: string }>(
    `INSERT INTO raw_items
       (source, source_item_id, raw_type, url, canonical_url, title, content, published_at, collapsed)
     VALUES ('blogger', $1, 'experience', $2, $2, $3, $4, $5, true)
     RETURNING id`,
    [
      args.sourceItemId,
      args.canonicalUrl,
      args.title,
      args.content ?? null,
      args.publishedAt ?? null,
    ],
  );
  return BigInt(rows[0]!.id);
}

async function countExperiences(canonicalUrl: string): Promise<number> {
  const { rows } = await pool!.query<{ c: string }>(
    `SELECT count(*)::text AS c FROM ai_experiences WHERE canonical_source_url = $1`,
    [canonicalUrl],
  );
  return Number(rows[0]!.c);
}

async function experienceIdByUrl(canonicalUrl: string): Promise<string | null> {
  const { rows } = await pool!.query<{ id: string }>(
    `SELECT id FROM ai_experiences WHERE canonical_source_url = $1`,
    [canonicalUrl],
  );
  return rows[0]?.id ?? null;
}

async function countKbDocs(targetId: string): Promise<number> {
  const { rows } = await pool!.query<{ c: string }>(
    `SELECT count(*)::text AS c FROM kb_documents WHERE target_id = $1 AND target_type = 'experience'`,
    [targetId],
  );
  return Number(rows[0]!.c);
}

async function fetchKbDoc(targetId: string) {
  const { rows } = await pool!.query<{
    kb_title: string | null;
    summary_zh: string | null;
    tags: unknown;
    entities: unknown;
    source_urls: unknown;
    event_date: Date | string | null;
    long_term_value: number | null;
    embedding: unknown;
  }>(
    `SELECT kb_title, summary_zh, tags, entities, source_urls, event_date, long_term_value, embedding
     FROM kb_documents WHERE target_id = $1 AND target_type = 'experience'`,
    [targetId],
  );
  return rows[0];
}

/**
 * 把 kb_documents.event_date 读回值归一为 YYYY-MM-DD（Asia/Shanghai）再比。
 * node-pg 把 date 列读回为本地午夜 Date（带时区偏移），string 则直接返回前 10 位。
 */
function normalizeEventDate(value: Date | string | null): string | null {
  if (value === null) return null;
  if (value instanceof Date) return getPushDate(value);
  return value.slice(0, 10);
}

/** 清理本套件造的行（按 URL/target_id 前缀）。 */
async function cleanup(): Promise<void> {
  // 先取本套件经验卡片 id，删其 KB 文档/记录，再删卡片与 raw_items。
  const { rows } = await pool!.query<{ id: string }>(
    `SELECT id FROM ai_experiences WHERE canonical_source_url LIKE $1`,
    [`%${PREFIX}%`],
  );
  const ids = rows.map((r) => r.id);
  if (ids.length > 0) {
    await pool!.query(
      `DELETE FROM kb_documents WHERE target_type='experience' AND target_id = ANY($1)`,
      [ids],
    );
    await pool!.query(
      `DELETE FROM kb_ingestion_records WHERE target_type='experience' AND target_id = ANY($1)`,
      [ids],
    );
    await pool!.query(
      `DELETE FROM push_records WHERE target_type='experience' AND target_id = ANY($1)`,
      [ids],
    );
  }
  await pool!.query(
    `DELETE FROM ai_experiences WHERE canonical_source_url LIKE $1`,
    [`%${PREFIX}%`],
  );
  await pool!.query(`DELETE FROM raw_items WHERE source = 'blogger' AND source_item_id LIKE $1`, [
    `${PREFIX}-%`,
  ]);
  await pool!.query(`DELETE FROM raw_items WHERE source = $1`, [`${PREFIX}-news`]);
}

beforeAll(async () => {
  if (pool) await cleanup();
});

afterAll(async () => {
  if (pool) {
    await cleanup();
    await pool.end();
  }
});

const noop = () => {};
/** 近期参考时刻（recency 窗口内的 published_at 用此往前几小时，确保过窗）。 */
const NOW = new Date('2026-06-20T03:00:00Z');
const RECENT_PUB = new Date('2026-06-19T08:00:00Z'); // 窗口内（默认 3 天）。
const OLD_PUB = new Date('2026-01-01T00:00:00Z'); // 窗口外（用于「不回推旧经验」）。

describe.skipIf(!databaseUrl)('经验链编排（组 D 不变量）', () => {
  it('经验类被路由进提炼链产卡片、不进 ai_news_events；新闻类不误入经验链', async () => {
    const ts = Date.now();
    const url = `https://example.com/${PREFIX}-route-${ts}`;
    const expId = await seedExperienceRaw({
      sourceItemId: `${PREFIX}-route-${ts}`,
      canonicalUrl: url,
      title: '经验帖标题',
      content: '正文',
      publishedAt: RECENT_PUB,
    });
    // 对照新闻行（source 非 blogger / raw_type 非 experience）：不应被经验链选中。
    await pool!.query(
      `INSERT INTO raw_items (source, source_item_id, raw_type, url, canonical_url, title)
       VALUES ($1, $2, 'news', $3, $3, '普通新闻')`,
      [`${PREFIX}-news`, `${PREFIX}-news-${ts}`, `https://example.com/${PREFIX}-news-${ts}`],
    );

    const mine = mineStub(80);
    const result = await runExperienceMiningOnce(
      { mineExperienceFn: mine, logError: noop },
      db!,
    );

    expect(result.candidates).toBeGreaterThanOrEqual(1);
    expect(result.mined).toBeGreaterThanOrEqual(1);
    // 经验卡片落库一行。
    expect(await countExperiences(url)).toBe(1);
    // mineExperience 没被新闻行触发（新闻行 raw_type!='experience' 不进选条）。
    const minedUrls = mine.mock.calls.map((c) => c[0].source);
    expect(minedUrls.every((s) => s === 'blogger')).toBe(true);

    // 经验行不进 ai_news_events：跑事件塌缩入口，experience 行被查询层排除。
    const outcomes = await collapseUncollapsedRawItems(db!);
    expect(outcomes.some((o) => o.rawItemId === expId)).toBe(false);
    const { rows: evRows } = await pool!.query(
      `SELECT 1 FROM ai_news_events WHERE representative_raw_item_id = $1`,
      [expId.toString()],
    );
    expect(evRows).toHaveLength(0);

    // 清理对照新闻行产生的 event（按其 dedup_key）。
    for (const o of outcomes) {
      if (o.dedupKey) {
        await pool!.query(
          `DELETE FROM ai_news_events WHERE dedup_key = $1 AND representative_raw_item_id IN
             (SELECT id FROM raw_items WHERE source = $2)`,
          [o.dedupKey, `${PREFIX}-news`],
        );
      }
    }
  });

  it('跨 feed 同 URL（不同 source_item_id）不产生重复卡片，且同批只调一次 LLM（DISTINCT ON 批内去重）', async () => {
    const ts = Date.now();
    const url = `https://example.com/${PREFIX}-dup-${ts}`;
    // 同一视频经两个 feed → 两条 raw_item、同 canonical_url。
    await seedExperienceRaw({
      sourceItemId: `${PREFIX}-dupA-${ts}`,
      canonicalUrl: url,
      title: '同一来源 feedA',
      publishedAt: RECENT_PUB,
    });
    await seedExperienceRaw({
      sourceItemId: `${PREFIX}-dupB-${ts}`,
      canonicalUrl: url,
      title: '同一来源 feedB',
      publishedAt: RECENT_PUB,
    });

    const mine = mineStub(75);
    await runExperienceMiningOnce({ mineExperienceFn: mine, logError: noop }, db!);

    // 批内去重：同 URL 一轮只提炼一次（只调一次 LLM）。
    expect(mine.mock.calls.length).toBe(1);
    // ON CONFLICT 收敛：该 URL 仅一行卡片。
    expect(await countExperiences(url)).toBe(1);

    // 跨天重跑：反连接预去重 → 该 URL 已有卡片 → 不再选中、不再调 LLM。
    const mine2 = mineStub(75);
    await runExperienceMiningOnce({ mineExperienceFn: mine2, logError: noop }, db!);
    expect(mine2.mock.calls.length).toBe(0);
    expect(await countExperiences(url)).toBe(1);
  });

  it('canonical_url 为空的经验条目被选条排除、不提炼（永久 collapsed sink）', async () => {
    const ts = Date.now();
    await seedExperienceRaw({
      sourceItemId: `${PREFIX}-nullurl-${ts}`,
      canonicalUrl: null,
      title: 'canonical 为空的经验帖',
      publishedAt: RECENT_PUB,
    });

    const mine = mineStub(90);
    const logs: string[] = [];
    const result = await runExperienceMiningOnce(
      {
        mineExperienceFn: mine,
        logError: (m) => logs.push(m),
      },
      db!,
    );
    // 该条 canonical_url 为空 → 不进候选、不提炼，但记一条信息日志（永久 collapsed sink）。
    expect(mine.mock.calls.length).toBe(0);
    expect(result.candidates).toBe(0);
    expect(logs.some((m) => m.includes('canonical_url 为空'))).toBe(true);
  });

  it('高价值（≥70）入 KB、不要求已推送；低价值（<70）不入 KB；KbStoreItem 10 字段映射正确', async () => {
    const ts = Date.now();
    const highUrl = `https://example.com/${PREFIX}-high-${ts}`;
    const lowUrl = `https://example.com/${PREFIX}-low-${ts}`;
    await seedExperienceRaw({
      sourceItemId: `${PREFIX}-high-${ts}`,
      canonicalUrl: highUrl,
      title: '高价值经验',
      publishedAt: RECENT_PUB,
    });
    await seedExperienceRaw({
      sourceItemId: `${PREFIX}-low-${ts}`,
      canonicalUrl: lowUrl,
      title: '低价值经验',
      publishedAt: RECENT_PUB,
    });

    // 提炼：高价值卡片 long_term_value=88，低价值=50（同批两 URL 各调一次）。
    await runExperienceMiningOnce(
      {
        mineExperienceFn: vi.fn<MineExperienceFn>(async (input) =>
          input.title === '高价值经验' ? card(88) : card(50),
        ),
        logError: noop,
      },
      db!,
    );

    const highId = await experienceIdByUrl(highUrl);
    const lowId = await experienceIdByUrl(lowUrl);
    expect(highId).toBeTruthy();
    expect(lowId).toBeTruthy();

    // KB 沉淀（不要求已推送：未 seed 任何 push_records）。
    const kb = await runExperienceKbIngestion(
      { now: NOW, store: { logError: noop }, logError: noop },
      db!,
    );
    expect(kb.candidates).toBeGreaterThanOrEqual(1);
    expect(kb.ingested).toBeGreaterThanOrEqual(1);

    // 高价值入 KB、低价值不入。
    expect(await countKbDocs(highId!)).toBe(1);
    expect(await countKbDocs(lowId!)).toBe(0);

    // KbStoreItem 10 字段映射断言。
    const doc = await fetchKbDoc(highId!)!;
    expect(doc!.kb_title).toBe('Cursor 重构遗留代码的实战要点'); // headline_zh ?? scenario
    expect(doc!.summary_zh).toBe('分步改 + 每步跑测试，避免一次性大改引入回归。');
    expect(doc!.tags).toEqual(['Cursor', 'Claude']); // tags = tools
    expect(doc!.entities).toEqual([]);
    expect(doc!.source_urls).toEqual([highUrl]); // canonical-only
    expect(doc!.long_term_value).toBe(88);
    expect(doc!.embedding).toBeNull();
    // eventDate = getPushDate(published_at)（Asia/Shanghai）。RECENT_PUB=2026-06-19T08:00Z → 2026-06-19。
    // date 列经 node-pg 读回为本地午夜 Date，故经同一 getPushDate 归一回 YYYY-MM-DD 再比（口径一致）。
    expect(normalizeEventDate(doc!.event_date)).toBe('2026-06-19');
  });

  it('KB 入库幂等：重复调 runExperienceKbIngestion 不产生重复 kb_documents（候选层 anti-join 剔已入库，candidates=0）', async () => {
    const ts = Date.now();
    const url = `https://example.com/${PREFIX}-idem-${ts}`;
    await seedExperienceRaw({
      sourceItemId: `${PREFIX}-idem-${ts}`,
      canonicalUrl: url,
      title: '幂等经验',
      publishedAt: RECENT_PUB,
    });
    await runExperienceMiningOnce(
      { mineExperienceFn: mineStub(82), logError: noop },
      db!,
    );
    const id = await experienceIdByUrl(url);

    const first = await runExperienceKbIngestion(
      { now: NOW, store: { logError: noop }, logError: noop },
      db!,
    );
    expect(first.ingested).toBeGreaterThanOrEqual(1);
    expect(await countKbDocs(id!)).toBe(1);

    // 重复：候选层 anti-join 把已 success 入库的卡片剔出候选 → candidates=0（比逐条开事务再 claim-skip 更省，
    // 防无界重扫）；不产生重复文档。并发下若 anti-join 未及（尚无 success 记录），storeKbDocument 的 claim CAS
    // 仍是去重兜底（见 kb-ingestion.integration 的事件侧覆盖）。
    const second = await runExperienceKbIngestion(
      { now: NOW, store: { logError: noop }, logError: noop },
      db!,
    );
    expect(second.candidates).toBe(0);
    expect(second.ingested).toBe(0);
    expect(await countKbDocs(id!)).toBe(1);
  });

  it('纯经验-全已推日：新 ≥70 卡片仍入 KB（与 push 状态无关，函数层断言）', async () => {
    const ts = Date.now();
    const url = `https://example.com/${PREFIX}-stranding-${ts}`;
    await seedExperienceRaw({
      sourceItemId: `${PREFIX}-stranding-${ts}`,
      canonicalUrl: url,
      title: '纯经验日新卡片',
      publishedAt: RECENT_PUB,
    });
    await runExperienceMiningOnce(
      { mineExperienceFn: mineStub(91), logError: noop },
      db!,
    );
    const id = await experienceIdByUrl(url);

    // 模拟「该卡片此前已被某 channel success 推送」（push 候选会排除它），但 KB 不以已推送为前提。
    await pool!.query(
      `INSERT INTO push_records (target_type, target_id, channel, push_date, status, pushed_at)
       VALUES ('experience', $1, 'telegram', '2026-06-19', 'success', now())`,
      [id],
    );

    // runExperienceKbIngestion 候选选条独立于 push_records → 仍入 KB。
    const kb = await runExperienceKbIngestion(
      { now: NOW, store: { logError: noop }, logError: noop },
      db!,
    );
    expect(kb.ingested).toBeGreaterThanOrEqual(1);
    expect(await countKbDocs(id!)).toBe(1);
  });

  it('published_at 为空卡片入 KB（eventDate 回退当日）但不进推送候选；窗外旧经验不进推送候选', async () => {
    const ts = Date.now();
    const nullPubUrl = `https://example.com/${PREFIX}-nullpub-${ts}`;
    const oldUrl = `https://example.com/${PREFIX}-old-${ts}`;
    const recentUrl = `https://example.com/${PREFIX}-recent-${ts}`;
    await seedExperienceRaw({
      sourceItemId: `${PREFIX}-nullpub-${ts}`,
      canonicalUrl: nullPubUrl,
      title: 'published 为空',
      publishedAt: null,
    });
    await seedExperienceRaw({
      sourceItemId: `${PREFIX}-old-${ts}`,
      canonicalUrl: oldUrl,
      title: '窗外旧经验',
      publishedAt: OLD_PUB,
    });
    await seedExperienceRaw({
      sourceItemId: `${PREFIX}-recent-${ts}`,
      canonicalUrl: recentUrl,
      title: '窗内新经验',
      publishedAt: RECENT_PUB,
    });
    await runExperienceMiningOnce(
      { mineExperienceFn: mineStub(85), logError: noop },
      db!,
    );

    const nullPubId = await experienceIdByUrl(nullPubUrl);
    const oldId = await experienceIdByUrl(oldUrl);
    const recentId = await experienceIdByUrl(recentUrl);

    // KB：所有 ≥70 都入（含 null published_at，eventDate 回退当日）。
    await runExperienceKbIngestion(
      { now: NOW, store: { logError: noop }, logError: noop },
      db!,
    );
    expect(await countKbDocs(nullPubId!)).toBe(1);
    // null published_at 的 eventDate 回退当日 pushDate（getPushDate(NOW) Asia/Shanghai = 2026-06-20）。
    const nullDoc = await fetchKbDoc(nullPubId!);
    expect(normalizeEventDate(nullDoc!.event_date)).toBe('2026-06-20');

    // 推送候选：只含窗内卡片，排除 null published_at 与窗外旧经验。
    const candidates = await selectExperiencesForChannel('telegram', db!, { now: NOW });
    const candIds = new Set(candidates.map((c) => c.eventId));
    expect(candIds.has(recentId!)).toBe(true);
    expect(candIds.has(nullPubId!)).toBe(false);
    expect(candIds.has(oldId!)).toBe(false);
  });

  it('推送候选跨天不重推：已以该 channel success 的卡片不再进候选', async () => {
    const ts = Date.now();
    const url = `https://example.com/${PREFIX}-nopush-${ts}`;
    await seedExperienceRaw({
      sourceItemId: `${PREFIX}-nopush-${ts}`,
      canonicalUrl: url,
      title: '已推过的经验',
      publishedAt: RECENT_PUB,
    });
    await runExperienceMiningOnce(
      { mineExperienceFn: mineStub(95), logError: noop },
      db!,
    );
    const id = await experienceIdByUrl(url);

    // 未推送前：进候选。
    let candidates = await selectExperiencesForChannel('telegram', db!, { now: NOW });
    expect(candidates.some((c) => c.eventId === id)).toBe(true);
    // feishu 通道独立命名空间：telegram success 不影响 feishu 候选。

    // 以 telegram success 推送后：telegram 候选排除它，feishu 仍含它。
    await pool!.query(
      `INSERT INTO push_records (target_type, target_id, channel, push_date, status, pushed_at)
       VALUES ('experience', $1, 'telegram', '2026-06-19', 'success', now())`,
      [id],
    );
    candidates = await selectExperiencesForChannel('telegram', db!, { now: NOW });
    expect(candidates.some((c) => c.eventId === id)).toBe(false);
    const feishuCandidates = await selectExperiencesForChannel('feishu', db!, { now: NOW });
    expect(feishuCandidates.some((c) => c.eventId === id)).toBe(true);
  });
});
