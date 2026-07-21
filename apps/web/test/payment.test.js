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
