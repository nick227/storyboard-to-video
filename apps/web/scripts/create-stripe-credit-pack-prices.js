require('dotenv').config();

const Stripe = require('stripe');
const { loadConfig } = require('../src/config/env');
const { createPrismaClient } = require('../src/storage/prisma-client');

async function main() {
  const config = loadConfig();
  if (!config.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  if (!config.payments.stripeSecretKey) throw new Error('STRIPE_SECRET_KEY is required');
  const stripe = new Stripe(config.payments.stripeSecretKey, { maxNetworkRetries: 2 });
  const prisma = createPrismaClient(config.env.DATABASE_URL);
  try {
    const packs = await prisma.creditPack.findMany({ where: { status: 'draft', stripePriceId: null } });
    if (!packs.length) {
      console.log('No draft packs without a Stripe Price ID were found.');
      return;
    }
    for (const pack of packs) {
      const product = await stripe.products.create({
        name: `${pack.name} credit pack`,
        metadata: { creditPackId: pack.id, code: pack.code, version: String(pack.version) },
      }, { idempotencyKey: `credit-pack-product:${pack.id}` });
      const price = await stripe.prices.create({
        product: product.id,
        currency: pack.currency.toLowerCase(),
        unit_amount: Number(pack.unitAmount),
        tax_behavior: pack.taxBehavior,
        metadata: { creditPackId: pack.id, code: pack.code, version: String(pack.version) },
      }, { idempotencyKey: `credit-pack-price:${pack.id}` });
      console.log(`${pack.code} v${pack.version} (${pack.id}) -> stripePriceId ${price.id}`);
    }
    console.log('\nNext: publish each pack (this does not happen automatically) via');
    console.log('PATCH /api/admin/credit-packs/:packId/publish { stripePriceId, activeFrom } as a platform admin.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
