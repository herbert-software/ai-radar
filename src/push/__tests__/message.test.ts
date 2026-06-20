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
import {
  buildDigestMessage,
  buildFeishuCard,
  escapeMarkdownV2Url,
  renderDigest,
  type FeishuCard,
} from '../message.js';

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

describe('renderDigest 按 channel 分派（两层渲染，4.4）', () => {
  it("channel='telegram' 复用 buildDigestMessage、MarkdownV2 渲染与 includedIds 不变", () => {
    const events = [ev('e1'), ev('e2'), ev('e3')];
    const rendered = renderDigest(events, 'telegram');
    const direct = buildDigestMessage(events);

    expect(rendered.channel).toBe('telegram');
    expect(rendered.parseMode).toBe('MarkdownV2');
    // 与直接调 buildDigestMessage 完全等价（既有 Telegram 渲染/截断不变量原样保留）。
    expect(rendered.text).toBe(direct.text);
    expect(rendered.includedIds).toEqual(direct.includedIds);
  });

  it("channel='feishu' 渲染为飞书 JSON 卡片（含 includedIds，与 buildFeishuCard 等价）", () => {
    const events = [ev('e1'), ev('e2')];
    const rendered = renderDigest(events, 'feishu');
    expect(rendered.channel).toBe('feishu');
    if (rendered.channel !== 'feishu') throw new Error('unreachable');
    const direct = buildFeishuCard(events);
    expect(rendered.text).toBe(direct.text);
    expect(rendered.includedIds).toEqual(direct.includedIds);
    // text 是卡片 payload 的 JSON 序列化串，可解析回 { card }。
    const parsed = JSON.parse(rendered.text) as { card: FeishuCard };
    expect(parsed.card.elements.length).toBe(2);
  });
});

describe("renderDigest targetType='experience' 实践锦囊渲染（组 E 5.1）", () => {
  /** 经验卡片视图：representativeTitle 承载 headline_zh、summaryZh 承载摘要正文（组 D 映射口径）。 */
  function exp(id: string, overrides: Partial<SelectedEvent> = {}): SelectedEvent {
    return {
      eventId: id,
      representativeTitle: `要点-${id}`,
      summaryZh: `摘要正文-${id}`,
      headlineZh: `要点-${id}`,
      canonicalUrl: 'https://blogger.example.com/a',
      publishedAt: null,
      rankScore: 90,
      ...overrides,
    };
  }

  it('telegram：标题=headline_zh、要点行=summary_zh（显式渲染，不被回退链屏蔽）+ 实践锦囊表头 + 来源链接', () => {
    const events = [exp('x1'), exp('x2')];
    const rendered = renderDigest(events, 'telegram', 'experience');
    expect(rendered.channel).toBe('telegram');
    expect(rendered.includedIds).toEqual(['x1', 'x2']);
    // 实践锦囊专属表头（非「每日情报」）。
    expect(rendered.text).toContain('AI Radar 实践锦囊');
    // 标题=headline_zh（representativeTitle 承载），要点行=summary_zh 显式渲染（关键：summary 不被屏蔽）。
    // MarkdownV2 转义会把 `-` 转 `\-`，故断言转义后形态。
    expect(rendered.text).toContain('要点\\-x1');
    expect(rendered.text).toContain('摘要正文\\-x1');
    // 来源链接（experience 用「来源」而非「原文」；URL 段不转义 `-`）。
    expect(rendered.text).toContain('[来源](https://blogger.example.com/a)');
    // 与要闻段渲染分流：不出现「每日情报」表头。
    expect(rendered.text).not.toContain('AI Radar 每日情报');
  });

  it('feishu：每条经验渲染为 div(lark_md)，含 summary_zh 正文 + 来源文字链，表头为实践锦囊', () => {
    const events = [exp('y1')];
    const rendered = renderDigest(events, 'feishu', 'experience');
    expect(rendered.channel).toBe('feishu');
    if (rendered.channel !== 'feishu') throw new Error('unreachable');
    expect(rendered.includedIds).toEqual(['y1']);
    const parsed = JSON.parse(rendered.text) as { card: FeishuCard };
    expect(parsed.card.header.title.content).toContain('AI Radar 实践锦囊');
    const el = parsed.card.elements[0] as { text: { content: string } };
    expect(el.text.content).toContain('要点-y1'); // 标题=headline_zh。
    expect(el.text.content).toContain('摘要正文-y1'); // 摘要正文显式渲染。
    expect(el.text.content).toContain('[来源](https://blogger.example.com/a)');
  });

  it('summary_zh 缺失 → 仅渲染要点+来源（不报错、不渲染空要点行）', () => {
    const events = [exp('z1', { summaryZh: null })];
    const rendered = renderDigest(events, 'telegram', 'experience');
    expect(rendered.includedIds).toEqual(['z1']);
    expect(rendered.text).toContain('要点\\-z1'); // MarkdownV2 转义后形态。
    expect(rendered.text).toContain('[来源]');
    // summary 缺失：不渲染空摘要行（仅表头 + 序号标题 + 来源）。
    expect(rendered.text).not.toContain('摘要正文');
  });

  it("默认 targetType（缺省）仍走要闻段渲染（向后兼容：renderDigest 两参不变）", () => {
    const events = [ev('e1')];
    const rendered = renderDigest(events, 'telegram');
    expect(rendered.text).toContain('AI Radar 每日情报');
    expect(rendered.text).not.toContain('实践锦囊');
  });
});

