const test = require('node:test');
const assert = require('node:assert/strict');
const Stripe = require('stripe');
const { createPaymentService } = require('../src/services/payment.service');

test('Stripe webhook verification accepts only a valid signature over the raw body', () => {
  const stripe = new Stripe('sk_test_placeholder');
  const secret = 'whsec_test_secret';
  const raw = JSON.stringify({ id: 'evt_signature_test', type: 'checkout.session.completed', data: { object: {} } });
  const signature = stripe.webhooks.generateTestHeaderString({ payload: raw, secret });
  const service = createPaymentService({ repository: {}, stripe, webhookSecret: secret, publicAppUrl: 'http://localhost:3000' });
  assert.equal(service.constructWebhookEvent(Buffer.from(raw), signature).id, 'evt_signature_test');
  assert.throws(() => service.constructWebhookEvent(Buffer.from(`${raw} `), signature), (error) => error.code === 'INVALID_STRIPE_SIGNATURE');
});

test('credit-pack publication verifies the immutable terms against Stripe', async () => {
  const pack = { id: 'pack-1', status: 'draft', unitAmount: 1000n, currency: 'USD', taxBehavior: 'exclusive' };
  let published = null;
  const repository = { findPack: async () => pack, publishPack: async (id, input) => { published = { id, ...input }; return published; } };
  const stripe = { prices: { retrieve: async () => ({ id: 'price_starter', active: true, recurring: null, unit_amount: 1000, currency: 'usd', tax_behavior: 'exclusive' }) } };
  const admitted = [];
  const providerAdmission = { run(provider, operation) { admitted.push(provider); return operation(); } };
  const service = createPaymentService({ repository, stripe, webhookSecret: 'whsec_test', publicAppUrl: 'http://localhost:3000', providerAdmission });
  const result = await service.publishCreditPack({ packId: pack.id, stripePriceId: 'price_starter', activeFrom: new Date('2026-01-01T00:00:00Z') });
  assert.equal(result.stripePriceId, 'price_starter'); assert.equal(published.id, pack.id);
  stripe.prices.retrieve = async () => ({ id: 'price_wrong', active: true, recurring: null, unit_amount: 999, currency: 'usd', tax_behavior: 'exclusive' });
  await assert.rejects(() => service.publishCreditPack({ packId: pack.id, stripePriceId: 'price_wrong' }), (error) => error.code === 'STRIPE_PRICE_MISMATCH');
  assert.deepEqual(admitted, ['stripe', 'stripe']);
});

test('amount checkout uses server-prepared dynamic pricing and tags the integration', async () => {
  let checkoutParams;
  const repository = {
    prepareCheckout: async ({ amount }) => ({
      attempt: { id: 'attempt-1' },
      sale: { id: 'sale-1', currency: 'USD', subtotalAmount: amount },
      paymentCustomer: null,
      reused: false,
    }),
    markCheckoutCreated: async () => {},
  };
  const stripe = { checkout: { sessions: { create: async (params) => {
    checkoutParams = params;
    return { id: 'cs_1', url: 'https://checkout.stripe.test/1' };
  } } } };
  const service = createPaymentService({ repository, stripe, webhookSecret: 'whsec_test', publicAppUrl: 'http://localhost:3000' });
  await service.createCheckout({ amount: 1234, tenantId: 'tenant-1', userId: 'user-1', userEmail: 'user@example.com', idempotencyKey: 'key-1' });
  assert.equal(checkoutParams.line_items[0].price_data.unit_amount, 1234);
  assert.equal(checkoutParams.line_items[0].price_data.currency, 'usd');
  assert.equal(checkoutParams.line_items[0].price_data.product_data.name, 'Storyboarder credits');
  assert.match(checkoutParams.integration_identifier, /^Storyboarder_[a-z]{8}$/);
  assert.equal('payment_method_types' in checkoutParams, false);
  assert.equal('automatic_tax' in checkoutParams, false);
});

test('checkWebhookHealth reports no endpoint found when Stripe has none matching this app\'s real URL', async () => {
  const stripe = { webhookEndpoints: { list: async () => ({ data: [] }) } };
  const service = createPaymentService({ repository: {}, stripe, webhookSecret: 'whsec_test', publicAppUrl: 'https://storyboard-to-video.up.railway.app' });
  const health = await service.checkWebhookHealth();
  assert.equal(health.endpointFound, false);
  assert.equal(health.webhookUrl, 'https://storyboard-to-video.up.railway.app/api/webhooks/stripe');
  assert.deepEqual(health.missingEvents, ['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.expired', 'refund.created', 'charge.dispute.created']);
});

test('checkWebhookHealth finds a real, enabled endpoint and reports any missing event subscriptions', async () => {
  const stripe = { webhookEndpoints: { list: async () => ({ data: [
    { id: 'we_1', url: 'https://storyboard-to-video.up.railway.app/api/webhooks/stripe', status: 'enabled', enabled_events: ['checkout.session.completed', 'refund.created'] },
  ] }) } };
  const service = createPaymentService({ repository: {}, stripe, webhookSecret: 'whsec_test', publicAppUrl: 'https://storyboard-to-video.up.railway.app' });
  const health = await service.checkWebhookHealth();
  assert.equal(health.endpointFound, true);
  assert.equal(health.endpointId, 'we_1');
  assert.deepEqual(health.missingEvents, ['checkout.session.async_payment_succeeded', 'checkout.session.expired', 'charge.dispute.created']);
});

test('checkWebhookHealth ignores a disabled endpoint even if the URL matches', async () => {
  const stripe = { webhookEndpoints: { list: async () => ({ data: [
    { id: 'we_2', url: 'https://storyboard-to-video.up.railway.app/api/webhooks/stripe', status: 'disabled', enabled_events: ['*'] },
  ] }) } };
  const service = createPaymentService({ repository: {}, stripe, webhookSecret: 'whsec_test', publicAppUrl: 'https://storyboard-to-video.up.railway.app' });
  const health = await service.checkWebhookHealth();
  assert.equal(health.endpointFound, false);
});

test('checkWebhookHealth reports not configured when Stripe is not wired up at all', async () => {
  const service = createPaymentService({ repository: {}, stripe: null, webhookSecret: '', publicAppUrl: 'https://storyboard-to-video.up.railway.app' });
  const health = await service.checkWebhookHealth();
  assert.equal(health.configured, false);
  assert.equal(health.secretConfigured, false);
  assert.equal(health.endpointFound, false);
});
