/**
 * 日报消息拼装（telegram-push 9.3，design D2/D3/D4/D6）。
 *
 * **两层结构（P2 多通道）**：
 * - 第一层「选 Top N 渲染数据」：待发集合（今日 Top N 中待推送者）即渲染数据，与 channel 无关。
 * - 第二层「按 channel 渲染」：`renderDigest(events, channel)` 按 channel 分派渲染器
 *   （Telegram 用 MarkdownV2，飞书用 JSON 卡片由组5 新增），但「待发集合→pending→原子送达→
 *   success/failed」状态机由 dispatcher 统一承载、与 channel 无关。
 *
 * 把待发集合拼成**一条** Telegram 消息。每条事件渲染为
 * 「序号 + 代表标题（粗体）+ 一句话要点（headline_zh）+ 原文可点击链接」——
 * 不再堆叠完整长摘要（summary_zh 仅落库不进消息，design D2）。
 *
 * 单条消息原子送达——N 条 push_record 状态同生共死（成功整批 success / 失败整批 failed），
 * 故必须拼成一条，不可拆多条。
 */
import { HEADLINE_MAX } from '../agents/digest/schema.js';
import { PRODUCT_TAGLINE_MAX } from '../agents/product-digest/schema.js';
import type { SelectedEvent } from '../selection/top-n.js';
import { TARGET_TYPE, type Channel, type TargetType } from './targets.js';

/** Telegram 单条消息长度上限（保守取 4000，留余量给 Markdown 转义）。 */
const MAX_MESSAGE_LENGTH = 4000;

/**
 * 代表标题渲染期截断上限（单一常量，含省略号，按 Unicode code point 计）。
 *
 * `representative_title` 是无长度上限的源标题原文；不截断则一条超长标题即可撑爆单条消息。
 * 截断**必须在 MarkdownV2 转义之前、按 code point**（见 truncateByCodePoint）。
 * 120 与 headline 的 HEADLINE_MAX(80) 共同把每条有界，使 Top N 典型一条装下、截断退化为兜底。
 */
const TITLE_MAX = 120;

/** headline 缺失时回退用 summary_zh 的截断字数（按 code point）。 */
const SUMMARY_FALLBACK_MAX = 80;

/**
 * 原文链接 URL 长度上限。URL 是单条事件块内**唯一无长度上限**的来源（标题/要点已分别按
 * TITLE_MAX / HEADLINE_MAX code point 截断有界）；超此长度即丢弃链接，保证任一事件单独成块
 * 都远小于 MAX_MESSAGE_LENGTH，杜绝「单块超限 → buildDigestMessage 按序遇首块即停 →
 * 后续事件轮不到、includedIds 为 0 → 整条 digest 卡住静默不发」。
 * 规范化（剥离 utm/ref 等）后的链接远短于此，仅挡异常超长 URL。
 */
const MAX_URL_LENGTH = 2000;

/** 截断后省略号。 */
const ELLIPSIS = '…';

/** 转义 Telegram MarkdownV2 保留字符（文本用），避免标题/要点里的特殊符号破坏渲染或发送失败。 */
function escapeMarkdownV2(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (ch) => `\\${ch}`);
}

/**
 * **链接 URL 专用**转义函数（design D3）：Telegram MarkdownV2 内联链接 `[文本](url)` 的 URL
 * 部分只需转义 `)` 与 `\`。**禁止**复用 18 字符文本转义器 escapeMarkdownV2——后者会把 URL
 * 里常见的 `.`/`-`/`_`/`=` 也加反斜杠，破坏链接（点击跳错或发送失败）。
 */
export function escapeMarkdownV2Url(url: string): string {
  return url.replace(/[)\\]/g, (ch) => `\\${ch}`);
}

/**
 * 按 Unicode code point 截断（用 [...str] 展开，非 .slice 的 UTF-16 code unit，防中文/emoji 截半）。
 * 超过 max（含省略号）才截，截后保留 (max-1) 个 code point + 省略号。
 */
function truncateByCodePoint(text: string, max: number): string {
  const cps = [...text];
  if (cps.length <= max) return text;
  return cps.slice(0, Math.max(0, max - 1)).join('') + ELLIPSIS;
}

/**
 * 选出每条事件的「一句话要点」文本（转义前的原文）。回退链（固定顺序）：
 *   headline_zh（非空）→ summary_zh 截断前 ~80 字 → 无要点（返回 null，仅标题）。
 * representative_title 不在此回退（它已作为标题独立渲染；headline 缺失退到标题即等价仅标题无要点）。
 */
function resolveHeadlineText(e: SelectedEvent): string | null {
  const headline = e.headlineZh?.trim();
  if (headline) return headline;
  const summary = e.summaryZh?.trim();
  if (summary) return truncateByCodePoint(summary, SUMMARY_FALLBACK_MAX);
  return null;
}

/**
 * 拼一条日报消息。MarkdownV2 格式，每条 = 「序号 + 标题(粗体) + 要点 + 链接」。
 * 超长时按整条事件为单位截断（不切半条），并在末尾标注剩余条数，保证不超 Telegram 上限。
 *
 * @returns 消息文本、建议的 parse_mode，以及实际拼进消息（未被截断丢弃）的事件 id 列表
 *   （保持入参顺序）。调用方据 includedIds 仅对实际发出的事件改状态，避免被截断者被误标
 *   success 而永久漏推。
 */
/** Telegram 渲染结果（MarkdownV2 文本 + 实际拼进消息的事件 id）。 */
export interface TelegramRendered {
  channel: 'telegram';
  text: string;
  parseMode: 'MarkdownV2';
  includedIds: string[];
}

