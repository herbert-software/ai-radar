/**
 * renderDailyDigest 单测（merge-products-into-daily-digest，design D3，tasks 7.1）。
 *
 * 一条「AI Radar 每日情报」=「要闻段（events）+ 新品段（products）」。本套件验证双段渲染契约：
 * - 要闻 + 新品两段都在；产品行带链接；canonicalUrl=null 降级纯名；产品无要点行。
 * - 某段空只渲染非空段；两段皆空（仍按契约渲染表头，dispatch 层才 skip）。
 * - 表头计数取**实发数**（eventIncludedIds.length / productIncludedIds.length），非入参 pending 长度。
 * - 截断时分段 includedIds 正确：被截断产品不进 productIncludedIds；按块累加语义（非整份截断）；
 *   首块恒可装 → eventIncludedIds ≥ 1。
 * - 产品段单块恒可装（产品名套 TITLE_MAX 截断 + 链接超长丢链接兜底）→ 要闻段空时 productIncludedIds ≥ 1。
 * - 长度上限 / 转义（telegram MarkdownV2 + feishu lark_md 卡片）。
 *
 * 纯函数，不触 DB/Redis/网络。
 */
import { describe, expect, it } from 'vitest';
import type { SelectedEvent } from '../../selection/top-n.js';
import { renderDailyDigest, type FeishuCard } from '../message.js';
import { PRODUCT_TAGLINE_MAX } from '../../agents/product-digest/schema.js';

const MAX = 4000;

/**
 * 造一个要闻段事件（默认带要点 + 链接）。
 * 标题/要点用纯 CJK（无 MarkdownV2 保留字符），使断言可直接匹配原文不必处理转义；
 * 转义行为由专门用例覆盖。
 */
function ev(id: string, overrides: Partial<SelectedEvent> = {}): SelectedEvent {
  return {
    eventId: id,
    representativeTitle: `事件标题${id}`,
    summaryZh: null,
    headlineZh: `事件要点${id}`,
    canonicalUrl: 'https://example.com/news',
    publishedAt: null,
    rankScore: 0,
    ...overrides,
  };
}

/**
 * 造一个新品段产品（候选视图：eventId=product_id、representativeTitle=产品名、headline/summary 恒 null）。
 * 默认带 canonicalUrl（= https://canonical_domain），可覆盖为 null 验降级纯名。
 * 产品名用纯 CJK（无保留字符）便于断言；链接 host 用无 `-` 段（`prodX` 而非 `prod-X`）。
 */
function prod(id: string, overrides: Partial<SelectedEvent> = {}): SelectedEvent {
  return {
    eventId: id,
    representativeTitle: `产品名${id}`,
    summaryZh: null,
    headlineZh: null,
    canonicalUrl: `https://prod${id}.example.com`,
    publishedAt: null,
    rankScore: 0,
    ...overrides,
  };
}

/** 解析 feishu 渲染产物的 text（{ card } JSON 串）回卡片对象，并拼接所有 div 内容供断言。 */
function parseFeishu(text: string): { card: FeishuCard; allContent: string } {
  const parsed = JSON.parse(text) as { card: FeishuCard };
  const allContent = parsed.card.elements
    .map((e) => (e as { text?: { content?: string } }).text?.content ?? '')
    .join('\n');
  return { card: parsed.card, allContent };
}

