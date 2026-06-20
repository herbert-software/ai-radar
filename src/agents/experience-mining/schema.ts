/**
 * 经验提炼 Agent 输出契约（任务 3.1，spec「经验提炼 Agent 结构化输出」）。
 *
 * 字段对齐 design D5 / spec：
 *   scenario（适用场景）/ tools（涉及的 AI 工具，数组）/ techniques（具体做法或技巧）/
 *   applicability（适用条件或前提）/ long_term_value（0..100 整数）/
 *   headline_zh（一句话要点）/ summary_zh（中文摘要正文）
 *
 * 关键不变量（spec「经验提炼 Agent 结构化输出」 / design D5）：
 * - Agent 输出必须经此 Zod schema 校验通过，禁止以非结构化文本形式返回或入库。
 * - **绝不含 `source_url`/来源链接字段**：来源 URL 是确定性的 `canonical_source_url`
 *   （来自 raw_items.canonical_url，归一去 utm），由程序写入、不由 LLM 产出
 *   （对齐「确定性状态不交 LLM」不变量）。
 * - `long_term_value` 经 `int().min(0).max(100)` 约束（对齐既有 KB Agent 边界，design D5）；
 *   越界/缺字段/类型不符触发上层重试/降级，绝不落库未校验或越界脏数据。
 *
 * `tools` 形状（design D5 / 任务 3.1）：`z.array(z.string())`（string[]），与
 * `KbStoreItem.tags`（kb/store.ts，亦 string[]）形状相容——组 D 落 KB 时直接 `tags = tools`。
 * 落库时存 jsonb（schema.ts 的 `tools` 列），读回需运行期收敛为 string[]（组 D 负责）。
 */
import { z } from 'zod';
import { looksLikeMojibake } from '../mojibake.js';

/**
 * `long_term_value` 评分约束（0..100 整数）。
 *
 * `.int()`：对齐既有 KB Agent 的整数边界、落库列 `long_term_value integer`；放行小数会与
 * integer 列语义分叉。`.min(0).max(100)`：越界（如 150 / -1）触发重试/降级，绝不落库越界分。
 */
const longTermValueField = z.number().int().min(0).max(100);

/**
 * 中文文本字段公共约束：非空、去首尾空白后仍非空、不命中上游双重编码 mojibake。
 *
 * 与 digest/value-judge 同规（共用 looksLikeMojibake）：空串/纯空白等价于「未产出」，
 * mojibake 等价于「乱码产出」，任一命中即整对象 Zod 校验失败 → 走上层重试/降级，绝不落库。
 */
function zhTextField(fieldName: string) {
  return z
    .string()
    .trim()
    .min(1, `${fieldName} 不能为空：空字段等价于未产出，必须触发重试/降级`)
    .refine(
      (v) => !looksLikeMojibake(v),
      `${fieldName} 检出 mojibake（上游双重编码乱码）：必须触发重试/降级，绝不落库乱码`,
    );
}

/**
 * 经验卡片输出 schema（一次 generateObject 同出卡片 + 评分，design D5）。
 */
export const experienceCardSchema = z.object({
  /** 适用场景（必填、非空）。 */
  scenario: zhTextField('scenario'),
  /**
   * 涉及的 AI 工具（数组；string[]，与 KbStoreItem.tags 形状相容）。
   * 允许空数组（卡片可能不点名具体工具）；元素须为非空字符串。
   */
  tools: z.array(z.string().trim().min(1)),
  /** 具体做法或技巧（必填、非空）。 */
  techniques: zhTextField('techniques'),
  /** 适用条件或前提（必填、非空）。 */
  applicability: zhTextField('applicability'),
  /** 长期价值分（0..100 整数；KB 准入闸 + 实践锦囊排序键，design D5）。 */
  long_term_value: longTermValueField,
  /** 一句话要点（必填、非空），供实践锦囊推送渲染。 */
  headline_zh: zhTextField('headline_zh'),
  /** 中文摘要正文（必填、非空）。 */
  summary_zh: zhTextField('summary_zh'),
});

/** 经校验的经验卡片输出类型。 */
export type ExperienceCard = z.infer<typeof experienceCardSchema>;