describe('buildFeishuCard 飞书 JSON 卡片渲染（5.2 / 5.6）', () => {
  it('每条事件渲染为一个 div(lark_md)：标题 + 要点 + 文字链跳转（不依赖回调）', () => {
    const events = [
      ev('e1', {
        representativeTitle: '飞书标题',
        headlineZh: '一句话要点',
        canonicalUrl: 'https://example.com/article/1?id=1',
      }),
    ];
    const { card, includedIds } = buildFeishuCard(events);
    expect(includedIds).toEqual(['e1']);
    expect(card.header.title.content).toContain('AI Radar 每日情报');
    expect(card.header.title.content).toContain('(1)');
    expect(card.elements).toHaveLength(1);
    const el = card.elements[0] as { tag: string; text: { tag: string; content: string } };
    expect(el.tag).toBe('div');
    expect(el.text.tag).toBe('lark_md');
    expect(el.text.content).toContain('飞书标题');
    expect(el.text.content).toContain('一句话要点');
    // 文字链跳转：lark_md 内联链接 [原文](url)，不含任何回调/action 字段。
    expect(el.text.content).toContain('[原文](https://example.com/article/1?id=1)');
    // 整张卡片序列化里不出现任何回调相关字段（card_link/action callback 等）。
    const json = JSON.stringify(card);
    expect(json).not.toContain('callback');
  });

  it('headline 缺失走回退链（summary 截断）；canonical_url 缺失则不渲染链接行', () => {
    const summary = '甲'.repeat(200);
    const events = [
      ev('e1', { headlineZh: null, summaryZh: summary, canonicalUrl: null }),
    ];
    const { card } = buildFeishuCard(events);
    const el = card.elements[0] as { text: { content: string } };
    // summary 截断（含省略号），无 200 连续甲。
    expect(el.text.content).toContain('…');
    expect(el.text.content).not.toContain('甲'.repeat(200));
    // 无链接行。
    expect(el.text.content).not.toContain('[原文]');
  });

  it('标题含 markdown 语法字符被转义（不误当链接语法破坏卡片）', () => {
    const events = [
      ev('e1', { representativeTitle: 'a[b](c)d', headlineZh: null, summaryZh: null, canonicalUrl: null }),
    ];
    const { card } = buildFeishuCard(events);
    const el = card.elements[0] as { text: { content: string } };
    // [ ] ( ) 被加反斜杠转义。
    expect(el.text.content).toContain('a\\[b\\]\\(c\\)d');
  });

  it('超长标题按 code point 截断（不截半 emoji），整卡片仍可发', () => {
    const longTitle = '🚀'.repeat(150) + '超长'.repeat(50);
    const events = [ev('e1', { representativeTitle: longTitle, headlineZh: '要点', canonicalUrl: null })];
    const { card } = buildFeishuCard(events);
    const el = card.elements[0] as { text: { content: string } };
    expect(el.text.content).toContain('…');
    expect(el.text.content).not.toContain('🚀'.repeat(150));
    expect(el.text.content).toContain('🚀'.repeat(50));
  });

  it('canonical_url 超长（>2000）→ 丢弃链接仅标题+要点（不撑爆卡片）', () => {
    const hugeUrl = 'https://ex.com/' + 'a'.repeat(3000);
    const events = [ev('e1', { representativeTitle: 'T', headlineZh: '要点', canonicalUrl: hugeUrl })];
    const { card, includedIds } = buildFeishuCard(events);
    expect(includedIds).toEqual(['e1']);
    const el = card.elements[0] as { text: { content: string } };
    expect(el.text.content).not.toContain('[原文]');
  });
});
