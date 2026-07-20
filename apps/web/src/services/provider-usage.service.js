const { outputMetadata } = require('../providers/result');

function createProviderUsageService({ repository, generationContext, billing = null }) {
  async function begin(metadata) {
    const context = generationContext.getStore();
    if (!repository || !context?.trace) return null;
    context.providerSequence = (context.providerSequence || 0) + 1;
    const request = await repository.begin(context.trace, { ...metadata, sequence: context.providerSequence });
    try {
      const billingQuote = billing ? await billing.reserve(request, metadata) : null;
      return {
        request,
        billingQuote,
        references: {
          generationRequestId: request.id,
          creditReservationId: billingQuote?.reservation?.id || null,
          providerPriceVersionId: billingQuote?.price?.id || null,
        },
      };
    } catch (error) {
      await repository.fail(request, error);
      throw error;
    }
  }

  async function restore(handleOrId) {
    if (!handleOrId || !repository) return null;
    if (handleOrId.request) return handleOrId;
    const request = await repository.getRequest(typeof handleOrId === 'string' ? handleOrId : handleOrId.generationRequestId);
    if (!request) return null;
    return { request, billingQuote: billing ? await billing.restoreQuote(request) : null };
  }

  async function complete(handleOrId, result) {
    const handle = await restore(handleOrId);
    if (!handle) return result;
    const event = await repository.complete(handle.request, result, outputMetadata(result.output));
    if (handle.billingQuote) {
      try { await billing.settle(handle.billingQuote, handle.request, event, result); }
      catch (error) {
        await billing.markSettlementPending(handle.request, error);
        console.error(`Billing settlement pending for generation request ${handle.request.id}: ${error.message}`);
      }
    }
    return result;
  }

  async function fail(handleOrId, error) {
    const handle = await restore(handleOrId);
    if (!handle) return;
    await repository.fail(handle.request, error);
    if (handle.billingQuote) await billing.release(handle.request, error);
  }

  async function execute(metadata, operation) {
    const handle = await begin(metadata);
    let result;
    try { result = await operation(); }
    catch (error) { await fail(handle, error); throw error; }
    return complete(handle, result);
  }

  return { begin, complete, fail, execute, restore };
}

module.exports = { createProviderUsageService };
