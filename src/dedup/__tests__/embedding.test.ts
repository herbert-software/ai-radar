/**
 * 事件 embedding 生成单元测试（add-semantic-dedup-and-store-hardening，组 C 任务 3.3）。
 *
 * 全程注入桩、不触网、不连真实 DB（用最小 fake db 模拟 drizzle 查询链）。覆盖 spec 四点：
 * ① 已有 embedding 的事件不重新生成（候选 SELECT 带 `embedding IS NULL`，fake db 只喂未嵌行 →
 *    已嵌事件不在候选 → 不调用 embed）；
 * ② 一条生成失败时其余照常落库、失败条被跳过（写回逐条 try/catch；批量失败整批 failed）；
 * ③ 窗内历史 `embedding IS NULL` 事件被补嵌（非仅本轮新事件）——候选含未列入 thisRoundEventIds 的历史行；
 * ④ 空/空白文本事件被跳过、不调用 embed（空文本不进 embedTexts 的 values）。
 *
 * 另覆盖低层原语 embedTexts 的重试 / 长度校验 / 注入桩，与「嵌入顺序：先本轮新事件」排序。
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';

// embedding.ts 经 import 链触发 env 校验（缺关键变量即 throw）。本套件不依赖真实 key/DB，
// 注入占位 env（仅需非空字符串/合法 URL）后再动态 import，使无凭据/无 DB 即可跑。
// 用 ||= 兼容空串 env（已定义但为空，如 `export DATABASE_URL=`）。
let mod: typeof import('../embedding.js');

beforeAll(async () => {
  process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
  process.env.REDIS_URL ||= 'redis://localhost:6379';
  process.env.LLM_API_KEY ||= 'test-key';
  process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
  process.env.LLM_BASE_URL ||= 'https://example.invalid/v1';
  process.env.TELEGRAM_BOT_TOKEN ||= 'test-bot-token';
  process.env.TELEGRAM_CHAT_ID ||= 'test-chat-id';
  process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph-token';
  mod = await import('../embedding.js');
});

/** 一条候选行（与 runEmbeddingBootstrap 的候选 SELECT 投影同形）。 */
interface FakeRow {
  eventId: string;
  representativeTitle: string | null;
  representativeRawItemId: bigint | null;
  mainEntities: unknown;
  firstSeenAt: Date | null;
  content: string | null;
}

/** 一次写回记录（eventId → 落库的向量）。 */
interface WriteRecord {
  eventId: string;
  embedding: number[];
}

/**
 * 最小 fake db：模拟 runEmbeddingBootstrap 用到的 drizzle 链。
 * - 读链：select().from().leftJoin().where().orderBy() → 返回预置 rows（已按 firstSeenAt 升序排好）。
 * - 写链：update().set({embedding}).where() → 记录到 writes（不真正过滤，断言交给测试逻辑）。
 *
 * fake 不复刻 SQL 谓词语义；「已嵌不重生成」「tombstone 不嵌」由「只把未嵌、非 tombstone 行喂进
 * rows」来体现（候选 SELECT 在真实 DB 由 WHERE 保证，集成测试另证；此处验应用层编排）。
 */
function makeFakeDb(
  rows: FakeRow[],
  writes: WriteRecord[],
  opts?: { failWriteFor?: Set<string> | undefined },
) {
  const selectChain = {
    from: () => selectChain,
    leftJoin: () => selectChain,
    where: () => selectChain,
    orderBy: () => Promise.resolve(rows),
  };
  return {
    select: () => selectChain,
    update: () => ({
      set: (vals: { embedding: number[] }) => ({
        // drizzle 的 .where() 返回可 await 的 query；fake 在 await 时执行写入。
        // fake 无法解析 where 里的 event_id，故按「写回顺序 = toEmbed 顺序」从
        // pendingEventIds 队列出队对齐 eventId（队列由 runWithFake 预填，见其注释）。
        where: () => ({
          then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
            try {
              const eventId = pendingEventIds.shift()!;
              if (opts?.failWriteFor?.has(eventId)) {
                throw new Error(`fake write fail for ${eventId}`);
              }
              writes.push({ eventId, embedding: vals.embedding });
              resolve(undefined);
            } catch (e) {
              reject(e);
            }
          },
        }),
      }),
    }),
  };
}

