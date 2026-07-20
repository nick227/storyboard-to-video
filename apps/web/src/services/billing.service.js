const { applyMarkup, calculateProviderCost, convertNanoUsdToCreditMicros } = require('../billing/calculator');

function createBillingService({ repository, chargingEnabled = false }) {
  if (!repository) return null;

  async function quote(metadata) {
    const [price, markup, creditRate] = await Promise.all([
      repository.findActivePrice(metadata), repository.activeMarkup(), repository.activeCreditRate(),
    ]);
    let estimatedProviderNanoUsd = price?.reservationNanoUsd || 0n;
    let calculation = null;
    if (price && metadata?.estimatedUsage && (price.rateCard?.type === 'matrix' || metadata.estimatedUsageComplete === true)) {
      const estimate = calculateProviderCost(price.rateCard, metadata.estimatedUsage);
      // The static reservation remains a safety floor for prompt/reference usage that cannot be
      // known before the provider call; the resolved-output calculation raises it when the chosen
      // size/quality/duration is more expensive.
      estimatedProviderNanoUsd = estimate.nanoUsd > estimatedProviderNanoUsd ? estimate.nanoUsd : estimatedProviderNanoUsd;
      calculation = estimate.calculation;
    }
    const estimatedCustomerNanoUsd = price && markup ? applyMarkup(estimatedProviderNanoUsd, markup) : estimatedProviderNanoUsd;
    const quotedCreditMicros = creditRate ? convertNanoUsdToCreditMicros(estimatedCustomerNanoUsd, creditRate) : 0n;
    return { price, markup, creditRate, estimatedProviderNanoUsd, estimatedCustomerNanoUsd, quotedCreditMicros, calculation };
  }

  async function reserve(request, metadata) {
    const quoted = await quote(metadata);
    const { price, markup, creditRate, estimatedProviderNanoUsd, quotedCreditMicros } = quoted;
    const liveEligible = Boolean(chargingEnabled && price?.billable && markup && creditRate);
    const chargingMode = liveEligible ? 'live'
      : !chargingEnabled ? 'charging_disabled'
        : !price ? 'no_active_price'
          : !price.billable ? 'provider_not_billable'
            : 'billing_configuration_incomplete';
    const data = {
      generationRequestId: request.id, tenantId: request.tenantId, userId: request.userId,
      providerPriceVersionId: price?.id || null, markupPolicyVersionId: markup?.id || null,
      siteCreditRateVersionId: creditRate?.id || null, chargingMode,
      estimatedProviderNanoUsd, quotedCreditMicros,
    };
    const reservation = liveEligible ? await repository.createLiveReservation(data) : await repository.createMonitoringReservation(data);
    const live = reservation.chargingMode === 'live';
    return { reservation, price, markup, creditRate, live };
  }

  async function settle(quote, request, event, result) {
    if (!quote?.price) return repository.completeWithoutCost(request.id);
    if (quote.live && !['observed', 'estimated'].includes(result.measurementStatus)) {
      return repository.release(request.id, 'usage_not_validated');
    }
    const cost = calculateProviderCost(quote.price.rateCard, result.usage);
    const customerNanoUsd = quote.markup ? applyMarkup(cost.nanoUsd, quote.markup) : cost.nanoUsd;
    const finalCreditMicros = quote.creditRate ? convertNanoUsdToCreditMicros(customerNanoUsd, quote.creditRate) : 0n;
    return repository.settle({
      reservationId: quote.reservation.id, generationRequestId: request.id, usageEventId: event.id,
      price: quote.price, usage: result.usage, providerCostNanoUsd: cost.nanoUsd,
      calculation: cost.calculation, customerNanoUsd, finalCreditMicros,
    });
  }

  async function restoreQuote(request) {
    const reservation = await repository.reservationQuote(request.id);
    if (!reservation) return null;
    return {
      reservation,
      price: reservation.providerPriceVersion,
      markup: reservation.markupPolicyVersion,
      creditRate: reservation.siteCreditRateVersion,
      live: reservation.chargingMode === 'live',
    };
  }

  return {
    chargingEnabled: Boolean(chargingEnabled),
    quote,
    reserve,
    restoreQuote,
    settle,
    release: (request, error) => repository.release(request.id, error?.code || error?.message || 'provider_failed'),
    markSettlementPending: (request, error) => repository.markSettlementPending(request.id, error),
  };
}

module.exports = { createBillingService };
