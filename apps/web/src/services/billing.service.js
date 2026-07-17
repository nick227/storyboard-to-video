const { applyMarkup, calculateProviderCost, convertNanoUsdToCreditMicros } = require('../billing/calculator');

function createBillingService({ repository, chargingEnabled = false }) {
  if (!repository) return null;

  async function reserve(request, metadata) {
    const [price, markup, creditRate] = await Promise.all([
      repository.findActivePrice(metadata), repository.activeMarkup(), repository.activeCreditRate(),
    ]);
    const estimatedProviderNanoUsd = price?.reservationNanoUsd || 0n;
    const estimatedCustomerNanoUsd = price && markup ? applyMarkup(estimatedProviderNanoUsd, markup) : 0n;
    const quotedCreditMicros = creditRate ? convertNanoUsdToCreditMicros(estimatedCustomerNanoUsd, creditRate) : 0n;
    const live = Boolean(chargingEnabled && price?.billable && markup && creditRate);
    const chargingMode = live ? 'live'
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
    const reservation = live ? await repository.createLiveReservation(data) : await repository.createMonitoringReservation(data);
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

  return {
    chargingEnabled: Boolean(chargingEnabled),
    reserve,
    settle,
    release: (request, error) => repository.release(request.id, error?.code || error?.message || 'provider_failed'),
    markSettlementPending: (request, error) => repository.markSettlementPending(request.id, error),
  };
}

module.exports = { createBillingService };