export function buildDigestMessage(events: readonly SelectedEvent[]): {
  text: string;
  parseMode: 'MarkdownV2';
  includedIds: string[];
} {
  const header = `*AI Radar 每日情报* \\(${escapeMarkdownV2(
    String(events.length),
  )}\\)`;

  const blocks: string[] = [];
  for (let i = 0; i < events.length; i += 1) {
    const e = events[i]!;

    // 标题：渲染期截断（转义之前、按 code point），再转义。
    const rawTitle = e.representativeTitle?.trim() || '(无标题)';
    const title = escapeMarkdownV2(truncateByCodePoint(rawTitle, TITLE_MAX));

    // 要点：headline → summary 截断 → 无（回退链）。
    const headlineText = resolveHeadlineText(e);
    const headlineLine = headlineText
      ? `\n${escapeMarkdownV2(headlineText)}`
      : '';

    // 链接：canonical_url 用专用 URL 转义器；缺失则不渲染链接（仅标题+要点）。
    // URL 超长（远超正常规范化链接）会撑爆单块、卡住整条 digest → 丢弃链接仅渲染标题+要点并告警，
    // 保证单块恒可发（见 MAX_URL_LENGTH）。
    const url = e.canonicalUrl?.trim();
    let linkLine = '';
    if (url) {
      if (url.length <= MAX_URL_LENGTH) {
        linkLine = `\n[原文](${escapeMarkdownV2Url(url)})`;
      } else {
        console.error(
          `[push] canonical_url 超长（${url.length} 字符 > ${MAX_URL_LENGTH}），丢弃链接仅渲染标题+要点。eventId=${e.eventId}`,
        );
      }
    }

    blocks.push(
      `${escapeMarkdownV2(`${i + 1}.`)} *${title}*${headlineLine}${linkLine}`,
    );
  }

  // 截断脚注「…另有 N 条未展示」。N 最多为全部条数，按最坏长度预留空间，
  // 保证一旦触发截断、追加脚注后**仍不超** MAX_MESSAGE_LENGTH（脚注本身也必须可发送，
  // 否则恰在 spec 依赖的截断兜底路径上发送失败）。
  const footerFor = (remaining: number): string =>
    `\n\n${escapeMarkdownV2(`…另有 ${remaining} 条未展示`)}`;
  const footerReserve = footerFor(blocks.length).length;

  // 按事件块逐个累加，超出上限即停止并标注剩余条数（不切半条，保证可发送）。
  let text = header;
  let included = 0;
  const includedIds: string[] = [];
  for (let i = 0; i < blocks.length; i += 1) {
    const next = `${text}\n\n${blocks[i]!}`;
    // 非末块时预留脚注空间：本块之后还有剩余块，可能要追加截断脚注。
    const reserve = i < blocks.length - 1 ? footerReserve : 0;
    if (next.length + reserve > MAX_MESSAGE_LENGTH) break;
    text = next;
    included += 1;
    includedIds.push(events[i]!.eventId);
  }
  if (included < blocks.length) {
    text += footerFor(blocks.length - included);
  }

  return { text, parseMode: 'MarkdownV2', includedIds };
}

// ──────────────────────────────────────────────────────────────────────────
// 飞书 JSON 卡片渲染（feishu-push 5.2，design D5）
//
// 飞书自定义机器人**不支持点击回调到服务端**，故卡片跳转**只用文字链/按钮**（lark_md
// 内联链接 `[文本](url)` + 可选 action button），绝不设计依赖回调交互的卡片。
// 渲染产物（`FeishuRendered`）与 Telegram 同样带 `includedIds`，dispatcher 据此只对
// 实际发出的事件改状态——状态机口径统一、与 channel 无关（dispatcher 不必改）。
//
// **与 dispatcher 的契约**：dispatcher 调 `sender.send(rendered.text, rendered.parseMode)`，
// 对所有 channel 一致。飞书卡片是 JSON 对象而非文本，故 `FeishuRendered.text` 承载
// **卡片 payload 的 JSON 序列化串**（`{ card }`），由 FeishuSender 解析回对象再 POST；
// `parseMode` 取 `'MarkdownV2'` 仅为满足 MessageSender 接口形参类型，FeishuSender 忽略它。
// ──────────────────────────────────────────────────────────────────────────

/** 飞书互动卡片单条事件 code-point 截断上限（与 Telegram TITLE_MAX 同口径，防超长标题撑爆卡片）。 */
const FEISHU_TITLE_MAX = TITLE_MAX;

/** 飞书卡片最多渲染的事件块数（飞书单卡片元素数有上限；Top N 默认 8 远低于此，仅作极端兜底）。 */
const FEISHU_MAX_BLOCKS = 50;

/**
 * 转义 lark_md 文本中会破坏内联链接 `[文本](url)` 结构的字符。
 * lark_md 解析 markdown 语法，故标题/要点里的 `[` `]` `(` `)` 需转义，避免误当链接语法；
 * URL 段不走此函数（URL 直接置于 `(...)` 内，飞书按原样跳转）。
 */
function escapeLarkMdText(text: string): string {
  return text.replace(/[[\]()\\]/g, (ch) => `\\${ch}`);
}

/** 飞书互动卡片 payload（最小结构：header + elements，不含任何回调字段）。 */
export interface FeishuCard {
  config?: { wide_screen_mode?: boolean };
  header: {
    title: { tag: 'plain_text'; content: string };
    template?: string;
  };
  elements: unknown[];
}

/** 飞书渲染结果（卡片 payload 序列化进 text + 实际拼进卡片的事件 id）。 */
export interface FeishuRendered {
  channel: 'feishu';
  /** 卡片 payload 的 JSON 序列化串：`JSON.stringify({ card })`，FeishuSender 解析后 POST。 */
  text: string;
  /** 仅为满足 MessageSender 接口形参类型；FeishuSender 忽略。 */
  parseMode: 'MarkdownV2';
  /** 实际拼进卡片的事件 id（保持入参顺序）；超出 FEISHU_MAX_BLOCKS 的尾部不在内、保持 pending。 */
  includedIds: string[];
  /** 解析出的卡片对象（供 FeishuSender 直接取用，免去再次 JSON.parse）。 */
  card: FeishuCard;
}

