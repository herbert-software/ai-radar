/**
 * Hugging Face Papers 采集器单元测试（add-tier1-ai-sources 任务 7.1，**纯 mock 不触网、不依赖 DB**）。
 *
 * 覆盖不变量（spec「Hugging Face Papers 采集」/ design D2）：
 * - 映射：source='hugging_face_papers'、sourceItemId=String(paper.id)、
 *   url=`https://huggingface.co/papers/{id}`、title=paper.title、content=paper.summary、
 *   publishedAt 经 arxiv toDate NaN 守卫（有效日期则 Date 否则 null）。
 * - rawType='paper' + collapsed=true（仅沉淀口径，与 arXiv 同）。
 * - maxPerRun 截断（注入 maxPerRun=N → 只取前 N 条）。
 * - 缺 paper.id → 跳过不发射（结果绝不出现 'null'/'undefined' 假 source_item_id）。
 * - 缺 paper.title（含纯空白）→ 跳过不发射（无空 title 条目）。
 * - 单源失败（fetchJson 抛错）经 withRetry 重试耗尽后抛出（整源失败由编排层隔离）。
 * - 用固化真实结构 daily_papers 响应 fixture 验字段名（嵌套 paper + 元素级 submittedBy/numComments）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';

let mod: typeof import('../hf-papers.js');

beforeAll(async () => {
  process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
  process.env.REDIS_URL ||= 'redis://localhost:6379';
  process.env.LLM_API_KEY ||= 'test-key';
  process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
  process.env.LLM_BASE_URL ||= 'https://example.invalid/v1';
  process.env.TELEGRAM_BOT_TOKEN ||= 'test-bot-token';
  process.env.TELEGRAM_CHAT_ID ||= 'test-chat-id';
  // 纯净 CI 无 .env 时 env.ts module-load 会因缺 PRODUCT_HUNT_TOKEN throw（FIX-3，比照 product-hunt.test.ts）。
  process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph-token';
  mod = await import('../hf-papers.js');
});

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadFixture(): unknown {
  const fixturePath = join(__dirname, 'fixtures', 'hf-daily-papers.json');
  return JSON.parse(readFileSync(fixturePath, 'utf8'));
}

describe('collectHfPapers 映射统一结构（固化真实 daily_papers fixture）', () => {
  it('正常条目：source/rawType/collapsed/sourceItemId/url/title/content/publishedAt/metadata 就位', async () => {
    const fixture = loadFixture();
    const items = await mod.collectHfPapers({
      fetchJson: async () => fixture,
      logError: () => {},
    });

    const first = items.find((i) => i.sourceItemId === '2406.12345');
    expect(first).toBeDefined();
    expect(first!.source).toBe('hugging_face_papers');
    expect(first!.rawType).toBe('paper');
    expect(first!.collapsed).toBe(true);
    // sourceItemId = String(paper.id)。
    expect(first!.sourceItemId).toBe('2406.12345');
    // url = https://huggingface.co/papers/{id}。
    expect(first!.url).toBe('https://huggingface.co/papers/2406.12345');
    // title = paper.title。
    expect(first!.title).toBe('Scaling Laws for Reward Model Overoptimization');
    // content = paper.summary。
    expect(first!.content).toBe(
      'We study the effect of optimizing against a reward model and characterize the overoptimization regime across model scales.',
    );
    // publishedAt 经 toDate：有效日期 → Date。
    expect(first!.publishedAt).toBeInstanceOf(Date);
    expect(first!.publishedAt!.toISOString()).toBe('2026-06-13T00:00:00.000Z');
    // metadata 承载来源身份（hf_paper_id + submittedBy + num_comments）。
    expect(first!.metadata?.hf_paper_id).toBe('2406.12345');
    expect(first!.metadata?.submittedBy).toBe('AK'); // fullname 优先。
    expect(first!.metadata?.num_comments).toBe(7);
    // FIX-9：paper.organization 可得 → 落 metadata.organization。
    expect(first!.metadata?.organization).toBe('OpenAI');
  });

  it('paper.publishedAt 为 null → publishedAt 为 null（非 Date、非 epoch）', async () => {
    const fixture = loadFixture();
    const items = await mod.collectHfPapers({
      fetchJson: async () => fixture,
      logError: () => {},
    });
    const second = items.find((i) => i.sourceItemId === '2406.67890');
    expect(second).toBeDefined();
    expect(second!.publishedAt).toBeNull();
    // submittedBy 为字符串形式也能取到。
    expect(second!.metadata?.submittedBy).toBe('guest-submitter');
    // FIX-9：无 organization 的条目 metadata 不含该键（「可得才放」）。
    expect(second!.metadata).not.toHaveProperty('organization');
  });

  it('paper.publishedAt 为非法日期串 → publishedAt 为 null（toDate NaN 守卫）', async () => {
    const fixture = loadFixture();
    const items = await mod.collectHfPapers({
      fetchJson: async () => fixture,
      logError: () => {},
    });
    const bad = items.find((i) => i.sourceItemId === '2406.11111');
    expect(bad).toBeDefined();
    expect(bad!.publishedAt).toBeNull();
  });

  it('paper.id 为数字 → sourceItemId 字符串化', async () => {
    const items = await mod.collectHfPapers({
      fetchJson: async () => [
        { paper: { id: 12345, title: 'Numeric id paper', summary: 'x' } },
      ],
      logError: () => {},
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.sourceItemId).toBe('12345');
    expect(items[0]!.url).toBe('https://huggingface.co/papers/12345');
  });
});

describe('collectHfPapers 缺字段跳过（M-B：绝不产假 id / 绝不空 title）', () => {
  it('缺 paper.id（含 null/空串）→ 跳过该条，结果不含 null/undefined 假 source_item_id', async () => {
    const fixture = loadFixture();
    const items = await mod.collectHfPapers({
      fetchJson: async () => fixture,
      logError: () => {},
    });
    const ids = items.map((i) => i.sourceItemId);
    // fixture 第三条缺 paper.id → 跳过；绝不出现 'null'/'undefined' 假 id。
    expect(ids).not.toContain('null');
    expect(ids).not.toContain('undefined');
    // url 也绝不含 .../papers/null 或 .../papers/undefined。
    for (const it of items) {
      expect(it.url).not.toContain('/papers/null');
      expect(it.url).not.toContain('/papers/undefined');
    }
  });

  it('缺 paper.id 的多种形态（null / 空串 / 纯空白 / 缺字段 / 缺 paper 子对象）全部跳过', async () => {
    const items = await mod.collectHfPapers({
      fetchJson: async () => [
        { paper: { id: null, title: 'null id' } },
        { paper: { id: '', title: 'empty id' } },
        { paper: { id: '   ', title: 'whitespace id' } },
        { paper: { title: 'missing id field' } },
        { paper: null },
        {},
        { paper: { id: 'keep-1', title: 'kept' } },
      ],
      logError: () => {},
    });
    // 仅最后一条合法者被发射。
    expect(items.map((i) => i.sourceItemId)).toEqual(['keep-1']);
  });

  it('缺 paper.title（含纯空白）→ 跳过该条，结果无空 title 条目', async () => {
    const fixture = loadFixture();
    const items = await mod.collectHfPapers({
      fetchJson: async () => fixture,
      logError: () => {},
    });
    // fixture 第四条 id=2406.00000 title 为纯空白 → 跳过。
    expect(items.map((i) => i.sourceItemId)).not.toContain('2406.00000');
    // 任何发射条目 title 非空。
    for (const it of items) {
      expect(it.title.trim().length).toBeGreaterThan(0);
    }
  });

  it('记日志：缺 id / 缺 title 时调 logError（非静默丢弃）', async () => {
    const logError = vi.fn();
    await mod.collectHfPapers({
      fetchJson: async () => [
        { paper: { title: 'no id' } },
        { paper: { id: 'x', title: '  ' } },
      ],
      logError,
    });
    expect(logError).toHaveBeenCalled();
  });
});

describe('collectHfPapers 危险字节净化（对等 sitemap stripUnsafeChars，防 PG INSERT 中止整批）', () => {
  // 在测试内用 String.fromCharCode 构造控制字符/lone surrogate，绝不在源/fixture 写字面控制字节。
  const NUL = String.fromCharCode(0);
  const BEL = String.fromCharCode(7); // C0 控制符。
  const LONE_HIGH = String.fromCharCode(0xd800); // lone high surrogate。
  // eslint-disable-next-line no-control-regex -- 测试断言：有意检测控制字符是否被净化
  const UNSAFE_RE = /[\u0000-\u001f\ud800-\udfff]/;

  it('title 含 NUL+控制符 / summary 含 lone surrogate → 发射条目净化、title 非空、metadata 可 JSON.stringify', async () => {
    const items = await mod.collectHfPapers({
      fetchJson: async () => [
        {
          paper: {
            id: '2406.99999',
            title: `Safe${NUL}Title${BEL}`,
            summary: `Summary with lone surrogate${LONE_HIGH} tail`,
          },
          submittedBy: `Sub${NUL}mitter`,
          organization: `Org${BEL}Name`,
        },
      ],
      logError: () => {},
    });
    expect(items).toHaveLength(1);
    const item = items[0]!;
    // title/content 不含任何危险码点（NUL/C0/lone surrogate）。
    expect(UNSAFE_RE.test(item.title)).toBe(false);
    expect(UNSAFE_RE.test(item.content!)).toBe(false);
    // title 非空（净化后仍保留可见字符）。
    expect(item.title.length).toBeGreaterThan(0);
    expect(item.title).toBe('SafeTitle');
    // metadata 字符串值也净化 → JSON.stringify 不抛（lone surrogate 会破坏序列化）。
    expect(() => JSON.stringify(item.metadata)).not.toThrow();
    expect(UNSAFE_RE.test(String(item.metadata?.submittedBy))).toBe(false);
    expect(UNSAFE_RE.test(String(item.metadata?.organization))).toBe(false);
  });

  it('id 全控制符（strip 致空）→ 该条被跳过，绝不发射假 id', async () => {
    const items = await mod.collectHfPapers({
      fetchJson: async () => [
        { paper: { id: `${NUL}${BEL}`, title: 'all-control id' } },
        { paper: { id: 'keep-2', title: 'kept' } },
      ],
      logError: () => {},
    });
    // 仅合法 id 被发射；全控制符 id strip 致空 → 跳过（不产 .../papers/ 假 id）。
    expect(items.map((i) => i.sourceItemId)).toEqual(['keep-2']);
  });
});

describe('collectHfPapers maxPerRun 截断', () => {
  it('注入 maxPerRun=N → 只取前 N 条（截断在跳过判定前，对返回顺序取头部）', async () => {
    const body = Array.from({ length: 5 }, (_, i) => ({
      paper: { id: `p${i}`, title: `Paper ${i}`, summary: `s${i}` },
    }));
    const items = await mod.collectHfPapers({
      fetchJson: async () => body,
      logError: () => {},
      maxPerRun: 2,
    });
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.sourceItemId)).toEqual(['p0', 'p1']);
  });
});

describe('collectHfPapers rawType/collapsed 仅沉淀口径', () => {
  it('所有发射条目 rawType=paper、collapsed=true', async () => {
    const fixture = loadFixture();
    const items = await mod.collectHfPapers({
      fetchJson: async () => fixture,
      logError: () => {},
    });
    expect(items.length).toBeGreaterThan(0);
    for (const it of items) {
      expect(it.rawType).toBe('paper');
      expect(it.collapsed).toBe(true);
    }
  });
});

describe('collectHfPapers 单源失败隔离', () => {
  it('fetchJson 抛错 → withRetry 重试后抛出（整源失败由编排层隔离）', async () => {
    let calls = 0;
    await expect(
      mod.collectHfPapers({
        maxAttempts: 3,
        baseDelayMs: 0,
        sleep: async () => {},
        logError: () => {},
        fetchJson: async () => {
          calls += 1;
          throw new Error('HF daily_papers 503');
        },
      }),
    ).rejects.toThrow('HF daily_papers 503');
    expect(calls).toBe(3); // 用满 maxAttempts。
  });
});

describe('collectHfPapers 非数组 body 判源失败（FIX-4）', () => {
  it('fetchJson 返回非数组（疑似错误体 {error:...}）→ 抛出，绝不静默返 []', async () => {
    await expect(
      mod.collectHfPapers({
        fetchJson: async () => ({ error: 'x' }),
        logError: () => {},
      }),
    ).rejects.toThrow(/非数组/);
  });

  it('记日志：非数组 body 时调 logError（非静默）', async () => {
    const logError = vi.fn();
    await expect(
      mod.collectHfPapers({
        fetchJson: async () => ({ error: 'x' }),
        logError,
      }),
    ).rejects.toThrow();
    expect(logError).toHaveBeenCalled();
  });

  it('FIX-D：合法空数组（当日 0 论文）→ 返回 [] 且不抛（空数组=正常 / 非数组=失败 的正向边）', async () => {
    const items = await mod.collectHfPapers({
      fetchJson: async () => [],
      logError: () => {},
    });
    expect(items).toEqual([]);
  });
});
