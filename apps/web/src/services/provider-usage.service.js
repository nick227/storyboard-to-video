const { outputMetadata } = require('../providers/result');

function createProviderUsageService({ repository, generationContext, billing = null }) {
  return {
    async execute(metadata, operation) {
      const context = generationContext.getStore();
      if (!repository || !context?.trace) return operation();
      context.providerSequence = (context.providerSequence || 0) + 1;
      const request = await repository.begin(context.trace, { ...metadata, sequence: context.providerSequence });
      let billingQuote;
      try {
        billingQuote = billing ? await billing.reserve(request, metadata) : null;
      } catch (error) {
        await repository.fail(request, error);
        throw error;
      }
      let result;
      try { result = await operation(); }
      catch (error) {
        await repository.fail(request, error);
        if (billingQuote) await billing.release(request, error);
        throw error;
      }
      const event = await repository.complete(request, result, outputMetadata(result.output));
      if (billingQuote) {
        try { await billing.settle(billingQuote, request, event, result); }
        catch (error) {
          await billing.markSettlementPending(request, error);
          console.error(`Billing settlement pending for generation request ${request.id}: ${error.message}`);
        }
      }
      return result;
    },
  };
}

module.exports = { createProviderUsageService };
