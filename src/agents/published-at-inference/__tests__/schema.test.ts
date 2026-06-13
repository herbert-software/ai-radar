/**
 * 发布时间推断输出 schema 单元测试（published-at-inference 1.1 / 1.7）——纯逻辑，无 DB / 无 LLM。
 *
 * 覆盖（design D2 / spec「越界等同无法判定」）：
 * - 合法范围内的 ISO 串通过、归一为 ISO。
 * - 未来日期（> now）→ 归一为 null（上界排除）。
 * - 荒谬过早日期（< 合理下限 1990）→ 归一为 null（下界排除）。
 * - 非法日期串 / 空串 → null。
 * - 显式 null（无法判定）→ null。
 * - confidence / basis 可选、越界 confidence 被拒（仅日志字段，但仍校验形状）。
 */
import { describe, expect, it } from 'vitest';
import {
  makePublishedAtInferenceSchema,
  REASONABLE_LOWER_BOUND,
} from '../schema.js';

const NOW = new Date('2026-06-13T12:00:00Z');

describe('makePublishedAtInferenceSchema 合理范围 refine/transform', () => {
  const schema = makePublishedAtInferenceSchema(NOW);

  it('范围内的 ISO 串通过并归一为 ISO', () => {
    const out = schema.parse({ publishedAt: '2021-05-13T00:00:00Z' });
    expect(out.publishedAt).toBe('2021-05-13T00:00:00.000Z');
  });

  it('仅日期（无时刻）的 ISO 串也接受', () => {
    const out = schema.parse({ publishedAt: '2020-01-01' });
    expect(out.publishedAt).toBe('2020-01-01T00:00:00.000Z');
  });

  it('未来日期（晚于 now）→ 归一为 null（上界排除，防绕过时效闸）', () => {
    const out = schema.parse({ publishedAt: '2030-01-01T00:00:00Z' });
    expect(out.publishedAt).toBeNull();
  });

  it('now 当刻接受（闭区间含等于上界）', () => {
    const out = schema.parse({ publishedAt: NOW.toISOString() });
    expect(out.publishedAt).toBe(NOW.toISOString());
  });

  it('now + 1ms → 归一为 null（严格未来排除）', () => {
    const future = new Date(NOW.getTime() + 1).toISOString();
    const out = schema.parse({ publishedAt: future });
    expect(out.publishedAt).toBeNull();
  });

  it('荒谬过早日期（早于合理下限 1990）→ 归一为 null', () => {
    const out = schema.parse({ publishedAt: '1980-01-01T00:00:00Z' });
    expect(out.publishedAt).toBeNull();
  });

  it('合理下限当刻接受（闭区间含等于下界）', () => {
    const out = schema.parse({
      publishedAt: REASONABLE_LOWER_BOUND.toISOString(),
    });
    expect(out.publishedAt).toBe(REASONABLE_LOWER_BOUND.toISOString());
  });

  it('非法日期串 → null', () => {
    expect(schema.parse({ publishedAt: 'not-a-date' }).publishedAt).toBeNull();
  });

  it('空串 → null', () => {
    expect(schema.parse({ publishedAt: '   ' }).publishedAt).toBeNull();
  });

  it('显式 null（无法判定）→ null', () => {
    expect(schema.parse({ publishedAt: null }).publishedAt).toBeNull();
  });

  it('confidence / basis 可选；带上不影响 publishedAt', () => {
    const out = schema.parse({
      publishedAt: '2022-03-01T00:00:00Z',
      confidence: 0.8,
      basis: 'URL contains /2022/03/',
    });
    expect(out.publishedAt).toBe('2022-03-01T00:00:00.000Z');
    expect(out.confidence).toBe(0.8);
    expect(out.basis).toBe('URL contains /2022/03/');
  });

  it('confidence 越界（>1）被拒（schema 校验失败）', () => {
    const res = schema.safeParse({
      publishedAt: '2022-03-01T00:00:00Z',
      confidence: 1.5,
    });
    expect(res.success).toBe(false);
  });
});
