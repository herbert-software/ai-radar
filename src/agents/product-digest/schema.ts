/**
 * 产品中文化 Agent 输出契约（capability: product-chinese-digest，design D2）。
 *
 * 关键不变量：
 * - Agent 输出必须经此 Zod schema 校验通过，禁止以非结构化文本形式返回或入库。
 * - 必含 `name_zh`（中文译名）+ `tagline_zh`（一句话中文简介），校验通过后写入
 *   `ai_products.name_zh` / `ai_products.tagline_zh`。
 *
 * 与 events digest（src/agents/digest/schema.ts）同规格：用最小约束保证「非空、是字符串」，
 * 把空串 / 缺字段 / 超长 / mojibake 挡在 Zod 层（触发重试 / 降级，绝不落库半截输出）。
 */
import { z } from 'zod';
import { looksLikeMojibake } from '../mojibake.js';

/**
 * 中文译名 `name_zh` 的字数硬上限（单一事实来源）。
 *
 * schema `.max()` + prompt 文案 + 渲染期截断（日报产品名）共用此常量、防多处漂移。
 * 中文译名通常很短，取 120 字（列为 varchar(255)，宽于此 cap，仅作 DB 兜底；
 * 真正约束在此处的 schema cap）。
 */
export const NAME_ZH_MAX = 120;

/**
 * 一句话中文简介 `tagline_zh` 的字数硬上限（单一事实来源）。
 *
 * 与 events `HEADLINE_MAX` 同性质：**schema `.max()`、prompt 文案、渲染期截断三处共用同一值**，
 * 禁止 schema 允许 N 字却渲染截到另一值的静默丢字。100 字定为「Telegram 日报一眼扫完」的
 * 短简介上限，与产品名共同把每条产品块有界。
 */
export const PRODUCT_TAGLINE_MAX = 100;

export const productDigestOutputSchema = z.object({
  /** 中文译名（必填、非空、去首尾空白后仍非空、不超 NAME_ZH_MAX 字、非 mojibake）。 */
  name_zh: z
    .string()
    .trim()
    .min(1, 'name_zh 不能为空：空译名等价于未产出，必须触发重试/降级')
    .max(
      NAME_ZH_MAX,
      `name_zh 超过 ${NAME_ZH_MAX} 字上限：中文译名须足够短以适配日报，必须触发重试/降级`,
    )
    // 上游间歇性双重编码会把中文返回成 mojibake（乱码）；命中即视同未产出，
    // 走与 Zod 失败相同的重试/降级路径，绝不把乱码落库/推送。
    .refine(
      (v) => !looksLikeMojibake(v),
      'name_zh 检出 mojibake（上游双重编码乱码）：必须触发重试/降级，绝不落库乱码',
    ),
  /** 一句话中文简介（必填、非空、去首尾空白后仍非空、不超 PRODUCT_TAGLINE_MAX 字、非 mojibake）。 */
  tagline_zh: z
    .string()
    .trim()
    .min(1, 'tagline_zh 不能为空：空简介等价于未产出，必须触发重试/降级')
    .max(
      PRODUCT_TAGLINE_MAX,
      `tagline_zh 超过 ${PRODUCT_TAGLINE_MAX} 字上限：一句话简介须足够短以适配 Telegram 日报，必须触发重试/降级`,
    )
    .refine(
      (v) => !looksLikeMojibake(v),
      'tagline_zh 检出 mojibake（上游双重编码乱码）：必须触发重试/降级，绝不落库乱码',
    ),
});

/** 经校验的产品中文化输出类型。 */
export type ProductDigestOutput = z.infer<typeof productDigestOutputSchema>;