// 写回 eventId 对齐：runEmbeddingBootstrap 逐条 update 时，fake 无法读 where 里的 eventId，
// 故在测试侧维护一个与 toEmbed 同序的队列，每次 update().set().where() 出队一个。
let pendingEventIds: string[] = [];

/**
 * 跑一次 bootstrap：预置候选 rows + 本轮 thisRoundEventIds + embedManyFn 桩。
 * 写回顺序 = 非空文本候选按「先本轮新事件、再 firstSeenAt 升序」排序后的顺序——
 * 测试侧据此预填 pendingEventIds 队列对齐写回的 eventId。
 */
async function runWithFake(args: {
  rows: FakeRow[];
  thisRoundEventIds?: string[] | undefined;
  embedManyFn: NonNullable<import('../embedding.js').EmbedManyFn>;
  failWriteFor?: Set<string> | undefined;
  maxPerRun?: number | undefined;
}) {
  const writes: WriteRecord[] = [];
  // 计算 toEmbed 顺序（与实现一致）：稳定排序「本轮新事件优先」后过滤空文本。
  const thisRound = new Set(args.thisRoundEventIds ?? []);
  const ordered = [...args.rows].sort((a, b) => {
    const aNew = thisRound.has(a.eventId) ? 0 : 1;
    const bNew = thisRound.has(b.eventId) ? 0 : 1;
    return aNew - bNew;
  });
  const selected = ordered.slice(0, args.maxPerRun ?? 500);
  pendingEventIds = selected
    .filter((r) => mod.buildEmbeddingText({
      representativeTitle: r.representativeTitle,
      content: r.content,
      mainEntities: r.mainEntities,
    }) !== null)
    .map((r) => r.eventId);

  const fakeDb = makeFakeDb(args.rows, writes, { failWriteFor: args.failWriteFor });
  const logError = vi.fn();
  const bootstrapOpts: Parameters<typeof mod.runEmbeddingBootstrap>[0] = {
    embed: { embedManyFn: args.embedManyFn, logError: () => {} },
    logError,
  };
  if (args.maxPerRun !== undefined) bootstrapOpts.maxPerRun = args.maxPerRun;
  if (args.thisRoundEventIds !== undefined) {
    bootstrapOpts.thisRoundEventIds = args.thisRoundEventIds;
  }
  const result = await mod.runEmbeddingBootstrap(
    bootstrapOpts,
    fakeDb as unknown as Parameters<typeof mod.runEmbeddingBootstrap>[1],
  );
  return { result, writes, logError };
}

function row(over: Partial<FakeRow> & { eventId: string }): FakeRow {
  return {
    representativeTitle: 'Some Title',
    representativeRawItemId: 1n,
    mainEntities: null,
    firstSeenAt: new Date('2026-06-01T00:00:00Z'),
    content: 'some content body',
    ...over,
  };
}

describe('buildEmbeddingText（空文本兜底 + 拼接 + 截断）', () => {
  it('title + content 摘录拼接', () => {
    const text = mod.buildEmbeddingText({
      representativeTitle: 'GPT-5 released',
      content: 'OpenAI announced GPT-5 today.',
      mainEntities: null,
    });
    expect(text).toContain('GPT-5 released');
    expect(text).toContain('OpenAI announced GPT-5 today.');
  });

  it('content 超长被截断到 maxChars', () => {
    const long = 'x'.repeat(5000);
    const text = mod.buildEmbeddingText(
      { representativeTitle: 'T', content: long, mainEntities: null },
      100,
    );
    // 标题 'T' + '\n' + 100 个 x = 102；不应含 5000 长 content。
    expect(text!.length).toBeLessThanOrEqual(1 + 1 + 100);
    expect(text).toContain('x'.repeat(100));
  });

  it('main_entities 若存在则附加（数组取字符串元素）', () => {
    const text = mod.buildEmbeddingText({
      representativeTitle: 'T',
      content: null,
      mainEntities: ['Anthropic', 'Claude'],
    });
    expect(text).toContain('Anthropic');
    expect(text).toContain('Claude');
  });

  it('title 空串 + content 为 NULL → 返回 null（空文本兜底）', () => {
    expect(
      mod.buildEmbeddingText({ representativeTitle: '', content: null, mainEntities: null }),
    ).toBeNull();
  });

  it('纯空白（标题全空格 + content 空白）→ 返回 null', () => {
    expect(
      mod.buildEmbeddingText({ representativeTitle: '   ', content: '  \n\t ', mainEntities: null }),
    ).toBeNull();
  });
});

