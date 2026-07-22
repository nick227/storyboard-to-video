require('dotenv').config();

const crypto = require('node:crypto');
const Stripe = require('stripe');
const { loadConfig } = require('../src/config/env');
const { createPrismaClient } = require('../src/storage/prisma-client');
const { PrismaPaymentRepository } = require('../src/storage/prisma-payment.repository');
const { PrismaAdminRepository } = require('../src/storage/prisma-admin.repository');
const { createPaymentService } = require('../src/services/payment.service');

// Mirrors POST /api/admin/sales/:saleId/refund (src/routes/admin.routes.js), which just calls
// payments.refundSale then records an audit event -- reused here directly since no admin browser
// session is available in this environment.
async function main() {
  const [saleId] = process.argv.slice(2);
  if (!saleId) throw new Error('Usage: node scripts/refund-credit-sale.js <saleId>');
  const config = loadConfig();
  if (!config.payments.stripeSecretKey || !config.payments.stripeWebhookSecret) throw new Error('Stripe must be configured');
  const stripe = new Stripe(config.payments.stripeSecretKey, { maxNetworkRetries: 2 });
  const prisma = createPrismaClient(config.env.DATABASE_URL);
  const actorUserId = String(config.env.ADMIN_OWNER_IDS || '').split(',').map((v) => v.trim()).filter(Boolean)[0] || null;
  try {
    const paymentRepository = new PrismaPaymentRepository(prisma);
    const adminRepository = new PrismaAdminRepository(prisma);
    const payments = createPaymentService({ repository: paymentRepository, stripe, webhookSecret: config.payments.stripeWebhookSecret, publicAppUrl: config.payments.publicAppUrl });
    const idempotencyKey = crypto.randomUUID();
    const result = await payments.refundSale({ saleId, reason: 'requested_by_customer', idempotencyKey });
    await adminRepository.recordAudit({
      actorUserId, tenantId: result.sale.tenantId, action: 'sale.refunded', targetType: 'credit_sale', targetId: result.sale.id,
      reason: 'requested_by_customer (via scripts/refund-credit-sale.js, no admin browser session available)',
      after: { processorRefundId: result.refund.id, amount: result.refund.amount, status: result.sale.status },
    });
    console.log(JSON.stringify({ saleStatus: result.sale.status, refundedAmount: result.sale.refundedAmount?.toString(), creditsReversed: result.sale.creditsReversed?.toString(), stripeRefundId: result.refund.id }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