describe('renderDailyDigest telegram 双段渲染（7.1）', () => {
  it('要闻 + 新品两段都在：要闻渲染要点 + 原文链接；产品渲染产品名 + 官网链接', () => {
    const events = [ev('e1'), ev('e2')];
    const products = [prod('p1'), prod('p2')];
    const r = renderDailyDigest(events, products, 'telegram');

    expect(r.parseMode).toBe('MarkdownV2');
    // 两段 includedIds 各自含全部入参（未截断）。
    expect(r.eventIncludedIds).toEqual(['e1', 'e2']);
    expect(r.productIncludedIds).toEqual(['p1', 'p2']);

    // 表头：实发数（要闻 2·新品 2）。MarkdownV2 转义后 `（` `·` `）` 等仍保留为可见字符。
    expect(r.text).toContain('AI Radar 每日情报');
    expect(r.text).toContain('要闻 2');
    expect(r.text).toContain('新品 2');
    // 段标题。
    expect(r.text).toContain('要闻');
    expect(r.text).toContain('新品');
    // 要闻段：要点 + 原文链接。
    expect(r.text).toContain('事件要点e1');
    expect(r.text).toMatch(/\[原文\]\(https:\/\/example\.com\/news\)/);
    // 新品段：产品名 + 官网链接（[官网]，与 [原文] 区分）。
    expect(r.text).toContain('产品名p1');
    expect(r.text).toMatch(/\[官网\]\(https:\/\/prodp1\.example\.com\)/);

    expect(r.text.length).toBeLessThanOrEqual(MAX);
  });

  it('产品行 canonicalUrl=null → 降级纯产品名（不渲染官网链接，不渲染坏链接）', () => {
    const r = renderDailyDigest([], [prod('p1', { canonicalUrl: null })], 'telegram');
    expect(r.productIncludedIds).toEqual(['p1']);
    expect(r.text).toContain('产品名p1');
    expect(r.text).not.toContain('[官网]');
  });

  it('产品段无要点行（headline/summary 均 null → 产品块仅产品名 + 可选链接，零 LLM）', () => {
    const r = renderDailyDigest([], [prod('p1', { canonicalUrl: null })], 'telegram');
    // 产品块只有产品名一行（无要点行）。块以 `\n\n` 分隔，找含产品名的块。
    const block = r.text.split('\n\n').find((b) => b.includes('产品名p1'))!;
    expect(block.split('\n')).toHaveLength(1); // 仅产品名一行，无要点行。
  });

  it('某段空只渲染非空段：要闻非空 + 产品空 → 仅要闻段、productIncludedIds 空', () => {
    const r = renderDailyDigest([ev('e1')], [], 'telegram');
    expect(r.eventIncludedIds).toEqual(['e1']);
    expect(r.productIncludedIds).toEqual([]);
    expect(r.text).toContain('事件标题e1');
    // 表头新品计数为 0。
    expect(r.text).toContain('要闻 1');
    expect(r.text).toContain('新品 0');
  });

  it('某段空只渲染非空段：要闻空 + 产品非空 → 仅新品段、eventIncludedIds 空', () => {
    const r = renderDailyDigest([], [prod('p1')], 'telegram');
    expect(r.eventIncludedIds).toEqual([]);
    expect(r.productIncludedIds).toEqual(['p1']);
    expect(r.text).toContain('产品名p1');
    expect(r.text).toContain('要闻 0');
    expect(r.text).toContain('新品 1');
  });

  it('两段皆空：仍按契约渲染（两段 includedIds 皆空，表头要闻 0·新品 0）；dispatch 层负责 skip', () => {
    const r = renderDailyDigest([], [], 'telegram');
    expect(r.eventIncludedIds).toEqual([]);
    expect(r.productIncludedIds).toEqual([]);
    expect(r.text).toContain('要闻 0');
    expect(r.text).toContain('新品 0');
  });

  it('表头计数取实发数（截断后表头计数 = 实发数，非入参 pending 长度）', () => {
    // 撑爆手段：堆足够多要闻块（每块 title 近 TITLE_MAX、headline 近 HEADLINE_MAX，均不被截，
    // 块内有界但累加超 MAX_MESSAGE_LENGTH），使要闻段部分截断（实发 < 入参）。表头计数必须等于
    // 实发的 includedIds 长度，而非入参 pending 长度。
    const nearTitle = '甲'.repeat(115); // < TITLE_MAX(120)，不被截。
    const nearHeadline = '乙'.repeat(78); // < HEADLINE_MAX(80)，不被截。
    const events = Array.from({ length: 30 }, (_, i) =>
      ev(`e${i}`, { representativeTitle: nearTitle, headlineZh: nearHeadline }),
    );
    const products = [prod('p1'), prod('p2')];
    const r = renderDailyDigest(events, products, 'telegram');

    // 要闻段被截断（实发 < 6）。
    expect(r.eventIncludedIds.length).toBeGreaterThan(0);
    expect(r.eventIncludedIds.length).toBeLessThan(events.length);
    // 表头计数 = 实发数。
    expect(r.text).toContain(`要闻 ${r.eventIncludedIds.length}`);
    expect(r.text).toContain(`新品 ${r.productIncludedIds.length}`);
    expect(r.text.length).toBeLessThanOrEqual(MAX);
  });

  it('截断按块累加语义（非整份截断）：被顺延的产品不进 productIncludedIds，要闻段优先', () => {
    // 要闻段占满预算 → 新品段被整段顺延（productIncludedIds 空），但要闻段保留实发的前缀。
    // 撑爆手段：堆足够多要闻块（title/headline 近上限、不被截）把要闻段填到逼近 MAX_MESSAGE_LENGTH，
    // 残余预算极小；产品块各带近 MAX_URL_LENGTH(2000) 的合法长 URL（≤2000 故被渲染、块约 2000 字），
    // 残余装不下任一产品块 → 新品段整段顺延。
    const nearTitle = '甲'.repeat(115);
    const nearHeadline = '乙'.repeat(78);
    const events = Array.from({ length: 30 }, (_, i) =>
      ev(`e${i}`, { representativeTitle: nearTitle, headlineZh: nearHeadline }),
    );
    const bigUrl = 'https://prod.example.com/' + 'a'.repeat(1900); // ≤ MAX_URL_LENGTH=2000，被渲染。
    const products = [
      prod('q1', { canonicalUrl: bigUrl }),
      prod('q2', { canonicalUrl: bigUrl }),
      prod('q3', { canonicalUrl: bigUrl }),
    ];
    const r = renderDailyDigest(events, products, 'telegram');

    // 要闻段优先占预算：实发要闻 ≥ 1，且被截断（< 6）。
    expect(r.eventIncludedIds.length).toBeGreaterThanOrEqual(1);
    expect(r.eventIncludedIds.length).toBeLessThan(events.length);
    // 新品段被顺延：productIncludedIds 是 products 前缀（可能为空），绝不含未拼进消息的产品。
    expect(r.productIncludedIds).toEqual(
      products.slice(0, r.productIncludedIds.length).map((p) => p.eventId),
    );
    // 被顺延的产品名不出现在消息正文里（截断点不渲染该块）。
    for (const p of products.slice(r.productIncludedIds.length)) {
      expect(r.text).not.toContain(p.representativeTitle!);
    }
    expect(r.text.length).toBeLessThanOrEqual(MAX);
  });

  it('首块恒可装：要闻段首块单块有界（超长标题/要点/URL）→ eventIncludedIds ≥ 1', () => {
    // 单块内所有无界来源都被有界化：标题套 TITLE_MAX、要点套上限、URL 超长丢弃。
    const hugeTitle = '🚀'.repeat(500);
    const hugeUrl = 'https://ex.com/' + 'a'.repeat(5000);
    const events = [
      ev('e1', { representativeTitle: hugeTitle, headlineZh: '要点', canonicalUrl: hugeUrl }),
    ];
    const r = renderDailyDigest(events, [], 'telegram');
    // 首块恒可装：至少发出一条要闻（否则非空 pending 渲染 0 条会让 dispatch 抛错卡死）。
    expect(r.eventIncludedIds).toEqual(['e1']);
    // 超长 URL 被丢弃（不渲染原文链接），整条仍不超上限。
    expect(r.text).not.toContain('[原文]');
    expect(r.text.length).toBeLessThanOrEqual(MAX);
  });

  it('产品段单块恒可装（产品名套 TITLE_MAX 截断 + 链接超长丢链接兜底）→ 要闻段空时 productIncludedIds ≥ 1', () => {
    const hugeName = '✨'.repeat(500); // 产品名套 TITLE_MAX 截断有界。
    const hugeUrl = 'https://prod.example.com/' + 'b'.repeat(5000); // 超长链接丢弃。
    const products = [
      prod('p1', { representativeTitle: hugeName, canonicalUrl: hugeUrl }),
    ];
    // 要闻段空 → 产品段成首段，其首块仍恒可装（不触发「非空 pending 渲染 0 条」卡死）。
    const r = renderDailyDigest([], products, 'telegram');
    expect(r.eventIncludedIds).toEqual([]);
    expect(r.productIncludedIds).toEqual(['p1']);
    // 产品名按 code point 截断（含省略号），不出现 500 连续 ✨。
    expect(r.text).toContain('…');
    expect(r.text).not.toContain('✨'.repeat(500));
    // 超长链接丢弃（不渲染官网链接）。
    expect(r.text).not.toContain('[官网]');
    expect(r.text.length).toBeLessThanOrEqual(MAX);
  });

  it('转义：产品名/要点里的 MarkdownV2 保留字符被转义（不破坏渲染/发送）', () => {
    const r = renderDailyDigest(
      [ev('e1', { representativeTitle: 'a.b-c', headlineZh: null, canonicalUrl: null })],
      [prod('p1', { representativeTitle: 'x_y.z', canonicalUrl: null })],
      'telegram',
    );
    // . - _ 被文本转义器加反斜杠。
    expect(r.text).toContain('a\\.b\\-c');
    expect(r.text).toContain('x\\_y\\.z');
  });

  it('链接 URL 用专用转义器：) \\ 转义，. - _ = 不被加反斜杠', () => {
    const url = 'https://ex.com/p-a_t.h=1)x\\y';
    const r = renderDailyDigest([], [prod('p1', { canonicalUrl: url })], 'telegram');
    expect(r.text).toContain('\\)'); // ) 被转义。
    expect(r.text).toContain('\\\\y'); // \ 被转义。
    expect(r.text).toContain('p-a_t.h=1'); // . - _ = 原样保留。
  });
});