/**
 * 把待发集合渲染为飞书互动卡片。每条事件渲染为一个 `div`（lark_md）：
 * 「**序号 标题** \n 要点 \n [原文](url)」——跳转走文字链，不依赖回调。
 * 标题按 code point 截断（与 Telegram 同口径）；要点走 resolveHeadlineText 同一回退链；
 * canonical_url 缺失则不渲染链接行（仅标题 + 要点），不报错、不阻塞整张卡片。
 *
 * @returns 卡片对象、序列化 text、parseMode 占位、includedIds（实际拼进卡片的事件 id）。
 */
export function buildFeishuCard(events: readonly SelectedEvent[]): FeishuRendered {
  const elements: unknown[] = [];
  const includedIds: string[] = [];

  for (let i = 0; i < events.length && includedIds.length < FEISHU_MAX_BLOCKS; i += 1) {
    const e = events[i]!;

    const rawTitle = e.representativeTitle?.trim() || '(无标题)';
    const title = escapeLarkMdText(truncateByCodePoint(rawTitle, FEISHU_TITLE_MAX));

    const lines: string[] = [`**${i + 1}. ${title}**`];

    const headlineText = resolveHeadlineText(e);
    if (headlineText) lines.push(escapeLarkMdText(headlineText));

    // 文字链跳转（不依赖回调）：canonical_url 缺失则不渲染链接行。
    const url = e.canonicalUrl?.trim();
    if (url && url.length <= MAX_URL_LENGTH) {
      // 链接文本「原文」无特殊字符；URL 直接置于括号内（飞书按原样跳转）。
      lines.push(`[原文](${url})`);
    } else if (url) {
      console.error(
        `[push] feishu: canonical_url 超长（${url.length} > ${MAX_URL_LENGTH}），丢弃链接仅渲染标题+要点。eventId=${e.eventId}`,
      );
    }

    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: lines.join('\n') },
    });
    includedIds.push(e.eventId);
  }

  const card: FeishuCard = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `AI Radar 每日情报 (${includedIds.length})` },
      template: 'blue',
    },
    elements,
  };

  return {
    channel: 'feishu',
    text: JSON.stringify({ card }),
    parseMode: 'MarkdownV2',
    includedIds,
    card,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// 周报渲染（weekly-report 10.1，design D6）
//
// 周报幂等粒度是「一周一份」（target_id=iso_week，一个 push_record/周/通道），故 dispatcher 收到的
// 待发集合是**单条**汇总条目（eventId=iso_week），其 `weeklyItems` 挂着该周入选的事件 + 产品明细。
// 周报正文由本处 weekly 分支展开 weeklyItems 列表（复用各条已落库 headline_zh/summary_zh，不触 LLM）；
// includedIds 恒为 `[iso_week]`——整份周报状态同生共死（成功整批 success / 失败整批 failed），与
// 日报「单消息原子」口径一致，dispatcher 状态机不必改。
// ──────────────────────────────────────────────────────────────────────────

/** 周报汇总条目（dispatcher 输入）：在 SelectedEvent 基础上挂该周入选明细。仅 weekly target_type 用。 */
export interface WeeklySelectedEvent extends SelectedEvent {
  weeklyItems: {
    events: SelectedEvent[];
    products: SelectedEvent[];
  };
}

/** 类型守卫：待发集合是否为「单条周报汇总条目」（带 weeklyItems）。 */
function isWeeklySummary(
  events: readonly SelectedEvent[],
): events is readonly [WeeklySelectedEvent] {
  return (
    events.length === 1 &&
    typeof (events[0] as Partial<WeeklySelectedEvent>).weeklyItems === 'object' &&
    (events[0] as Partial<WeeklySelectedEvent>).weeklyItems !== null
  );
}

/** 渲染一条「序号 标题 + 要点 + 链接」明细行的纯文本（转义前），供周报正文复用回退链。 */
function weeklyLineText(e: SelectedEvent, idx: number): {
  title: string;
  headline: string | null;
  url: string | null;
} {
  const rawTitle = e.representativeTitle?.trim() || '(无标题)';
  const title = `${idx}. ${truncateByCodePoint(rawTitle, TITLE_MAX)}`;
  const headline = resolveHeadlineText(e); // headline_zh → summary_zh 截断 → null（复用已落库摘要）。
  const url = e.canonicalUrl?.trim();
  return {
    title,
    headline,
    url: url && url.length <= MAX_URL_LENGTH ? url : null,
  };
}

/** 周报 Telegram 渲染（MarkdownV2）：分「本周要闻」「本周新品」两段展开列表。 */
export function buildWeeklyTelegramMessage(
  item: WeeklySelectedEvent,
): { text: string; parseMode: 'MarkdownV2'; includedIds: string[] } {
  const { events, products } = item.weeklyItems;
  const lines: string[] = [
    `*${escapeMarkdownV2(item.representativeTitle?.trim() || 'AI Radar 周报')}*`,
  ];

  const renderSection = (heading: string, list: readonly SelectedEvent[]) => {
    if (list.length === 0) return;
    lines.push('', `*${escapeMarkdownV2(heading)}*`);
    list.forEach((e, i) => {
      const { title, headline, url } = weeklyLineText(e, i + 1);
      let block = escapeMarkdownV2(title);
      if (headline) block += `\n${escapeMarkdownV2(headline)}`;
      if (url) block += `\n[原文](${escapeMarkdownV2Url(url)})`;
      lines.push(block);
    });
  };

  renderSection('本周要闻', events);
  renderSection('本周新品', products);

  let text = lines.join('\n');
  if (text.length > MAX_MESSAGE_LENGTH) {
    // 极端兜底：整份周报超 Telegram 上限时按 code point 截断并标注（一份周报一条消息原子送达，
    // 不拆多条；正常 Top N×2 段远低于上限）。
    text = truncateByCodePoint(text, MAX_MESSAGE_LENGTH);
  }
  // includedIds 恒为 [iso_week]：整份周报作单条 target 原子送达。
  return { text, parseMode: 'MarkdownV2', includedIds: [item.eventId] };
}

/** 周报飞书卡片渲染：两段（要闻/新品）div 列表，文字链跳转，不依赖回调。 */
export function buildWeeklyFeishuCard(item: WeeklySelectedEvent): FeishuRendered {
  const { events, products } = item.weeklyItems;
  const elements: unknown[] = [];

  const pushSection = (heading: string, list: readonly SelectedEvent[]) => {
    if (list.length === 0) return;
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: `**${escapeLarkMdText(heading)}**` } });
    list.forEach((e, i) => {
      const { title, headline, url } = weeklyLineText(e, i + 1);
      const blockLines = [`**${escapeLarkMdText(title)}**`];
      if (headline) blockLines.push(escapeLarkMdText(headline));
      if (url) blockLines.push(`[原文](${url})`);
      elements.push({ tag: 'div', text: { tag: 'lark_md', content: blockLines.join('\n') } });
    });
  };

  pushSection('本周要闻', events);
  pushSection('本周新品', products);

  const card: FeishuCard = {
    config: { wide_screen_mode: true },
    header: {
      title: {
        tag: 'plain_text',
        content: item.representativeTitle?.trim() || 'AI Radar 周报',
      },
      template: 'turquoise',
    },
    elements,
  };

  return {
    channel: 'feishu',
    text: JSON.stringify({ card }),
    parseMode: 'MarkdownV2',
    includedIds: [item.eventId], // 整份周报作单条 target 原子送达。
    card,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// 实践锦囊渲染（add-ai-blogger-experience-mining，design D6，组 E 5.1）
//
// 一条「AI Radar 实践锦囊」= 若干经验卡片（target_type='experience'）。与要闻段的区别仅在
// **语义字段映射**：经验卡片的 `representativeTitle` 承载 headline_zh（一句话要点，作粗体标题），
// `summaryZh` 承载经验摘要正文（作要点行，而非要闻段「headline→summary 回退链」）；故须**显式**
// 渲染 summary_zh，否则要闻段 resolveHeadlineText 会因 headlineZh 已作标题而把 summary 屏蔽掉。
// canonical_source_url 作来源链接（去 utm 后可点击）。复用 dispatcher 的「待发→pending→原子送达→
// success/failed + includedIds 截断顺延」机制（只是渲染分支不同），不另写漂移状态机。
// ──────────────────────────────────────────────────────────────────────────

/** 实践锦囊卡片摘要正文渲染期截断上限（按 code point；防超长 summary 撑爆单条消息）。 */
const EXPERIENCE_SUMMARY_MAX = HEADLINE_MAX * 2;

/** 单个经验卡片块的 MarkdownV2 文本（序号 + 要点(粗体) + 摘要正文 + 来源链接）。 */
function experienceTelegramBlock(e: SelectedEvent, idx: number): string {
  // 标题 = representativeTitle（承载 headline_zh ?? scenario）；渲染期 code-point 截断后转义。
  const rawTitle = e.representativeTitle?.trim() || '(无要点)';
  const title = escapeMarkdownV2(truncateByCodePoint(rawTitle, TITLE_MAX));

  // 要点行 = summary_zh（经验摘要正文）。显式取 summaryZh（非 resolveHeadlineText 回退链——经验
  // 卡片的 headlineZh 已作标题，沿用回退链会把 summary 屏蔽）。块内按 EXPERIENCE_SUMMARY_MAX 截断。
  const summary = e.summaryZh?.trim();
  const summaryLine = summary
    ? `\n${escapeMarkdownV2(truncateByCodePoint(summary, EXPERIENCE_SUMMARY_MAX))}`
    : '';

  // 来源链接：canonical_source_url 用专用 URL 转义器；缺失/超长则丢弃（仅渲染要点+摘要），保证单块恒可发。
  const url = e.canonicalUrl?.trim();
  let linkLine = '';
  if (url) {
    if (url.length <= MAX_URL_LENGTH) {
      linkLine = `\n[来源](${escapeMarkdownV2Url(url)})`;
    } else {
      console.error(
        `[push] experience canonical_url 超长（${url.length} 字符 > ${MAX_URL_LENGTH}），丢弃链接仅渲染要点+摘要。id=${e.eventId}`,
      );
    }
  }

  return `${escapeMarkdownV2(`${idx}.`)} *${title}*${summaryLine}${linkLine}`;
}

/**
 * 拼一条实践锦囊 Telegram 消息（MarkdownV2）。复用 buildDigestMessage 的「按块累加遇超限即停 +
 * 截断脚注」截断语义；每块块内已按 TITLE_MAX/EXPERIENCE_SUMMARY_MAX/MAX_URL_LENGTH 有界（单块恒可装）。
 */
function buildExperienceMessage(events: readonly SelectedEvent[]): {
  text: string;
  parseMode: 'MarkdownV2';
  includedIds: string[];
} {
  const header = `*AI Radar 实践锦囊* \\(${escapeMarkdownV2(String(events.length))}\\)`;
  const blocks = events.map((e, i) => experienceTelegramBlock(e, i + 1));

  const footerFor = (remaining: number): string =>
    `\n\n${escapeMarkdownV2(`…另有 ${remaining} 条未展示`)}`;
  const footerReserve = footerFor(blocks.length).length;

  let text = header;
  let included = 0;
  const includedIds: string[] = [];
  for (let i = 0; i < blocks.length; i += 1) {
    const next = `${text}\n\n${blocks[i]!}`;
    const reserve = i < blocks.length - 1 ? footerReserve : 0;
    if (next.length + reserve > MAX_MESSAGE_LENGTH) break;
    text = next;
    included += 1;
    includedIds.push(events[i]!.eventId);
  }
  if (included < blocks.length) {
    text += footerFor(blocks.length - included);
  }

  return { text, parseMode: 'MarkdownV2', includedIds };
}

/**
 * 实践锦囊飞书卡片渲染。每条经验渲染为一个 div(lark_md)：
 * 「**序号 要点** \n 摘要正文 \n [来源](url)」——跳转走文字链、不依赖回调（同要闻段约束）。
 * 摘要正文显式取 summaryZh（非要闻段回退链）；canonical_source_url 缺失则不渲染链接行。
 */
function buildExperienceFeishuCard(
  events: readonly SelectedEvent[],
): FeishuRendered {
  const elements: unknown[] = [];
  const includedIds: string[] = [];

  for (let i = 0; i < events.length && includedIds.length < FEISHU_MAX_BLOCKS; i += 1) {
    const e = events[i]!;

    const rawTitle = e.representativeTitle?.trim() || '(无要点)';
    const title = escapeLarkMdText(truncateByCodePoint(rawTitle, FEISHU_TITLE_MAX));
    const lines: string[] = [`**${i + 1}. ${title}**`];

    const summary = e.summaryZh?.trim();
    if (summary) {
      lines.push(escapeLarkMdText(truncateByCodePoint(summary, EXPERIENCE_SUMMARY_MAX)));
    }

    const url = e.canonicalUrl?.trim();
    if (url && url.length <= MAX_URL_LENGTH) {
      lines.push(`[来源](${url})`);
    } else if (url) {
      console.error(
        `[push] feishu experience canonical_url 超长（${url.length} > ${MAX_URL_LENGTH}），丢弃链接仅渲染要点+摘要。id=${e.eventId}`,
      );
    }

    elements.push({ tag: 'div', text: { tag: 'lark_md', content: lines.join('\n') } });
    includedIds.push(e.eventId);
  }

  const card: FeishuCard = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `AI Radar 实践锦囊 (${includedIds.length})` },
      template: 'green',
    },
    elements,
  };

  return {
    channel: 'feishu',
    text: JSON.stringify({ card }),
    parseMode: 'MarkdownV2',
    includedIds,
    card,
  };
}