describe('embedTexts（低层原语：重试 / 长度校验 / 注入桩）', () => {
  it('空数组直接返回 []，不调用 embedManyFn', async () => {
    const embedManyFn = vi.fn();
    const out = await mod.embedTexts([], { embedManyFn });
    expect(out).toEqual([]);
    expect(embedManyFn).not.toHaveBeenCalled();
  });

  it('成功路径：返回与文本同序等长的向量', async () => {
    const embedManyFn = vi
      .fn()
      .mockResolvedValue({ embeddings: [[0.1, 0.2], [0.3, 0.4]] });
    const out = await mod.embedTexts(['a', 'b'], { embedManyFn, logError: () => {} });
    expect(out).toEqual([[0.1, 0.2], [0.3, 0.4]]);
    expect(embedManyFn).toHaveBeenCalledTimes(1);
  });

  it('首次抛错后重试成功', async () => {
    const embedManyFn = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce({ embeddings: [[1, 2]] });
    const out = await mod.embedTexts(['a'], { embedManyFn, logError: () => {} });
    expect(out).toEqual([[1, 2]]);
    expect(embedManyFn).toHaveBeenCalledTimes(2);
  });

  it('返回向量数与文本数不等长 → 视为失败重试，最终抛错（绝不错位落库）', async () => {
    const embedManyFn = vi.fn().mockResolvedValue({ embeddings: [[1, 2]] }); // 请求 2 条只回 1 个
    const logError = vi.fn();
    await expect(
      mod.embedTexts(['a', 'b'], { embedManyFn, maxAttempts: 2, logError }),
    ).rejects.toBeTruthy();
    expect(embedManyFn).toHaveBeenCalledTimes(2);
    expect(logError).toHaveBeenCalledTimes(2);
  });

  it('全部尝试失败 → 抛最后一次错误', async () => {
    const embedManyFn = vi.fn().mockRejectedValue(new Error('down'));
    await expect(
      mod.embedTexts(['a'], { embedManyFn, maxAttempts: 3, logError: () => {} }),
    ).rejects.toThrow('down');
    expect(embedManyFn).toHaveBeenCalledTimes(3);
  });
});

