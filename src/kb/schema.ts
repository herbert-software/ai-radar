/**
 * 知识摘要 Agent 输出契约（add-semantic-dedup-and-store-hardening，组 E / spec「知识摘要 Agent
 * 产出入库元数据」，QA.md §10.7）。
 *
 * 字段对齐 spec：`{ kb_title, summary_zh, tags[], entities[], source_urls[], event_date, long_term_value }`。
 *
 * 关键不变量（spec / design D7）：
 * - Agent 输出必须经此 Zod schema 校验通过，禁止以非结构化文本返回或入库。
 * - `long_term_value` **必须**钉死 `number().int().min(0).max(100)`——防越界值（200 / 负数）绕过
 *   `>= 70` 准入闸语义；越界即校验不过、跳过该条（与 value-judge scoreField 同口径）。
 * - `event_date` 为 `YYYY-MM-DD` 字符串：`kb_documents.event_date` 是 PG `date` 列，drizzle 接受
 *   字符串字面量；用 regex 钉死格式，避免脏值写入 date 列时由 DB 报错中止整批。
 */
import { z } from 'zod';

/** 长期价值分约束：整数 0–100。钉死取值域防越界绕过准入闸（spec 明文要求）。 */
const longTermValueField = z.number().int().min(0).max(100);

/** `YYYY-MM-DD` 日期字符串（对齐 PG date 列字面量）。 */
const eventDateField = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'event_date 必须为 YYYY-MM-DD 格式');

/**
 * 知识摘要 Agent 输出 schema。
 */
export const kbIngestionMetadataSchema = z.object({
  /** 知识条目标题（中文，简洁）。 */
  kb_title: z.string().min(1),
  /** 中文摘要（沉淀用、可长于日报摘要）。 */
  summary_zh: z.string().min(1),
  /** 标签数组。 */
  tags: z.array(z.string().min(1)),
  /** 实体数组（公司 / 产品 / 人物等）。 */
  entities: z.array(z.string().min(1)),
  /** 来源 URL 数组。 */
  source_urls: z.array(z.string().min(1)),
  /** 事件日期（YYYY-MM-DD）。 */
  event_date: eventDateField,
  /** 长期价值分 0–100（整数；准入闸据此过滤 >= 70）。 */
  long_term_value: longTermValueField,
});

/** 经校验的知识摘要 Agent 输出类型。 */
export type KbIngestionMetadata = z.infer<typeof kbIngestionMetadataSchema>;
