const MILLION = 1_000_000n;
const BASIS_POINTS = 10_000n;
const CREDIT_MICROS = 1_000_000n;

function integer(value, label) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  throw new Error(`${label} must be an integer`);
}

function nonnegative(value, label) {
  const parsed = integer(value ?? 0, label);
  if (parsed < 0n) throw new Error(`${label} cannot be negative`);
  return parsed;
}

function divideRoundHalfUp(numerator, denominator) {
  if (denominator <= 0n) throw new Error('denominator must be positive');
  return (numerator + (denominator / 2n)) / denominator;
}

function divideCeil(numerator, denominator) {
  if (denominator <= 0n) throw new Error('denominator must be positive');
  return numerator === 0n ? 0n : ((numerator - 1n) / denominator) + 1n;
}

function calculateProviderCost(rateCard, usage = {}) {
  if (rateCard?.type === 'token_components') {
    let numerator = 0n;
    const lines = [];
    for (const component of rateCard.components || []) {
      const rawUnits = nonnegative(usage[component.usageKey], component.usageKey);
      const subtraction = component.subtractUsageKey ? nonnegative(usage[component.subtractUsageKey], component.subtractUsageKey) : 0n;
      const units = rawUnits > subtraction ? rawUnits - subtraction : 0n;
      const rate = nonnegative(component.nanoUsdPerMillion, 'nanoUsdPerMillion');
      numerator += units * rate;
      lines.push({ usageKey: component.usageKey, subtractUsageKey: component.subtractUsageKey || null, units: units.toString(), nanoUsdPerMillion: rate.toString() });
    }
    return { nanoUsd: divideRoundHalfUp(numerator, MILLION), calculation: { type: rateCard.type, denominator: MILLION.toString(), components: lines } };
  }
  if (rateCard?.type === 'linear_steps') {
    const units = nonnegative(usage[rateCard.usageKey], rateCard.usageKey);
    const quantity = rateCard.quantityKey ? nonnegative(usage[rateCard.quantityKey], rateCard.quantityKey) : 1n;
    const baseNanoUsd = nonnegative(rateCard.baseNanoUsd, 'baseNanoUsd');
    const baseUnits = nonnegative(rateCard.baseUnits, 'baseUnits');
    if (baseUnits === 0n) throw new Error('baseUnits must be positive');
    return {
      nanoUsd: divideRoundHalfUp(baseNanoUsd * units * quantity, baseUnits),
      calculation: { type: rateCard.type, usageKey: rateCard.usageKey, units: units.toString(), quantityKey: rateCard.quantityKey || null, quantity: quantity.toString(), baseNanoUsd: baseNanoUsd.toString(), baseUnits: baseUnits.toString() },
    };
  }
  if (rateCard?.type === 'flat') {
    const quantity = rateCard.quantityKey ? nonnegative(usage[rateCard.quantityKey], rateCard.quantityKey) : 1n;
    const nanoUsdPerUnit = nonnegative(rateCard.nanoUsdPerUnit, 'nanoUsdPerUnit');
    return { nanoUsd: nanoUsdPerUnit * quantity, calculation: { type: rateCard.type, quantity: quantity.toString(), nanoUsdPerUnit: nanoUsdPerUnit.toString() } };
  }
  throw new Error(`Unsupported rate card type: ${rateCard?.type || 'missing'}`);
}

function applyMarkup(providerNanoUsd, policy) {
  const cost = nonnegative(providerNanoUsd, 'providerNanoUsd');
  const bps = nonnegative(policy.markupBasisPoints, 'markupBasisPoints');
  const fixed = nonnegative(policy.fixedNanoUsd, 'fixedNanoUsd');
  return divideRoundHalfUp(cost * (BASIS_POINTS + bps), BASIS_POINTS) + fixed;
}

function convertNanoUsdToCreditMicros(customerNanoUsd, rate) {
  const nanoUsd = nonnegative(customerNanoUsd, 'customerNanoUsd');
  const nanoUsdPerSiteCredit = nonnegative(rate.nanoUsdPerSiteCredit, 'nanoUsdPerSiteCredit');
  if (nanoUsdPerSiteCredit === 0n) throw new Error('nanoUsdPerSiteCredit must be positive');
  return divideCeil(nanoUsd * CREDIT_MICROS, nanoUsdPerSiteCredit);
}

module.exports = { applyMarkup, calculateProviderCost, convertNanoUsdToCreditMicros };