describe('runEmbeddingBootstrap（候选窗口 bootstrap：四不变量）', () => {
  it('① 已有 embedding 的事件不在候选 → 不嵌、不写（候选 SELECT 带 embedding IS NULL）', async () => {
    // fake db 的 rows 即候选 SELECT 结果（真实 DB 由 WHERE embedding IS NULL 过滤掉已嵌行）。
    // 这里喂入空候选模拟「窗内只有已嵌事件」，断言 embed 不被调用、无写回。
    const embedManyFn = vi.fn();
    const { result, writes } = await runWithFake({ rows: [], embedManyFn });
    expect(embedManyFn).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
    expect(result).toMatchObject({ candidates: 0, attempted: 0, embedded: 0 });
  });

  it('② 批量生成失败：整批跳过（保留独立）、failed 计数、不中止、无写回', async () => {
    const rows = [row({ eventId: 'e1' }), row({ eventId: 'e2' })];
    const embedManyFn = vi.fn().mockRejectedValue(new Error('embed API down'));
    const { result, writes, logError } = await runWithFake({
      rows,
      embedManyFn,
    });
    expect(result).toMatchObject({ attempted: 2, embedded: 0, failed: 2, skippedEmpty: 0 });
    expect(writes).toEqual([]);
    expect(logError).toHaveBeenCalled(); // 失败被记日志（非静默）
  });

  it('②b 写回阶段单条失败：其余照常落库、失败条被跳过、不中止整批', async () => {
    const rows = [row({ eventId: 'e1' }), row({ eventId: 'e2' }), row({ eventId: 'e3' })];
    const embedManyFn = vi
      .fn()
      .mockResolvedValue({ embeddings: [[1], [2], [3]] });
    const { result, writes } = await runWithFake({
      rows,
      embedManyFn,
      failWriteFor: new Set(['e2']),
    });
    // e2 写回抛错被隔离；e1/e3 照常落库。
    expect(result).toMatchObject({ attempted: 3, embedded: 2, failed: 1 });
    expect(writes.map((w) => w.eventId).sort()).toEqual(['e1', 'e3']);
  });

  it('③ 窗内历史事件（不在 thisRoundEventIds）被补嵌——非仅本轮新事件', async () => {
    // hist 是历史存活者（embedding IS NULL、不在本轮新事件集）；must 仍被嵌入。
    const rows = [
      row({ eventId: 'hist', firstSeenAt: new Date('2026-05-20T00:00:00Z') }),
      row({ eventId: 'new', firstSeenAt: new Date('2026-06-14T00:00:00Z') }),
    ];
    const embedManyFn = vi
      .fn()
      .mockResolvedValue({ embeddings: [[9], [8]] });
    const { result, writes } = await runWithFake({
      rows,
      thisRoundEventIds: ['new'],
      embedManyFn,
    });
    expect(result).toMatchObject({ candidates: 2, attempted: 2, embedded: 2 });
    expect(writes.map((w) => w.eventId).sort()).toEqual(['hist', 'new']);
    // 嵌入顺序：先本轮新事件 'new'，再历史 'hist'（验「先本轮新事件」而非纯 firstSeenAt 升序）。
    const order = embedManyFn.mock.calls[0]![0].values;
    expect(order).toHaveLength(2);
    // values 与 toEmbed 同序；'new' 的文本应排在 'hist' 之前。
    expect(writes[0]!.eventId).toBe('new');
    expect(writes[1]!.eventId).toBe('hist');
  });

  it('④ 空/空白文本事件被跳过、不进 embed 的 values', async () => {
    const rows = [
      row({ eventId: 'good', representativeTitle: 'Real Title', content: 'real content' }),
      row({ eventId: 'empty', representativeTitle: '', content: null }),
      row({ eventId: 'blank', representativeTitle: '   ', content: '  \t ' }),
    ];
    const embedManyFn = vi.fn().mockResolvedValue({ embeddings: [[1, 1, 1]] });
    const { result, writes, logError } = await runWithFake({ rows, embedManyFn });
    // 仅 good 进 embed；empty/blank 被空文本兜底跳过。
    expect(result).toMatchObject({ attempted: 1, embedded: 1, skippedEmpty: 2 });
    expect(writes.map((w) => w.eventId)).toEqual(['good']);
    const values = embedManyFn.mock.calls[0]![0].values;
    expect(values).toHaveLength(1);
    expect(values[0]).toContain('Real Title');
    // 空文本跳过被记日志（非静默）。
    expect(logError).toHaveBeenCalled();
  });

  it('单轮 backlog 上限：超 maxPerRun 的余量 deferred、本轮不嵌', async () => {
    const rows = [
      row({ eventId: 'a', firstSeenAt: new Date('2026-06-01T00:00:00Z') }),
      row({ eventId: 'b', firstSeenAt: new Date('2026-06-02T00:00:00Z') }),
      row({ eventId: 'c', firstSeenAt: new Date('2026-06-03T00:00:00Z') }),
    ];
    const embedManyFn = vi.fn().mockResolvedValue({ embeddings: [[1], [2]] });
    const { result, writes } = await runWithFake({ rows, embedManyFn, maxPerRun: 2 });
    expect(result).toMatchObject({ candidates: 3, attempted: 2, embedded: 2, deferred: 1 });
    // 截上限按嵌入顺序（无本轮新事件 → firstSeenAt 升序）取前 2：a、b；c 留待下轮。
    expect(writes.map((w) => w.eventId).sort()).toEqual(['a', 'b']);
  });
});
