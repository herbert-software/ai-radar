/**
 * Model Radar 5b per-table 写校验器单测（task 1.1/1.4，纯逻辑无 DB/网络/LLM）。
 *
 * 守住不变量：
 * - 1.4 全桶新枚举值往返：`credit`/`fast_pass`（limit_type）、`EUR`（currency）经对应组合写 schema 解析通过。
 * - 1.1 各表组合写校验器：合法值解析通过、非法有限值集值被拒（发 SQL 前的唯一防线）。
 * - design D3：`mrModelWriteSchema` 把 `family` 小写归一（`GLM`→`glm`），防大小写敏感唯一键误分裂。
 */
import { describe, expect, it } from 'vitest';
import {
  mrLimitTypeSchema,
  mrCurrencySchema,
} from '../../../db/mr-schema.zod.js';
import {
  mrModelWriteSchema,
  mrPlanClientWriteSchema,
  mrPlanLimitWriteSchema,
  mrPlanModelWriteSchema,
  mrPlanWriteValidator,
  mrPriceHistoryWriteSchema,
  mrSourceWriteSchema,
} from '../validators.js';

describe('1.4 全桶新枚举值随录入扩（合成往返断言）', () => {
  it.each(['credit', 'fast_pass'] as const)(
    'limit_type 扩值 %s 经枚举闸往返通过',
    (v) => {
      expect(mrLimitTypeSchema.parse(v)).toBe(v);
      // 经组合写校验器（带 provenance）也往返通过。
      expect(
        mrPlanLimitWriteSchema.parse({
          limitType: v,
          sourceConfidence: 'official_pricing',
        }).limitType,
      ).toBe(v);
    },
  );

  it('currency 扩值 EUR 经枚举闸 + 改价校验器往返通过', () => {
    expect(mrCurrencySchema.parse('EUR')).toBe('EUR');
    expect(
      mrPriceHistoryWriteSchema.parse({
        currency: 'EUR',
        sourceConfidence: 'official_pricing',
      }).currency,
    ).toBe('EUR');
  });

  it('扩值不改语义：原有桶2 值仍通过', () => {
    expect(mrLimitTypeSchema.parse('monthly_tokens')).toBe('monthly_tokens');
    expect(mrCurrencySchema.parse('CNY')).toBe('CNY');
  });
});

describe('1.1 各表组合写校验器：合法通过', () => {
  it('plan 校验器复用 5a refine（价格币种同生同灭）', () => {
    expect(() =>
      mrPlanWriteValidator.parse({
        category: 'token_plan',
        currentPrice: '20.00',
        currency: 'EUR',
        sourceConfidence: 'official_pricing',
      }),
    ).not.toThrow();
    // needs_login_recheck 占位：价格币种皆 NULL。
    expect(() =>
      mrPlanWriteValidator.parse({
        category: 'ide_membership',
        currentPrice: null,
        currency: null,
        sourceConfidence: 'needs_login_recheck',
      }),
    ).not.toThrow();
  });

  it('planClient 校验器（client_type + provenance）', () => {
    expect(() =>
      mrPlanClientWriteSchema.parse({
        clientType: 'protocol',
        sourceConfidence: 'official_doc',
      }),
    ).not.toThrow();
  });

  it('planModel 校验器（仅 source_confidence，断言事实不可漏）', () => {
    expect(() =>
      mrPlanModelWriteSchema.parse({ sourceConfidence: 'official_community' }),
    ).not.toThrow();
  });

  it('source 校验器（fetch_strategy 有限值列）', () => {
    for (const s of ['http', 'browser', 'manual']) {
      expect(mrSourceWriteSchema.parse({ fetchStrategy: s }).fetchStrategy).toBe(
        s,
      );
    }
  });
});

describe('1.1 非法有限值集值被拒（发 SQL 前唯一防线）', () => {
  it('plan：半 NULL 态（有价无币）被 refine 拒', () => {
    expect(() =>
      mrPlanWriteValidator.parse({
        category: 'coding_plan',
        currentPrice: '20.00',
        currency: null,
        sourceConfidence: 'official_pricing',
      }),
    ).toThrow();
  });

  it('plan：非法 category 被拒', () => {
    expect(() =>
      mrPlanWriteValidator.parse({
        category: 'free_tier',
        currentPrice: null,
        currency: null,
        sourceConfidence: 'official_pricing',
      }),
    ).toThrow();
  });

  it('planLimit：非法 limit_type 被拒', () => {
    expect(() =>
      mrPlanLimitWriteSchema.parse({
        limitType: 'yearly_tokens',
        sourceConfidence: 'official_pricing',
      }),
    ).toThrow();
  });

  it('planClient：非法 client_type 被拒', () => {
    expect(() =>
      mrPlanClientWriteSchema.parse({
        clientType: 'plugin',
        sourceConfidence: 'official_pricing',
      }),
    ).toThrow();
  });

  it('source：非法 fetch_strategy 被拒（非录入路径写枚举列也过 Zod）', () => {
    expect(() =>
      mrSourceWriteSchema.parse({ fetchStrategy: 'curl' }),
    ).toThrow();
  });

  it('priceHistory：非法 currency / 非法 confidence 被拒', () => {
    expect(() =>
      mrPriceHistoryWriteSchema.parse({
        currency: 'JPY',
        sourceConfidence: 'official_pricing',
      }),
    ).toThrow();
    expect(() =>
      mrPriceHistoryWriteSchema.parse({
        currency: 'USD',
        sourceConfidence: 'guess',
      }),
    ).toThrow();
  });
});

describe('1.1 design D3：mr_models.family 小写归一', () => {
  it('GLM / glm 归一到同值（防大小写敏感唯一键误分裂）', () => {
    expect(mrModelWriteSchema.parse({ family: 'GLM', version: '5.2' }).family).toBe(
      'glm',
    );
    expect(mrModelWriteSchema.parse({ family: 'glm', version: '5.2' }).family).toBe(
      'glm',
    );
    // 含空白也归一。
    expect(
      mrModelWriteSchema.parse({ family: '  Kimi ', version: 'K2.7' }).family,
    ).toBe('kimi');
  });
});