describe('renderDailyDigest feishu 双段渲染（7.1）', () => {
  it('要闻 + 新品两段都在：卡片表头计数取实发数；各段 div 列表，文字链跳转不依赖回调', () => {
    const events = [ev('e1'), ev('e2')];
    const products = [prod('p1')];
    const r = renderDailyDigest(events, products, 'feishu');
    expect(r.eventIncludedIds).toEqual(['e1', 'e2']);
    expect(r.productIncludedIds).toEqual(['p1']);

    const { card, allContent } = parseFeishu(r.text);
    // 表头计数取实发数。
    expect(card.header.title.content).toContain('AI Radar 每日情报');
    expect(card.header.title.content).toContain('要闻 2');
    expect(card.header.title.content).toContain('新品 1');
    // 两段内容都在。
    expect(allContent).toContain('要闻');
    expect(allContent).toContain('新品');
    expect(allContent).toContain('事件标题e1');
    expect(allContent).toContain('产品名p1');
    // 产品官网文字链跳转（[官网](url)），不含回调字段。
    expect(allContent).toContain('[官网](https://prodp1.example.com)');
    expect(JSON.stringify(card)).not.toContain('callback');
    expect(r.text.length).toBeLessThanOrEqual(MAX);
  });

  it('产品 canonicalUrl=null → 仅产品名（无官网链接行）；产品段无要点行', () => {
    const r = renderDailyDigest([], [prod('p1', { canonicalUrl: null })], 'feishu');
    expect(r.productIncludedIds).toEqual(['p1']);
    const { allContent } = parseFeishu(r.text);
    expect(allContent).toContain('产品名p1');
    expect(allContent).not.toContain('[官网]');
  });

  it('某段空只渲染非空段（feishu）：要闻空 + 产品非空 → 仅新品段，productIncludedIds ≥ 1', () => {
    const r = renderDailyDigest([], [prod('p1')], 'feishu');
    expect(r.eventIncludedIds).toEqual([]);
    expect(r.productIncludedIds).toEqual(['p1']);
    const { card } = parseFeishu(r.text);
    expect(card.header.title.content).toContain('要闻 0');
    expect(card.header.title.content).toContain('新品 1');
  });

  it('产品名含 lark_md 语法字符被转义（不误当链接语法破坏卡片）', () => {
    const r = renderDailyDigest([], [prod('p1', { representativeTitle: 'a[b](c)d', canonicalUrl: null })], 'feishu');
    const { allContent } = parseFeishu(r.text);
    expect(allContent).toContain('a\\[b\\]\\(c\\)d');
  });

  it('块数边界：内容块逼近上限时，elements（含两段标题 div）≤ FEISHU_MAX_BLOCKS(50) 且 text ≤ MAX(4000)，被挤出的不进 includedIds', () => {
    // 构造大量极小内容块（无要点行、无链接 → 单块序列化最短），使两段块数合计远超 50：
    // 内容块若全收（60+5=65）+ 两段标题 div = 67 元素，必触发块数闸；用极小块隔离块数闸（不先触长度闸）。
    const tiny = (id: string) =>
      ev(id, { headlineZh: null, summaryZh: null, canonicalUrl: null, representativeTitle: `事件${id}` });
    const tinyProd = (id: string) =>
      prod(id, { canonicalUrl: null, representativeTitle: `品${id}` });
    const events = Array.from({ length: 60 }, (_, i) => tiny(`e${i}`));
    const products = Array.from({ length: 5 }, (_, i) => tinyProd(`p${i}`));
    const r = renderDailyDigest(events, products, 'feishu');

    const { card } = parseFeishu(r.text);
    // 关键：最终 elements（含「要闻」「新品」两段标题 div）不超 FEISHU_MAX_BLOCKS。
    expect(card.elements.length).toBeLessThanOrEqual(50);
    // 关键：计入段标题 div + elements 间逗号后，序列化 text 仍不超 MAX_MESSAGE_LENGTH。
    expect(r.text.length).toBeLessThanOrEqual(MAX);

    // 被块数闸挤出的不进 includedIds（要闻段优先占满 → 要闻被截断、新品整段顺延）。
    expect(r.eventIncludedIds.length).toBeLessThan(events.length);
    expect(r.eventIncludedIds).toEqual(
      events.slice(0, r.eventIncludedIds.length).map((e) => e.eventId),
    );
    expect(r.productIncludedIds).toEqual(
      products.slice(0, r.productIncludedIds.length).map((p) => p.eventId),
    );
    // 内容块数 = elements 数 − 实际渲染的段标题 div 数（每个非空段 1 个）。
    const headingDivs =
      (r.eventIncludedIds.length > 0 ? 1 : 0) + (r.productIncludedIds.length > 0 ? 1 : 0);
    expect(card.elements.length).toBe(
      r.eventIncludedIds.length + r.productIncludedIds.length + headingDivs,
    );
    // 表头计数取实发数。
    expect(card.header.title.content).toContain(`要闻 ${r.eventIncludedIds.length}`);
    expect(card.header.title.content).toContain(`新品 ${r.productIncludedIds.length}`);
  });

  it('长度闸边界：近上限块逼近 MAX(4000) 时长度闸先于块数闸绑定——elements 远 <50、text 逼近 4000 仍 ≤MAX，被挤出的不进 includedIds', () => {
    // 与「块数边界」用例互补：那条用极小块触发块数闸（elements>50）、长度闸不绑定（text 距上限有大余量），
    // 致其 `text ≤ MAX` 断言 vacuous（删长度判据全绿）。本条反过来——构造近上限块使**长度闸**成为绑定约束：
    // title='甲'×115（≤TITLE_MAX=120 不截）+ headlineZh='乙'×78（≤HEADLINE_MAX=80 不截、daily 块内本地截断不改长度）+ 正常 URL，
    // 每块序列化约 280+ 字 → 累加约 13 块即逼近 4000，此时 elements≈14 远 <50（块数闸不绑定）。
    // 删 buildDailyFeishuCard fits() 的长度判据后只剩块数闸 → 会一路收到 elements≤50，text 撑到约 8000 远超 MAX、
    // 且 includedIds 全收 → 下方 ②④ 断言变红，锁住长度闸（本轮飞书修复的长度维度）。
    const nearTitle = '甲'.repeat(115); // < TITLE_MAX(120)，不被截。
    const nearHeadline = '乙'.repeat(78); // < HEADLINE_MAX(80)，不被截、不被块内本地截断改变长度。
    const events = Array.from({ length: 28 }, (_, i) =>
      ev(`e${i}`, { representativeTitle: nearTitle, headlineZh: nearHeadline }),
    );
    const r = renderDailyDigest(events, [], 'feishu');

    const { card } = parseFeishu(r.text);
    // ① 块数闸不绑定：elements（含「要闻」段标题 div）远 < FEISHU_MAX_BLOCKS(50)。
    expect(card.elements.length).toBeLessThanOrEqual(50);
    // ② 长度闸守护：序列化 text ≤ MAX_MESSAGE_LENGTH(4000)。
    expect(r.text.length).toBeLessThanOrEqual(MAX);
    // ③ 长度闸（非块数闸）绑定：text 逼近上限（> 3500），与块数闸用例区分。
    expect(r.text.length).toBeGreaterThan(3500);
    // ④ 真截断：被长度闸挤出的 event 不进 includedIds（实发 < 输入数），且为输入前缀。
    expect(r.eventIncludedIds.length).toBeLessThan(events.length);
    expect(r.eventIncludedIds).toEqual(
      events.slice(0, r.eventIncludedIds.length).map((e) => e.eventId),
    );
  });

  it('feishu 产品段单块恒可装：超长产品名截断 + 超长链接丢弃，整卡片仍可发', () => {
    const hugeName = '✨'.repeat(500);
    const hugeUrl = 'https://prod.example.com/' + 'b'.repeat(5000);
    const r = renderDailyDigest([], [prod('p1', { representativeTitle: hugeName, canonicalUrl: hugeUrl })], 'feishu');
    expect(r.productIncludedIds).toEqual(['p1']);
    const { allContent } = parseFeishu(r.text);
    expect(allContent).toContain('…');
    expect(allContent).not.toContain('✨'.repeat(500));
    expect(allContent).not.toContain('[官网]');
    expect(r.text.length).toBeLessThanOrEqual(MAX);
  });
});

