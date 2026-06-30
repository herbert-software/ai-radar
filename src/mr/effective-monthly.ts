import type { MrBillingPeriod } from '../db/mr-schema.zod.js';

export type EffectiveMonthlyPriceStatus = 'known' | 'unknown';

const PERIOD_DIVISORS: Record<MrBillingPeriod, number> = {
  quarterly: 3,
  annual: 12,
};

/**
 * Deterministic display-only monthly equivalent for non-monthly subscription prices.
 * It is deliberately gated by priceStatus before numeric coercion, so NULL unknown prices
 * cannot become phantom zero via Number(null).
 */
export function effectiveMonthly(
  price: string | number | null,
  billingPeriod: MrBillingPeriod,
  priceStatus: EffectiveMonthlyPriceStatus,
): number | null {
  if (priceStatus !== 'known' || price === null) return null;

  const n = Number(price);
  if (!Number.isFinite(n)) {
    throw new Error(`effectiveMonthly: price must be finite, received ${String(price)}`);
  }

  return n / PERIOD_DIVISORS[billingPeriod];
}
