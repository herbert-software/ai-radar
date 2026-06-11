/**
 * buildDigestMessage 单测：
 * - includedIds == 实际拼进消息（未被截断丢弃）的事件 id（修复「截断却全标 success → 永久漏推」契约）。
 * - 新格式：序号 + 标题(粗体) + headline 一句话 + 原文可点击链接（design D2）。
 * - URL 用独立 escapeMarkdownV2Url（仅转 `)` `\`，不破坏 `. - _ =`，design D3）。
 * - 回退链：headline 缺 → summary 截断 → 仅标题；canonical_url 缺 → 不渲染链接。
 * - 标题渲染期按 code point 截断（转义前）。
 * 无需 DB/Redis。
 */
import { describe, expect, it } from 'vitest';
import type { SelectedEvent } from '../../selection/top-n.js';
import { buildDigestMessage, escapeMarkdownV2Url } from '../message.js';

function ev(id: string, overrides: Partial<SelectedEvent> = {}): SelectedEvent {
  return {
    eventId: id,
    representativeTitle: `标题-${id}`,
    summaryZh: null,
    headlineZh: `要点-${id}`,
    canonicalUrl: 'https://example.com/a',
    publishedAt: null,
    rankScore: 0,
    ...overrides,
  };
}

describe('buildDigestMessage includedIds', () => {
  it('未截断：includedIds 含全部事件，保持入参顺序', () => {
    const events = [ev('e1'), ev('e2'), ev('e3')];
    const { includedIds, text } = buildDigestMessage(events);
    expect(includedIds).toEqual(['e1', 'e2', 'e3']);
    expect(text).not.toContain('未展示');
  });

  it('截断：includedIds 只含实际拼进消息的前缀事件，被截断者不在其中', () => {
    // 造若干超长 headline 占位（虽 headline 实际 ≤80，这里仅为构造超限场景），使总长超 MAX_MESSAGE_LENGTH。
    const long = 'x'.repeat(1500);
    const events = [
      ev('e1', { headlineZh: long }),
      ev('e2', { headlineZh: long }),
      ev('e3', { headlineZh: long }),
      ev('e4', { headlineZh: long }),
    ];
    const { includedIds, text } = buildDigestMessage(events);

    expect(text).toContain('未展示');
    expect(includedIds.length).toBeGreaterThan(0);
    expect(includedIds.length).toBeLessThan(events.length);
    expect(includedIds).toEqual(
      events.slice(0, includedIds.length).map((e) => e.eventId),
    );
    // 追加脚注后整条仍不超上限（脚注本身也必须可发送）。
    expect(text.length).toBeLessThanOrEqual(4000);
  });

  it('截断边界：块累加贴近上限时，追加脚注后整条仍 ≤ MAX_MESSAGE_LENGTH', () => {
    // 构造每块约 ~395 字，使前若干块累加逼近 4000；若脚注未计入预算会刚好越界。
    // 末尾留大量条数（剩余 N 三位数）使脚注尽量长，放大「脚注溢出」风险。
    const block = '甲'.repeat(390);
    const events = Array.from({ length: 200 }, (_, i) =>
      ev(`e${i}`, {
        representativeTitle: block,
        headlineZh: null,
        summaryZh: null,
        canonicalUrl: null,
      }),
    );
    const { text, includedIds } = buildDigestMessage(events);
    expect(text).toContain('未展示');
    expect(includedIds.length).toBeLessThan(events.length);
    expect(text.length).toBeLessThanOrEqual(4000);
  });
});

describe('escapeMarkdownV2Url（URL 专用转义）', () => {
  it('仅转义 ) 与 \\，不动 . - _ =', () => {
    const url = 'https://ex.com/path-to_thing.html?a=1&b=2#sec';
    const out = escapeMarkdownV2Url(url);
    // . - _ = 不被加反斜杠。
    expect(out).toBe(url);
  });

  it('转义 ) 与字面反斜杠', () => {
    const out = escapeMarkdownV2Url('https://ex.com/a)b\\c');
    expect(out).toBe('https://ex.com/a\\)b\\\\c');
  });
});

