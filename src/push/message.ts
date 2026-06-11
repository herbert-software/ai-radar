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
import type { SelectedEvent } from '../selection/top-n.js';
import type { Channel } from './targets.js';

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

/**
 * 「按 channel 渲染」分派层（第二层）。把待发集合（第一层「选 Top N 渲染数据」的产物）按
 * 目标 channel 分派到对应渲染器。所有 channel 渲染结果都带 `includedIds`——dispatcher 据此
 * 仅对实际发出的事件改状态（截断者保持 pending），渲染细节由各 channel 自理、状态机口径统一。
 *
 * **周报分支**：待发集合若为「单条周报汇总条目」（带 weeklyItems，见 isWeeklySummary），按 channel
 * 走周报渲染器展开「本周要闻 + 本周新品」列表（复用各条已落库 headline/summary，不触 LLM）；
 * includedIds 恒为 [iso_week]，整份周报原子送达（dispatcher 状态机不变）。
 */
export type RenderedDigest = TelegramRendered | FeishuRendered;

export function renderDigest(
  events: readonly SelectedEvent[],
  channel: Channel,
): RenderedDigest {
  const weekly = isWeeklySummary(events) ? events[0] : null;
  switch (channel) {
    case 'telegram': {
      if (weekly) {
        const { text, parseMode, includedIds } = buildWeeklyTelegramMessage(weekly);
        return { channel: 'telegram', text, parseMode, includedIds };
      }
      const { text, parseMode, includedIds } = buildDigestMessage(events);
      return { channel: 'telegram', text, parseMode, includedIds };
    }
    case 'feishu':
      return weekly ? buildWeeklyFeishuCard(weekly) : buildFeishuCard(events);
    default: {
      // 穷尽性检查：channelEnum 新增成员而本处未加分支时编译期报错（防遗漏渲染分支）。
      const exhaustive: never = channel;
      throw new Error(`renderDigest: 未知 channel=${String(exhaustive)}`);
    }
  }
}
