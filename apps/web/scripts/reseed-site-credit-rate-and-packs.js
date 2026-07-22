require('dotenv').config();

const { loadConfig } = require('../src/config/env');
const { createPrismaClient } = require('../src/storage/prisma-client');
const { PrismaBillingRepository } = require('../src/storage/prisma-billing.repository');
const { PrismaPaymentRepository } = require('../src/storage/prisma-payment.repository');

const CREDIT_RATE_VERSION_KEY = 'one-credit-equals-one-usd-v1';
const NANO_USD_PER_SITE_CREDIT = 1_000_000_000n;

const RETIRE_PACK_CODES = ['starter', 'creator', 'studio'];

const NEW_PACKS = [
  { code: 'starter', version: 2, name: 'Starter', currency: 'USD', unitAmount: 1000n, creditsGrantedMicros: 10_000_000n },
  { code: 'creator', version: 2, name: 'Creator', currency: 'USD', unitAmount: 2500n, creditsGrantedMicros: 25_000_000n },
  { code: 'studio', version: 2, name: 'Studio', currency: 'USD', unitAmount: 10000n, creditsGrantedMicros: 100_000_000n },
];

async function ensureCreditRate(prisma, billingRepo) {
  let rate = await prisma.siteCreditRateVersion.findUnique({ where: { versionKey: CREDIT_RATE_VERSION_KEY } });
  if (!rate) {
    rate = await billingRepo.createCreditRateVersion({ versionKey: CREDIT_RATE_VERSION_KEY, nanoUsdPerSiteCredit: NANO_USD_PER_SITE_CREDIT, active: false });
    console.log(`created SiteCreditRateVersion ${rate.versionKey} (${rate.id})`);
  }
  if (!rate.active) {
    rate = await billingRepo.activateCreditRate(rate.id);
    console.log(`activated SiteCreditRateVersion ${rate.versionKey} (retires any prior active rate)`);
  } else {
    console.log(`SiteCreditRateVersion ${rate.versionKey} already active`);
  }
  return rate;
}

async function retireOldPacks(prisma, paymentRepo) {
  const oldPacks = await prisma.creditPack.findMany({ where: { code: { in: RETIRE_PACK_CODES }, version: 1 } });
  for (const pack of oldPacks) {
    if (pack.status === 'retired') { console.log(`pack ${pack.code} v${pack.version} already retired`); continue; }
    await paymentRepo.retirePack(pack.id);
    console.log(`retired pack ${pack.code} v${pack.version}`);
  }
}

async function createNewPacks(prisma, paymentRepo) {
  for (const input of NEW_PACKS) {
    const existing = await prisma.creditPack.findUnique({ where: { code_version: { code: input.code, version: input.version } } });
    if (existing) { console.log(`pack ${input.code} v${input.version} already exists, skipping`); continue; }
    const pack = await paymentRepo.createPack(input);
    console.log(`created draft pack ${pack.code} v${pack.version}: $${Number(pack.unitAmount) / 100} -> ${Number(pack.creditsGrantedMicros) / 1e6} credits`);
  }
}

async function main() {
  const config = loadConfig();
  if (!config.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const prisma = createPrismaClient(config.env.DATABASE_URL);
  try {
    const billingRepo = new PrismaBillingRepository(prisma);
    const paymentRepo = new PrismaPaymentRepository(prisma);
    await ensureCreditRate(prisma, billingRepo);
    await retireOldPacks(prisma, paymentRepo);
    await createNewPacks(prisma, paymentRepo);
    console.log('done');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