/**
 * 产品段中文简介要点行渲染（add-product-chinese-digest，design D5，task 8.4）。
 *
 * 中文化后产品在候选映射里 representativeTitle=name_zh、headlineZh=tagline_zh（选品映射的语境复用）。
 * 渲染契约：headlineZh（=tagline_zh）存在则在产品名下渲染一行简介、不存在则纯标题（回退现状）；
 * 简介行套 **PRODUCT_TAGLINE_MAX（100）** code-point 截断 —— **非 events HEADLINE_MAX（80）**，
 * 否则 schema 允许 100 字却渲染截到 80 = 静默丢字；中文名/简介里的语法字符须正确转义。
 */
describe('renderDailyDigest 产品段中文简介要点行（telegram，8.4）', () => {
  it('有 tagline_zh（headlineZh 承载）→ 产品块渲染要点行（产品名 + 简介两行）', () => {
    const r = renderDailyDigest(
      [],
      [prod('p1', { representativeTitle: '中文产品名', headlineZh: '一句话中文简介', canonicalUrl: null })],
      'telegram',
    );
    expect(r.productIncludedIds).toEqual(['p1']);
    expect(r.text).toContain('中文产品名');
    expect(r.text).toContain('一句话中文简介');
    // 产品块（以 \n\n 分隔）含产品名 + 简介两行（无链接）。
    const block = r.text.split('\n\n').find((b) => b.includes('中文产品名'))!;
    expect(block.split('\n')).toHaveLength(2); // 标题行 + 简介要点行。
  });

  it('无 tagline_zh（headlineZh=null）→ 产品块纯标题（无要点行，回退现状）', () => {
    const r = renderDailyDigest(
      [],
      [prod('p1', { representativeTitle: '中文产品名', headlineZh: null, canonicalUrl: null })],
      'telegram',
    );
    const block = r.text.split('\n\n').find((b) => b.includes('中文产品名'))!;
    expect(block.split('\n')).toHaveLength(1); // 仅产品名一行。
  });

  it('简介行套 PRODUCT_TAGLINE_MAX（100）截断，非 events HEADLINE_MAX（80）——80<len≤100 不被截', () => {
    // 长度 90：> HEADLINE_MAX(80) 但 < PRODUCT_TAGLINE_MAX(100)。若误用 HEADLINE_MAX 会截成 80 + …（静默丢字）。
    const tagline90 = '简'.repeat(90);
    const r = renderDailyDigest(
      [],
      [prod('p1', { representativeTitle: '产品', headlineZh: tagline90, canonicalUrl: null })],
      'telegram',
    );
    // 90 字全渲染、无省略号截断标记（产品简介专属上限是 100，不被 80 截）。
    expect(r.text).toContain(tagline90);
    const block = r.text.split('\n\n').find((b) => b.includes('产品'))!;
    expect(block).not.toContain('…');
  });

  it('简介行超 PRODUCT_TAGLINE_MAX（>100）→ 按 100 code-point 截断（含省略号）', () => {
    const tagline150 = '介'.repeat(150);
    const r = renderDailyDigest(
      [],
      [prod('p1', { representativeTitle: '产品', headlineZh: tagline150, canonicalUrl: null })],
      'telegram',
    );
    expect(r.text).not.toContain(tagline150); // 不整段渲染。
    expect(r.text).toContain('…'); // 截断省略号。
    expect(r.text.length).toBeLessThanOrEqual(MAX);
  });

  it('中文名 / 简介里的 MarkdownV2 保留字符被转义（不破坏渲染/发送）', () => {
    const r = renderDailyDigest(
      [],
      [prod('p1', { representativeTitle: '名_a.b', headlineZh: '简-介.x', canonicalUrl: null })],
      'telegram',
    );
    expect(r.text).toContain('名\\_a\\.b'); // 产品名转义。
    expect(r.text).toContain('简\\-介\\.x'); // 简介转义。
  });
});