describe('buildDigestMessage 链接渲染（4.1）', () => {
  it('含特殊字符的 canonical_url 渲染为可点击链接：) \\ 被转义，. - _ = 未被加反斜杠', () => {
    const url = 'https://ex.com/p-a_t.h=1)x\\y';
    const events = [ev('e1', { canonicalUrl: url, representativeTitle: 'T' })];
    const { text } = buildDigestMessage(events);

    // URL 内 ) 与 \ 被转义。
    expect(text).toContain('\\)');
    expect(text).toContain('\\\\y');
    // URL 内 . - _ = 未被加反斜杠（出现原文片段）。
    expect(text).toContain('p-a_t.h=1');
    // 内联链接结构 [原文](...) 存在。
    expect(text).toMatch(/\[原文\]\(https:\/\/ex\.com\//);
  });

  it('链接文本（标题）经文本转义器转义（含保留字符的标题被加反斜杠）', () => {
    const events = [
      ev('e1', { representativeTitle: 'a.b-c', headlineZh: null, summaryZh: null, canonicalUrl: null }),
    ];
    const { text } = buildDigestMessage(events);
    // 标题里的 . 和 - 被文本转义器加反斜杠。
    expect(text).toContain('a\\.b\\-c');
  });
});

describe('buildDigestMessage headline 渲染与回退链（4.2）', () => {
  it('headline 存在：渲染 标题 + 要点 + 链接', () => {
    const events = [
      ev('e1', { representativeTitle: 'T', headlineZh: '一句话要点', canonicalUrl: 'https://ex.com/x' }),
    ];
    const { text } = buildDigestMessage(events);
    expect(text).toContain('*T*');
    expect(text).toContain('一句话要点');
    expect(text).toContain('[原文](https://ex.com/x)');
  });

  it('headline 缺失 → 回退 summary_zh 截断前 ~80 字', () => {
    const summary = '甲'.repeat(200);
    const events = [ev('e1', { headlineZh: null, summaryZh: summary })];
    const { text } = buildDigestMessage(events);
    // 含截断省略号，且未含完整 200 字。
    expect(text).toContain('…');
    expect(text).not.toContain('甲'.repeat(200));
    // 截断后 summary 片段出现（前若干字）。
    expect(text).toContain('甲'.repeat(50));
  });

  it('headline 与 summary 均缺失 → 仅标题无要点', () => {
    const events = [
      ev('e1', { representativeTitle: '只有标题', headlineZh: null, summaryZh: null, canonicalUrl: null }),
    ];
    const { text } = buildDigestMessage(events);
    expect(text).toContain('*只有标题*');
    // 标题块后无要点行（标题后直接是块边界，无额外正文行）。
    const block = text.split('\n\n').find((b) => b.includes('只有标题'))!;
    expect(block.split('\n')).toHaveLength(1);
  });

  it('canonical_url 超长（>2000）→ 丢弃链接仅标题+要点，单块仍可发、事件不丢', () => {
    // 超长 URL 是块内唯一无界来源；不丢弃则单块超限会使该事件卡住整条 digest（includedIds 为 0）。
    const hugeUrl = 'https://ex.com/' + 'a'.repeat(3000);
    const events = [
      ev('e1', { representativeTitle: 'T', headlineZh: '要点', canonicalUrl: hugeUrl }),
    ];
    const { text, includedIds } = buildDigestMessage(events);
    // 该事件仍被渲染（不因 URL 超长被丢）。
    expect(includedIds).toEqual(['e1']);
    expect(text).toContain('*T*');
    expect(text).toContain('要点');
    // 链接被丢弃（不出现 [原文] 内联链接），整条不超上限。
    expect(text).not.toContain('[原文]');
    expect(text.length).toBeLessThanOrEqual(4000);
  });

  it('canonical_url 缺失 → 仅标题+要点，不渲染链接', () => {
    const events = [
      ev('e1', { representativeTitle: 'T', headlineZh: '要点', canonicalUrl: null }),
    ];
    const { text } = buildDigestMessage(events);
    expect(text).toContain('要点');
    expect(text).not.toContain('[原文]');
  });
});

describe('buildDigestMessage 长度预算与标题截断（4.3）', () => {
  it('默认 TOP_N(8) 条典型长度拼一条不触发截断，includedIds == 全部', () => {
    const events = Array.from({ length: 8 }, (_, i) =>
      ev(`e${i}`, {
        representativeTitle: `典型标题 ${i} ` + '词'.repeat(40), // 远低于 TITLE_MAX=120
        headlineZh: '一句话要点：主体+动作+影响，' + '述'.repeat(30), // 远低于 HEADLINE_MAX=80
        canonicalUrl: `https://example.com/article/${i}?id=${i}`,
      }),
    );
    const { includedIds, text } = buildDigestMessage(events);
    expect(includedIds).toEqual(events.map((e) => e.eventId));
    expect(text).not.toContain('未展示');
    expect(text.length).toBeLessThanOrEqual(4000);
  });

  it('超长原始标题在渲染期(转义前、按 code point)被截断、整条仍不超限', () => {
    // 200 个 emoji（每个多 code point）+ 长 CJK，验证按 code point 截断不截半。
    const longTitle = '🚀'.repeat(150) + '超长标题'.repeat(50);
    const events = [ev('e1', { representativeTitle: longTitle, headlineZh: '要点', canonicalUrl: null })];
    const { text, includedIds } = buildDigestMessage(events);
    // 仍发出该条（截断后短，不触发整条丢弃）。
    expect(includedIds).toEqual(['e1']);
    expect(text).toContain('…');
    expect(text.length).toBeLessThanOrEqual(4000);
    // 截断后标题 code point 数（含省略号）不超 TITLE_MAX=120：消息里不应出现 150 个连续 🚀。
    expect(text).not.toContain('🚀'.repeat(150));
    // 但应保留前缀若干 🚀（未被 .slice 截半成乱码）。
    expect(text).toContain('🚀'.repeat(50));
  });
});
