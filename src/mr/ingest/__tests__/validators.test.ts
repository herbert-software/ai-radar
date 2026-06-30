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
  getMrPlanPriceStatus,
  mrLimitTypeSchema,
  mrCurrencySchema,
  mrPlanPriceSchema,
  mrPriceAmountSchema,
} from '../../../db/mr-schema.zod.js';
import {
  mrModelWriteSchema,
  mrPlanClientWriteSchema,
  mrPlanLimitWriteSchema,
  mrPlanModelWriteSchema,
  mrPlanWriteValidator,
  mrPriceHistoryWriteSchema,
  mrSourceUrlSchema,
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

describe('1.6 confidence↔price 绑定（共享 schema，发 SQL 前拒）', () => {
  // 落点是共享 mrPlanWriteValidator，故 upsertPlan 新建 INSERT 与改价委托两路都过此闸。
  it.each(['needs_login_recheck', 'official_community', 'media_report'] as const)(
    'upsertPlan 新建分支负例：非官方 confidence %s 带非 NULL 价被拒',
    (conf) => {
      expect(() =>
        mrPlanWriteValidator.parse({
          category: 'coding_plan',
          currentPrice: 40,
          currency: 'CNY',
          sourceConfidence: conf,
        }),
      ).toThrow();
    },
  );

  it('官方 confidence 才可带价（official_pricing/official_doc 通过）', () => {
    for (const conf of ['official_pricing', 'official_doc'] as const) {
      expect(() =>
        mrPlanWriteValidator.parse({
          category: 'coding_plan',
          currentPrice: 40,
          currency: 'CNY',
          sourceConfidence: conf,
        }),
      ).not.toThrow();
    }
  });

  it('非官方 confidence + NULL 价占位仍合法（占位不受绑定影响）', () => {
    expect(() =>
      mrPlanWriteValidator.parse({
        category: 'coding_plan',
        currentPrice: null,
        currency: null,
        sourceConfidence: 'needs_login_recheck',
      }),
    ).not.toThrow();
  });

  it('recordPriceChange 路径：非官方 confidence 写价被 mrPriceHistoryWriteSchema 拒', () => {
    for (const conf of ['needs_login_recheck', 'official_community', 'media_report'] as const) {
      expect(() =>
        mrPriceHistoryWriteSchema.parse({ currency: 'CNY', sourceConfidence: conf }),
      ).toThrow();
    }
    // 官方 confidence 通过。
    expect(
      mrPriceHistoryWriteSchema.parse({ currency: 'CNY', sourceConfidence: 'official_pricing' })
        .sourceConfidence,
    ).toBe('official_pricing');
  });
});

describe('add-model-radar-price-state-and-periods：周期价 Zod 地基', () => {
  const base = {
    plan_id: 'plan-1',
    billing_period: 'annual',
    currency: 'CNY',
    source_url: 'https://example.com/pricing',
    last_checked: new Date('2026-06-30T00:00:00.000Z'),
  } as const;

  it('只接受 quarterly/annual，拒 monthly 镜像行', () => {
    expect(
      mrPlanPriceSchema.safeParse({
        ...base,
        billing_period: 'quarterly',
        price: '120.00',
        source_confidence: 'official_doc',
      }).success,
    ).toBe(true);
    expect(
      mrPlanPriceSchema.safeParse({
        ...base,
        billing_period: 'monthly',
        price: '40.00',
        source_confidence: 'official_doc',
      }).success,
    ).toBe(false);
  });

  it('逐行守 confidence↔price：非官方 confidence 不得带非 NULL price，NULL 占位合法', () => {
    expect(
      mrPlanPriceSchema.safeParse({
        ...base,
        price: '468.00',
        source_confidence: 'official_doc',
      }).success,
    ).toBe(true);
    expect(
      mrPlanPriceSchema.safeParse({
        ...base,
        price: '468.00',
        source_confidence: 'needs_login_recheck',
      }).success,
    ).toBe(false);
    expect(
      mrPlanPriceSchema.safeParse({
        ...base,
        price: null,
        source_confidence: 'needs_login_recheck',
      }).success,
    ).toBe(true);
  });

  it("周期价 priceStatus='known' iff price 非 NULL + official confidence", () => {
    expect(getMrPlanPriceStatus({ price: '468.00', source_confidence: 'official_pricing' })).toBe('known');
    expect(getMrPlanPriceStatus({ price: '468.00', source_confidence: 'official_community' })).toBe('unknown');
    expect(getMrPlanPriceStatus({ price: null, source_confidence: 'official_doc' })).toBe('unknown');
  });
});

describe('5c review FIX1：价格金额校验（贴合 numeric(12,2)）', () => {
  it.each(['20.00', 40, 0, '0', '40', '40.00', '999.99', '1234567.89', 1234567.89, 8888888888.88, 9999999999.99])(
    '合法金额 %s 通过',
    (v) => {
      expect(mrPriceAmountSchema.safeParse(v).success).toBe(true);
    },
  );

  it.each([
    -1,
    '-0.01',
    NaN,
    Infinity,
    -Infinity,
    '20.555', // 3 位小数
    1e-3, // 科学计数法 number（=0.001，超 scale；字符串小数点判 scale 旧法会漏）
    1e-7, // 科学计数法 number（String() 无 `.`，旧法绕过 scale 闸）
    1e10, // 量级溢出 numeric(12,2)
    '', // 空串（Number('')→0 假阳）
    'free', // 非数值（Number('free')→NaN）
    '40CNY', // 带单位非数值（Number('40CNY')→NaN）
    '0x10', // JS 十六进制字面量（Number('0x10')→16 假阳）
    '0b101', // JS 二进制字面量（Number('0b101')→5 假阳）
    '0o12', // JS 八进制字面量（Number('0o12')→10 假阳）
    'Infinity', // 字符串 Infinity（Number→Infinity）
    'NaN', // 字符串 NaN
    '1.2.3', // 多小数点非十进制字面量
  ])('非法金额 %s 被拒', (v) => {
    expect(mrPriceAmountSchema.safeParse(v).success).toBe(false);
  });

  it.each([-1, NaN, Infinity, '20.555', 1e10])(
    'mrPlanWriteValidator 官方 confidence 带非法价 %s 被拒（叠加金额校验）',
    (price) => {
      expect(
        mrPlanWriteValidator.safeParse({
          category: 'coding_plan',
          currentPrice: price,
          currency: 'CNY',
          sourceConfidence: 'official_pricing',
        }).success,
      ).toBe(false);
    },
  );

  it('mrPlanWriteValidator 合法官方价仍通过；NULL 占位不受金额闸影响', () => {
    expect(
      mrPlanWriteValidator.safeParse({
        category: 'coding_plan',
        currentPrice: '40.00',
        currency: 'CNY',
        sourceConfidence: 'official_pricing',
      }).success,
    ).toBe(true);
    expect(
      mrPlanWriteValidator.safeParse({
        category: 'coding_plan',
        currentPrice: null,
        currency: null,
        sourceConfidence: 'needs_login_recheck',
      }).success,
    ).toBe(true);
  });
});

describe('5c review FIX2：source_url 非空校验（防快照 fail-closed）', () => {
  it('空串 / 纯空白 source_url 被拒，非空 URL 通过', () => {
    expect(mrSourceUrlSchema.safeParse('').success).toBe(false);
    expect(mrSourceUrlSchema.safeParse('   ').success).toBe(false); // 纯空白（旧 min(1) 会放行）
    expect(mrSourceUrlSchema.safeParse('https://example.com/pricing').success).toBe(true);
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