/**
 * 「按 channel 渲染」分派层（第二层）。把待发集合（第一层「选 Top N 渲染数据」的产物）按
 * 目标 channel 分派到对应渲染器。所有 channel 渲染结果都带 `includedIds`——dispatcher 据此
 * 仅对实际发出的事件改状态（截断者保持 pending），渲染细节由各 channel 自理、状态机口径统一。
 *
 * **周报分支**：待发集合若为「单条周报汇总条目」（带 weeklyItems，见 isWeeklySummary），按 channel
 * 走周报渲染器展开「本周要闻 + 本周新品」列表（复用各条已落库 headline/summary，不触 LLM）；
 * includedIds 恒为 [iso_week]，整份周报原子送达（dispatcher 状态机不变）。
 *
 * **实践锦囊分支**：`targetType='experience'` 时走经验卡片渲染器（标题=headline_zh、要点行=summary_zh、
 * 来源链接）——dispatcher 调用时传入 targetType，渲染分支不同但状态机口径与其它 target_type 一致。
 */
export type RenderedDigest = TelegramRendered | FeishuRendered;

export function renderDigest(
  events: readonly SelectedEvent[],
  channel: Channel,
  targetType: TargetType = TARGET_TYPE.event,
): RenderedDigest {
  const isExperience = targetType === TARGET_TYPE.experience;
  const weekly = isWeeklySummary(events) ? events[0] : null;
  switch (channel) {
    case 'telegram': {
      if (weekly) {
        const { text, parseMode, includedIds } = buildWeeklyTelegramMessage(weekly);
        return { channel: 'telegram', text, parseMode, includedIds };
      }
      const { text, parseMode, includedIds } = isExperience
        ? buildExperienceMessage(events)
        : buildDigestMessage(events);
      return { channel: 'telegram', text, parseMode, includedIds };
    }
    case 'feishu':
      if (weekly) return buildWeeklyFeishuCard(weekly);
      return isExperience
        ? buildExperienceFeishuCard(events)
        : buildFeishuCard(events);
    default: {
      // 穷尽性检查：channelEnum 新增成员而本处未加分支时编译期报错（防遗漏渲染分支）。
      const exhaustive: never = channel;
      throw new Error(`renderDigest: 未知 channel=${String(exhaustive)}`);
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 日报双段渲染（merge-products-into-daily-digest，design D3）
//
// 一条「AI Radar 每日情报」=「要闻段（events）+ 新品段（products）」。与 weekly 的区别：
// weekly 是「整份一条 push_record（target_id=iso_week）」整份 truncateByCodePoint 截断，
// includedIds 恒为 [iso_week]；本处是**逐条** event/product 各自幂等——截断采
// buildDigestMessage 的「按块累加遇超限即停」语义，两段**共享** MAX_MESSAGE_LENGTH 预算，
// 要闻段在前、新品段顺延（顺延者不进 includedIds）。
//
// 与 weekly 共享的只有**视觉分段排版**（标题块 + 列表），不复用 WeeklySelectedEvent 单条结构。
//
// 返回分段 includedIds（eventIncludedIds / productIncludedIds），让 dispatcher 只对「真发出的」
// 按各自 target_type 置 success（否则被截断未发的产品误标 success → 永久漏推，design D3）。
//
// **零 LLM**：产品段=序号 + 产品名 + 官网链接（canonicalUrl）；canonicalUrl 为 null → 仅产品名；
// 产品无 headline/summary → 不渲染要点行（不去找 ai_products 简述列）。
//
// 表头计数取**实发数**（eventIncludedIds.length / productIncludedIds.length），非入参 pending 长度。
// ──────────────────────────────────────────────────────────────────────────

/** 日报渲染结果：MarkdownV2 文本（feishu 分支由 text 承载 card JSON）+ 分段 includedIds。 */
export interface DailyDigestRendered {
  text: string;
  parseMode: 'MarkdownV2';
  /** 实际拼进消息的 event 的 eventId（保持入参顺序）；被截断顺延的不在内、保持 pending。 */
  eventIncludedIds: string[];
  /** 实际拼进消息的 product 的 eventId（product 候选的 eventId = product_id）；同上。 */
  productIncludedIds: string[];
}

/** 单个事件块的 MarkdownV2 文本（序号 + 标题 + 要点回退链 + 原文链接），复用 buildDigestMessage 同款渲染。 */
function dailyTelegramBlock(e: SelectedEvent, idx: number): string {
  const rawTitle = e.representativeTitle?.trim() || '(无标题)';
  const title = escapeMarkdownV2(truncateByCodePoint(rawTitle, TITLE_MAX));

  // headline_zh 列无长度上限（zod cap 仅约束 LLM 写入路径，手动 backfill 等非 zod 路径不受其约束），
  // 故块内按 HEADLINE_MAX 本地再截断一次，使「单块恒可装」自证、不依赖上游 cap。
  const headlineText = resolveHeadlineText(e);
  const headlineLine = headlineText
    ? `\n${escapeMarkdownV2(truncateByCodePoint(headlineText, HEADLINE_MAX))}`
    : '';

  // 链接：canonical_url 用专用 URL 转义器；缺失或超长则丢弃（仅渲染前面部分），保证单块恒可发。
  const url = e.canonicalUrl?.trim();
  let linkLine = '';
  if (url) {
    if (url.length <= MAX_URL_LENGTH) {
      linkLine = `\n[原文](${escapeMarkdownV2Url(url)})`;
    } else {
      console.error(
        `[push] daily canonical_url 超长（${url.length} 字符 > ${MAX_URL_LENGTH}），丢弃链接仅渲染标题+要点。eventId=${e.eventId}`,
      );
    }
  }

  return `${escapeMarkdownV2(`${idx}.`)} *${title}*${headlineLine}${linkLine}`;
}

/**
 * 单个产品块的 MarkdownV2 文本（序号 + 产品名 + 简介要点行 + 官网链接）。
 *
 * 产品名复用 `representativeTitle`（选品映射已 name_zh ?? name、中文优先回退英文）。
 * 简介要点行复用 `headlineZh` —— 在产品语境下该字段承载 `ai_products.tagline_zh`
 * （选品映射 headlineZh = tagline_zh ?? null）；存在则渲染一行、不存在则省略（回退纯标题）。
 */
function dailyTelegramProductBlock(p: SelectedEvent, idx: number): string {
  // 产品名复用 representativeTitle（varchar(255) 有界），套 TITLE_MAX code-point 截断再转义。
  const rawName = p.representativeTitle?.trim() || '(无产品名)';
  const name = escapeMarkdownV2(truncateByCodePoint(rawName, TITLE_MAX));

  // 简介要点行：headlineZh 承载 tagline_zh。tagline_zh 列无长度上限（zod cap 仅约束 LLM 写入路径），
  // 故块内按 PRODUCT_TAGLINE_MAX（产品简介专属上限、与 schema cap 同一常量，**非 events HEADLINE_MAX**）
  // 本地再截断一次，使「单块恒可装」自证、且口径与 schema 一致不静默丢字。
  const tagline = p.headlineZh?.trim();
  const taglineLine = tagline
    ? `\n${escapeMarkdownV2(truncateByCodePoint(tagline, PRODUCT_TAGLINE_MAX))}`
    : '';

  // 官网链接：canonicalUrl 存在且不超长才渲染；超长丢链接（产品名 + canonical_domain 均有界 → 单块恒可装）。
  const url = p.canonicalUrl?.trim();
  let linkLine = '';
  if (url) {
    if (url.length <= MAX_URL_LENGTH) {
      linkLine = `\n[官网](${escapeMarkdownV2Url(url)})`;
    } else {
      console.error(
        `[push] daily product canonical_url 超长（${url.length} 字符 > ${MAX_URL_LENGTH}），丢弃链接仅渲染产品名。productId=${p.eventId}`,
      );
    }
  }

  return `${escapeMarkdownV2(`${idx}.`)} *${name}*${taglineLine}${linkLine}`;
}

/**
 * 日报 Telegram 渲染（MarkdownV2，design D3）：两段（要闻 + 新品）共享 MAX_MESSAGE_LENGTH 预算，
 * 按块累加遇超限即停——要闻段优先、新品段顺延（顺延者不进 includedIds）。某段空只渲染非空段。
 * 表头计数取实发数（eventIncludedIds.length / productIncludedIds.length）。
 */
function buildDailyDigestMessage(
  events: readonly SelectedEvent[],
  products: readonly SelectedEvent[],
): DailyDigestRendered {
  // 段标题（已转义）。
  const eventsHeading = `*${escapeMarkdownV2('要闻')}*`;
  const productsHeading = `*${escapeMarkdownV2('新品')}*`;

  // 预渲染每段的块（块内已按 TITLE_MAX/HEADLINE_MAX/MAX_URL_LENGTH 有界，单块恒可装）。
  const eventBlocks = events.map((e, i) => dailyTelegramBlock(e, i + 1));
  const productBlocks = products.map((p, i) => dailyTelegramProductBlock(p, i + 1));

  // 按块累加：先要闻段、后新品段，共享一个 text 缓冲与 MAX_MESSAGE_LENGTH 预算。
  // 表头含实发数，但实发数依赖累加结果——故先以「全量计数」预留表头最坏长度（计数位数极短，
  // 不同实发数下表头长度差异最多几个字符，落在 MAX_MESSAGE_LENGTH 的保守余量内），
  // 末尾再以实发数重算表头。
  const eventIncludedIds: string[] = [];
  const productIncludedIds: string[] = [];

  // 表头长度上界：计数取各段全量长度（位数最多、表头最长），保证预留充足。
  const headerUpperBound = buildDailyHeaderTelegram(events.length, products.length);
  let usedLen = headerUpperBound.length;

  // 累加要闻段（段标题在首个入选块之前才追加，空段不渲染标题）。
  let eventsHeadingCharged = false;
  for (let i = 0; i < eventBlocks.length; i += 1) {
    const headingCost = eventsHeadingCharged ? 0 : `\n\n${eventsHeading}`.length;
    const blockCost = `\n\n${eventBlocks[i]!}`.length;
    if (usedLen + headingCost + blockCost > MAX_MESSAGE_LENGTH) break;
    usedLen += headingCost + blockCost;
    eventsHeadingCharged = true;
    eventIncludedIds.push(events[i]!.eventId);
  }

  // 累加新品段（顺延在要闻段之后；要闻段空时新品段成首段，其首块仍恒可装）。
  let productsHeadingCharged = false;
  for (let i = 0; i < productBlocks.length; i += 1) {
    const headingCost = productsHeadingCharged ? 0 : `\n\n${productsHeading}`.length;
    const blockCost = `\n\n${productBlocks[i]!}`.length;
    if (usedLen + headingCost + blockCost > MAX_MESSAGE_LENGTH) break;
    usedLen += headingCost + blockCost;
    productsHeadingCharged = true;
    productIncludedIds.push(products[i]!.eventId);
  }

  // 用实发数重建表头与正文（实发数 ≤ 全量数 → 重建后 text 长度 ≤ 上界估算，恒不超限）。
  const header = buildDailyHeaderTelegram(
    eventIncludedIds.length,
    productIncludedIds.length,
  );
  const parts: string[] = [header];
  if (eventIncludedIds.length > 0) {
    parts.push(eventsHeading);
    for (let i = 0; i < eventIncludedIds.length; i += 1) parts.push(eventBlocks[i]!);
  }
  if (productIncludedIds.length > 0) {
    parts.push(productsHeading);
    for (let i = 0; i < productIncludedIds.length; i += 1) parts.push(productBlocks[i]!);
  }

  return {
    text: parts.join('\n\n'),
    parseMode: 'MarkdownV2',
    eventIncludedIds,
    productIncludedIds,
  };
}

/** 日报表头（Telegram，MarkdownV2）：`AI Radar 每日情报（要闻 X·新品 Y）`，计数取实发数。 */
function buildDailyHeaderTelegram(eventCount: number, productCount: number): string {
  return `*${escapeMarkdownV2(
    `AI Radar 每日情报（要闻 ${eventCount}·新品 ${productCount}）`,
  )}*`;
}

/**
 * 日报飞书卡片渲染（design D3）：两段（要闻/新品）div 列表，文字链跳转、不依赖回调。
 * 与 Telegram 同款「按块累加遇超限即停」共享预算（以序列化 text 长度近似度量），
 * 要闻段优先、新品段顺延。表头计数取实发数。返回 text 承载 `{ card }` 的 JSON 序列化串。
 */
function buildDailyFeishuCard(
  events: readonly SelectedEvent[],
  products: readonly SelectedEvent[],
): DailyDigestRendered {
  // 单个事件块的 lark_md 内容（序号 + 标题 + 要点回退链 + 原文链接）。
  const eventContent = (e: SelectedEvent, idx: number): string => {
    const rawTitle = e.representativeTitle?.trim() || '(无标题)';
    const title = escapeLarkMdText(truncateByCodePoint(rawTitle, FEISHU_TITLE_MAX));
    const lines: string[] = [`**${idx}. ${title}**`];
    // 同 Telegram：headline_zh 列无长度上限，块内按 HEADLINE_MAX 本地再截断一次使单块恒可装。
    const headlineText = resolveHeadlineText(e);
    if (headlineText) lines.push(escapeLarkMdText(truncateByCodePoint(headlineText, HEADLINE_MAX)));
    const url = e.canonicalUrl?.trim();
    if (url && url.length <= MAX_URL_LENGTH) {
      lines.push(`[原文](${url})`);
    } else if (url) {
      console.error(
        `[push] daily feishu canonical_url 超长（${url.length} > ${MAX_URL_LENGTH}），丢弃链接仅渲染标题+要点。eventId=${e.eventId}`,
      );
    }
    return lines.join('\n');
  };

  // 单个产品块的 lark_md 内容（序号 + 产品名 + 简介要点行 + 官网链接；null → 仅产品名）。
  const productContent = (p: SelectedEvent, idx: number): string => {
    const rawName = p.representativeTitle?.trim() || '(无产品名)';
    const name = escapeLarkMdText(truncateByCodePoint(rawName, FEISHU_TITLE_MAX));
    const lines: string[] = [`**${idx}. ${name}**`];
    // 简介要点行：headlineZh 承载 tagline_zh，套 PRODUCT_TAGLINE_MAX 截断（与 Telegram 口径一致、
    // 非 events HEADLINE_MAX）；存在则加一行、无则纯标题。
    const tagline = p.headlineZh?.trim();
    if (tagline) lines.push(escapeLarkMdText(truncateByCodePoint(tagline, PRODUCT_TAGLINE_MAX)));
    const url = p.canonicalUrl?.trim();
    if (url && url.length <= MAX_URL_LENGTH) {
      lines.push(`[官网](${url})`);
    } else if (url) {
      console.error(
        `[push] daily feishu product canonical_url 超长（${url.length} > ${MAX_URL_LENGTH}），丢弃链接仅渲染产品名。productId=${p.eventId}`,
      );
    }
    return lines.join('\n');
  };

  const eventContents = events.map((e, i) => eventContent(e, i + 1));
  const productContents = products.map((p, i) => productContent(p, i + 1));

  // 段标题 div 内容（与最终渲染逐字一致，使预算度量准确）。
  const eventsHeadingContent = `**${escapeLarkMdText('要闻')}**`;
  const productsHeadingContent = `**${escapeLarkMdText('新品')}**`;

  // 按块累加：以「拼入该块后的实际 card JSON 序列化长度」度量预算（要闻段优先、新品段顺延）。
  // 实际序列化口径天然计入「段标题 div + elements 数组间逗号」两项开销——故 elements 即最终数组、
  // 不另估；飞书额外受 FEISHU_MAX_BLOCKS 元素数上限约束（含两个段标题 div 在内的总 elements 数）。
  const eventIncludedIds: string[] = [];
  const productIncludedIds: string[] = [];
  const elements: unknown[] = [];

  // 表头取全量计数作长度上界（位数最多、表头最长）；末尾再以实发数重建（实发 ≤ 全量 → 长度 ≤ 上界）。
  const headerUpperBound = buildDailyHeaderFeishu(events.length, products.length);
  // 拼入候选块后是否仍满足「elements 数 ≤ FEISHU_MAX_BLOCKS 且序列化长度 ≤ MAX_MESSAGE_LENGTH」。
  const fits = (): boolean =>
    elements.length <= FEISHU_MAX_BLOCKS &&
    serializeFeishuCard(headerUpperBound, elements).length <= MAX_MESSAGE_LENGTH;

  // 段标题 div 与该段首个入选块一同拼入：若拼入后超限则连标题一并回退（不留孤立段标题）。
  let eventsHeadingPushed = false;
  for (let i = 0; i < eventContents.length; i += 1) {
    const before = elements.length;
    if (!eventsHeadingPushed) elements.push(feishuDiv(eventsHeadingContent));
    elements.push(feishuDiv(eventContents[i]!));
    if (!fits()) {
      elements.length = before; // 回退本次推入（含可能的段标题）。
      break;
    }
    eventsHeadingPushed = true;
    eventIncludedIds.push(events[i]!.eventId);
  }

  let productsHeadingPushed = false;
  for (let i = 0; i < productContents.length; i += 1) {
    const before = elements.length;
    if (!productsHeadingPushed) elements.push(feishuDiv(productsHeadingContent));
    elements.push(feishuDiv(productContents[i]!));
    if (!fits()) {
      elements.length = before;
      break;
    }
    productsHeadingPushed = true;
    productIncludedIds.push(products[i]!.eventId);
  }

  // 用实发数重建表头（计数 ≤ 全量 → 序列化长度 ≤ 上界，恒不超限）；elements 已是最终数组。
  const card = buildDailyHeaderFeishu(eventIncludedIds.length, productIncludedIds.length);
  card.elements = elements;

  return {
    text: JSON.stringify({ card }),
    parseMode: 'MarkdownV2',
    eventIncludedIds,
    productIncludedIds,
  };
}

/** 日报飞书卡片表头（计数取实发数）；elements 由调用方填充。 */
function buildDailyHeaderFeishu(eventCount: number, productCount: number): FeishuCard {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: {
        tag: 'plain_text',
        content: `AI Radar 每日情报（要闻 ${eventCount}·新品 ${productCount}）`,
      },
      template: 'blue',
    },
    elements: [],
  };
}

/** 构造一个 lark_md div 元素。 */
function feishuDiv(content: string): unknown {
  return { tag: 'div', text: { tag: 'lark_md', content } };
}

/** 把已构好 elements 的卡片序列化为 dispatcher 契约的 text（`{ card }` JSON 串）。 */
function serializeFeishuCard(card: FeishuCard, elements: unknown[]): string {
  return JSON.stringify({ card: { ...card, elements } });
}

/**
 * 日报双段渲染入口（design D3）。channel 决定走哪个分支（同 renderDigest）：
 * telegram → MarkdownV2 文本；feishu → text 承载 `{ card }` JSON 串（沿用既有 FeishuSender 契约）。
 * 返回 `{ text, parseMode, eventIncludedIds, productIncludedIds }`——分段 includedIds 是核心，
 * 让 dispatcher 只对真发出的按各自 target_type 置 success。
 *
 * @param events 要闻段候选（入参顺序即渲染顺序）。
 * @param products 新品段候选（product 候选的 eventId = product_id）。
 * @param channel 目标通道。
 */
export function renderDailyDigest(
  events: readonly SelectedEvent[],
  products: readonly SelectedEvent[],
  channel: Channel,
): DailyDigestRendered {
  switch (channel) {
    case 'telegram':
      return buildDailyDigestMessage(events, products);
    case 'feishu':
      return buildDailyFeishuCard(events, products);
    default: {
      // 穷尽性检查：channelEnum 新增成员而本处未加分支时编译期报错。
      const exhaustive: never = channel;
      throw new Error(`renderDailyDigest: 未知 channel=${String(exhaustive)}`);
    }
  }
}
