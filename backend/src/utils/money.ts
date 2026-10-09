/**
 * All money is integer minor units (paise for INR). Never use floats for money.
 */

export interface Pricing {
  subtotalMinor: number;
  deliveryFeeMinor: number;
  taxMinor: number;
  discountMinor: number;
  totalMinor: number;
  currency: 'INR';
}

/** Tax is computed in basis points (1/100 of a percent) on the subtotal, rounded half-up. */
export function computeTaxMinor(subtotalMinor: number, taxBps: number): number {
  return Math.floor((subtotalMinor * taxBps + 5000) / 10000);
}

export function buildPricing(input: {
  subtotalMinor: number;
  deliveryFeeMinor: number;
  taxBps: number;
}): Pricing {
  const taxMinor = computeTaxMinor(input.subtotalMinor, input.taxBps);
  const discountMinor = 0; // Coupons are not implemented yet; discounts must be computed server-side when added.
  const totalMinor = input.subtotalMinor + input.deliveryFeeMinor + taxMinor - discountMinor;
  if (totalMinor < 0) throw new Error('Computed total is negative');
  return {
    subtotalMinor: input.subtotalMinor,
    deliveryFeeMinor: input.deliveryFeeMinor,
    taxMinor,
    discountMinor,
    totalMinor,
    currency: 'INR',
  };
}
