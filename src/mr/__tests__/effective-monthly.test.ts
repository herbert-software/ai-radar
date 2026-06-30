import { describe, expect, it } from 'vitest';
import { effectiveMonthly } from '../effective-monthly.js';

describe('effectiveMonthly', () => {
  it('折算季度和年度周期价', () => {
    expect(effectiveMonthly('120.00', 'quarterly', 'known')).toBe(40);
    expect(effectiveMonthly('468.00', 'annual', 'known')).toBe(39);
  });

  it("period priceStatus!='known' 时返回 null，防 Number(null) 产生 phantom zero", () => {
    expect(effectiveMonthly(null, 'annual', 'unknown')).toBeNull();
    expect(effectiveMonthly('468.00', 'annual', 'unknown')).toBeNull();
  });

  it('known 但 price 为 null 时仍 fail closed 为 null', () => {
    expect(effectiveMonthly(null, 'quarterly', 'known')).toBeNull();
  });
});
