/**
 * 中文摘要 Agent 输出契约（任务 7.1，spec「结构化中文摘要契约」）。
 *
 * 关键不变量：
 * - Agent 输出必须经此 Zod schema 校验通过，禁止以非结构化文本形式返回或入库。
 * - 必含 `summary_zh`（中文摘要正文），校验通过后写入 `ai_news_events.summary_zh`。
 *
 * 与 value-judge/schema.ts 同规格（design D9）：用最小约束保证「非空、是字符串」，
 * 把空串 / 缺字段挡在 Zod 层（触发重试 / 降级，绝不落库半截输出）。
 */
import { z } from 'zod';
import { looksLikeMojibake } from '../mojibake.js';

/**
 * 中文摘要输出 schema。
 *
 * `summary_zh` 必须为非空字符串：空串 / 纯空白等价于「没产出摘要」，必须挡掉
 * （`.min(1)` + `.trim()` 后再校验），否则会把空摘要当成功落库，污染推送。
 *
 * 同时设上限 `.max(MAX_SUMMARY_LENGTH)`：一条 LLM 失控的超长摘要会让该事件单块
 * 超过 Telegram 单条消息上限（push/message.ts 的 MAX_MESSAGE_LENGTH=4000），导致
 * dispatcher 的 includedIds 为空 → 该事件永远 pending、每轮重复告警、永不送达。
 * 取 1000 字（远低于 4000，留足序号/标题/MarkdownV2 转义开销），超长则 Zod 校验失败
 * → 走既有重试/降级（DigestFailureError → 回退 representative_title），绝不落库超长摘要。
 */
const MAX_SUMMARY_LENGTH = 1000;

/**
 * 一句话要点 `headline_zh` 的字数硬上限（单一事实来源）。
 *
 * schema `.max()` 与 prompt 文案（src/agents/digest/index.ts）共用此常量、防两处漂移：
 * 改这一处即同步约束「Zod 校验上限」与「告诉 LLM 的目标长度」。
 * 80 字定为「Telegram 日报一眼能扫完」的短要点上限（design D1/D4）；
 * 与 `representative_title` 渲染期截断（TITLE_MAX，G2 的 message.ts）共同把每条有界，
 * 使 Top N 典型一条消息装下、截断退化为兜底。
 */
export const HEADLINE_MAX = 80;

export const digestOutputSchema = z.object({
  /** 中文摘要正文（必填、非空、去除首尾空白后仍非空、不超 MAX_SUMMARY_LENGTH 字）。 */
  summary_zh: z
    .string()
    .trim()
    .min(1, 'summary_zh 不能为空：空摘要等价于未产出，必须触发重试/降级')
    .max(
      MAX_SUMMARY_LENGTH,
      `summary_zh 超过 ${MAX_SUMMARY_LENGTH} 字上限：超长摘要会撑爆 Telegram 单条消息上限致永不送达，必须触发重试/降级`,
    )
    // 上游间歇性双重编码会把中文返回成 mojibake（乱码）；命中即视同未产出，
    // 走与 Zod 失败相同的重试/降级路径，绝不把乱码落库/推送。
    .refine(
      (v) => !looksLikeMojibake(v),
      'summary_zh 检出 mojibake（上游双重编码乱码）：必须触发重试/降级，绝不落库乱码',
    ),
  /**
   * 一句话要点（必填、非空、去首尾空白后仍非空、不超 HEADLINE_MAX 字），供 Telegram 日报渲染。
   *
   * 与 summary_zh 由**同一次** generateObject 产出、整对象 Zod 校验；超长 / 空串 / mojibake
   * 任一命中即整对象校验失败 → 走既有重试/降级（不破坏既有 DigestFailureError 降级语义）。
   * 校验通过后落库到 ai_news_events.headline_zh。
   */
  headline_zh: z
    .string()
    .trim()
    .min(1, 'headline_zh 不能为空：空要点等价于未产出，必须触发重试/降级')
    .max(
      HEADLINE_MAX,
      `headline_zh 超过 ${HEADLINE_MAX} 字上限：一句话要点须足够短以适配 Telegram 日报，必须触发重试/降级`,
    )
    // headline 同样可能命中上游双重编码乱码；与 summary_zh 同规走重试/降级，绝不落库乱码。
    .refine(
      (v) => !looksLikeMojibake(v),
      'headline_zh 检出 mojibake（上游双重编码乱码）：必须触发重试/降级，绝不落库乱码',
    ),
});

/** 经校验的中文摘要输出类型。 */
export type DigestOutput = z.infer<typeof digestOutputSchema>;