describe('renderDailyDigest 产品段中文简介要点行（feishu，8.4）', () => {
  it('有 tagline_zh → 飞书产品块加简介行；无则纯标题', () => {
    const withTag = renderDailyDigest(
      [],
      [prod('p1', { representativeTitle: '中文产品名', headlineZh: '飞书中文简介', canonicalUrl: null })],
      'feishu',
    );
    const a = parseFeishu(withTag.text);
    expect(a.allContent).toContain('中文产品名');
    expect(a.allContent).toContain('飞书中文简介');

    const noTag = renderDailyDigest(
      [],
      [prod('p2', { representativeTitle: '无简介产品', headlineZh: null, canonicalUrl: null })],
      'feishu',
    );
    const b = parseFeishu(noTag.text);
    expect(b.allContent).toContain('无简介产品');
    // 该产品块（** 标题 ** 起首）内不含额外简介行——以产品块文本只一行标题判定。
    const prodEl = (parseFeishu(noTag.text).card.elements as Array<{ text?: { content?: string } }>)
      .map((e) => e.text?.content ?? '')
      .find((c) => c.includes('无简介产品'))!;
    expect(prodEl.split('\n')).toHaveLength(1);
  });

  it('飞书简介行同 PRODUCT_TAGLINE_MAX（100）截断口径，与 Telegram 一致——80<len≤100 不被截', () => {
    const tagline90 = '简'.repeat(90);
    const r = renderDailyDigest(
      [],
      [prod('p1', { representativeTitle: '产品', headlineZh: tagline90, canonicalUrl: null })],
      'feishu',
    );
    const { allContent } = parseFeishu(r.text);
    expect(allContent).toContain(tagline90); // 90 字全渲染、不被 80 截。
  });

  it('飞书中文名含 lark_md 语法字符被转义（不误当链接语法破坏卡片）', () => {
    const r = renderDailyDigest(
      [],
      [prod('p1', { representativeTitle: '名[a](b)', headlineZh: '简介x', canonicalUrl: null })],
      'feishu',
    );
    const { allContent } = parseFeishu(r.text);
    expect(allContent).toContain('名\\[a\\]\\(b\\)');
  });

  // PRODUCT_TAGLINE_MAX 是 schema cap 与渲染 cap 的单一来源常量（design D5），固定 100。
  it('PRODUCT_TAGLINE_MAX 常量为 100（schema cap = 渲染 cap 单一来源）', () => {
    expect(PRODUCT_TAGLINE_MAX).toBe(100);
  });
});
