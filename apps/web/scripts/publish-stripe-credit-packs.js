require('dotenv').config();

const Stripe = require('stripe');
const { loadConfig } = require('../src/config/env');
const { createPrismaClient } = require('../src/storage/prisma-client');
const { PrismaPaymentRepository } = require('../src/storage/prisma-payment.repository');
const { PrismaAdminRepository } = require('../src/storage/prisma-admin.repository');
const { AppError } = require('../src/errors');

// Mirrors payments.publishCreditPack's validation (src/services/payment.service.js) so this
// one-off script enforces the exact same Stripe Price/pack consistency checks the admin HTTP
// route would, without requiring a real admin browser session in this dev environment.
async function publishPack({ stripe, paymentRepository, adminRepository, actorUserId, packId, stripePriceId, activeFrom }) {
  const [pack, price] = await Promise.all([paymentRepository.findPack(packId), stripe.prices.retrieve(stripePriceId)]);
  if (!pack || pack.status !== 'draft') throw new AppError('CREDIT_PACK_NOT_DRAFT', 'Only a draft credit pack can be published', { status: 409 });
  if (!price.active || price.recurring || BigInt(price.unit_amount ?? -1) !== pack.unitAmount || String(price.currency || '').toUpperCase() !== pack.currency || String(price.tax_behavior || 'unspecified') !== pack.taxBehavior) {
    throw new AppError('STRIPE_PRICE_MISMATCH', 'Stripe Price currency, amount, tax behavior, or one-time status does not match this pack', { status: 409 });
  }
  const published = await paymentRepository.publishPack(packId, { stripePriceId: price.id, activeFrom });
  if (adminRepository && actorUserId) {
    await adminRepository.recordAudit({
      actorUserId, action: 'credit_pack.published', targetType: 'credit_pack', targetId: published.id,
      after: { stripePriceId: published.stripePriceId, activeFrom: published.activeFrom },
      reason: 'Published via scripts/publish-stripe-credit-packs.js at operator request (session did not have an admin browser cookie available).',
    });
  }
  return published;
}

async function main() {
  const [packId, stripePriceId] = process.argv.slice(2);
  if (!packId || !stripePriceId) throw new Error('Usage: node scripts/publish-stripe-credit-packs.js <packId> <stripePriceId>');
  const config = loadConfig();
  if (!config.payments.stripeSecretKey) throw new Error('STRIPE_SECRET_KEY is required');
  const stripe = new Stripe(config.payments.stripeSecretKey, { maxNetworkRetries: 2 });
  const prisma = createPrismaClient(config.env.DATABASE_URL);
  const actorUserId = String(config.env.ADMIN_OWNER_IDS || '').split(',').map((v) => v.trim()).filter(Boolean)[0] || null;
  try {
    const paymentRepository = new PrismaPaymentRepository(prisma);
    const adminRepository = new PrismaAdminRepository(prisma);
    const pack = await publishPack({ stripe, paymentRepository, adminRepository, actorUserId, packId, stripePriceId, activeFrom: new Date() });
    console.log(`published ${pack.code} v${pack.version}: status=${pack.status} stripePriceId=${pack.stripePriceId} (audit actor: ${actorUserId || 'none'})`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
