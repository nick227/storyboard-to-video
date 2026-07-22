const { AppError } = require('../errors');
const crypto = require('node:crypto');

function objectId(value) { return typeof value === 'string' ? value : value?.id || null; }
function integrationIdentifier() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz';
  return `storyframe_${Array.from(crypto.randomBytes(8), (byte) => alphabet[byte % alphabet.length]).join('')}`;
}

function createPaymentService({ repository, stripe, webhookSecret, publicAppUrl, providerAdmission }) {
  function requireStripe() {
    if (!stripe || !webhookSecret) throw new AppError('PAYMENTS_UNAVAILABLE', 'Stripe payments and webhook verification must both be configured', { status: 503 });
  }
  function stripeCall(operation) { return providerAdmission ? providerAdmission.run('stripe', operation) : operation(); }

  return {
    enabled: Boolean(stripe && webhookSecret),

    async publishCreditPack({ packId, stripePriceId, activeFrom }) {
      requireStripe();
      const [pack, price] = await Promise.all([repository.findPack(packId), stripeCall(() => stripe.prices.retrieve(stripePriceId))]);
      if (!pack || pack.status !== 'draft') throw new AppError('CREDIT_PACK_NOT_DRAFT', 'Only a draft credit pack can be published', { status: 409 });
      if (!price.active || price.recurring || BigInt(price.unit_amount ?? -1) !== pack.unitAmount || String(price.currency || '').toUpperCase() !== pack.currency || String(price.tax_behavior || 'unspecified') !== pack.taxBehavior) {
        throw new AppError('STRIPE_PRICE_MISMATCH', 'Stripe Price currency, amount, tax behavior, or one-time status does not match this pack', { status: 409 });
      }
      return repository.publishPack(packId, { stripePriceId: price.id, activeFrom });
    },

    async createCheckout({ amount, tenantId, userId, userEmail, idempotencyKey }) {
      requireStripe();
      const prepared = await repository.prepareCheckout({ amount: BigInt(amount), tenantId, userId, idempotencyKey });
      if (prepared.attempt.checkoutUrl && prepared.attempt.processorCheckoutSessionId) {
        return { saleId: prepared.sale.id, checkoutSessionId: prepared.attempt.processorCheckoutSessionId, url: prepared.attempt.checkoutUrl, reused: true };
      }
      const base = String(publicAppUrl || '').replace(/\/+$/, '');
      if (!/^https?:\/\//.test(base)) throw new AppError('PAYMENT_URL_NOT_CONFIGURED', 'PUBLIC_APP_URL must be an absolute HTTP(S) URL', { status: 503 });
      try {
        const customer = prepared.paymentCustomer?.processorCustomerId;
        const session = await stripeCall(() => stripe.checkout.sessions.create({
          mode: 'payment',
          integration_identifier: integrationIdentifier(),
          client_reference_id: prepared.sale.id,
          line_items: [{
            price_data: {
              currency: prepared.sale.currency.toLowerCase(),
              unit_amount: Number(prepared.sale.subtotalAmount),
              product_data: { name: 'Storyframe credits' },
            },
            quantity: 1,
          }],
          // automatic_tax requires a head-office address and per-jurisdiction registrations on the
          // Stripe account (dashboard > Tax); without them Stripe hard-rejects session creation, and
          // even set up, it silently collects $0 in any unregistered jurisdiction. Leave this off
          // until the account has real registrations — enabling it is a deliberate business/tax call.
          ...(customer ? { customer } : { customer_email: userEmail, customer_creation: 'always' }),
          success_url: `${base}/credits.html?checkout=success&saleId=${prepared.sale.id}&session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${base}/credits.html?checkout=canceled&saleId=${prepared.sale.id}`,
          metadata: { saleId: prepared.sale.id, tenantId, userId },
          payment_intent_data: { metadata: { saleId: prepared.sale.id, tenantId, userId } },
        }, { idempotencyKey: `checkout:${prepared.attempt.id}` }));
        await repository.markCheckoutCreated({ attemptId: prepared.attempt.id, session });
        return { saleId: prepared.sale.id, checkoutSessionId: session.id, url: session.url, reused: prepared.reused };
      } catch (error) {
        await repository.markCheckoutFailed(prepared.attempt.id, error).catch(() => {});
        throw error;
      }
    },

    constructWebhookEvent(rawBody, signature) {
      requireStripe();
      if (!webhookSecret) throw new AppError('STRIPE_WEBHOOK_NOT_CONFIGURED', 'Stripe webhook verification is not configured', { status: 503 });
      try { return stripe.webhooks.constructEvent(rawBody, signature, webhookSecret); }
      catch (error) { throw new AppError('INVALID_STRIPE_SIGNATURE', 'Stripe webhook signature verification failed', { status: 400, cause: error }); }
    },

    async processWebhook(stripeEvent) {
      const object = stripeEvent.data?.object || {};
      const trackObject = stripeEvent.type.startsWith('refund.') ? objectId(object) : null;
      const received = await repository.receiveEvent({
        processorEventId: stripeEvent.id, processorObjectId: trackObject, type: stripeEvent.type, payload: stripeEvent,
      });
      if (received.duplicate && ['processed', 'ignored'].includes(received.event.status)) return { duplicate: true, status: received.event.status };
      try {
        if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(stripeEvent.type)) {
          return await repository.fundCheckout(received.event.id, object);
        }
        if (stripeEvent.type === 'checkout.session.expired') return repository.expireCheckout(received.event.id, object);
        if (stripeEvent.type === 'refund.created') return repository.applyRefund(received.event.id, object);
        if (stripeEvent.type === 'charge.dispute.created') return repository.markDisputed(received.event.id, object);
        await repository.ignoreEvent(received.event.id);
        return { ignored: true };
      } catch (error) {
        await repository.failEvent(received.event.id, error).catch(() => {});
        throw error;
      }
    },

    async refundSale({ saleId, amount, reason, idempotencyKey }) {
      requireStripe();
      const checked = await repository.assertRefundable(saleId, amount);
      if (checked.amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new AppError('REFUND_AMOUNT_TOO_LARGE', 'Refund amount exceeds the supported processor range', { status: 400 });
      const refund = await stripeCall(() => stripe.refunds.create({
        payment_intent: checked.sale.processorPaymentIntentId,
        amount: Number(checked.amount),
        reason: reason || 'requested_by_customer',
        metadata: { saleId: checked.sale.id, tenantId: checked.sale.tenantId },
      }, { idempotencyKey: `refund:${idempotencyKey}` }));
      const received = await repository.receiveEvent({
        processorEventId: `admin:${refund.id}`, processorObjectId: refund.id, type: 'refund.created', payload: refund,
      });
      const sale = await repository.applyRefund(received.event.id, refund);
      return { refund, sale, duplicate: received.duplicate };
    },
  };
}

module.exports = { createPaymentService };
