require('dotenv').config();

// One-off backfill for Asset rows committed by POST /stock/select before the provenance columns
// existed (source/provider/license*). Those rows are identifiable only by the `stock-pixabay-`
// filename prefix used at commit time -- sourceId/sourcePageUrl/creator are not recoverable from
// that, only the fields Pixabay license terms are constant across every asset.
const { loadConfig } = require('../src/config/env');
const { createPrismaClient } = require('../src/storage/prisma-client');

function parseArgs(argv) {
  const args = { apply: false };
  for (const arg of argv) {
    if (arg === '--apply') args.apply = true;
    else throw new Error(`Unknown arg: ${arg}\nUsage: node scripts/backfill-stock-pixabay-provenance.js [--apply]`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const prisma = createPrismaClient(config.env.DATABASE_URL);

  try {
    const candidates = await prisma.asset.findMany({
      where: { fileName: { startsWith: 'stock-pixabay-' }, source: null },
      select: { id: true, projectId: true, fileName: true, createdAt: true },
    });

    console.log(JSON.stringify({
      mode: args.apply ? 'apply' : 'dry-run',
      candidateCount: candidates.length,
      candidates,
    }, null, 2));

    if (!candidates.length) return;
    if (!args.apply) {
      console.error('\nDry run only. Re-run with --apply to write changes.');
      return;
    }

    const result = await prisma.asset.updateMany({
      where: { id: { in: candidates.map((row) => row.id) } },
      data: {
        source: 'stock_pixabay',
        provider: 'pixabay',
        licenseCode: 'pixabay',
        licenseUrl: 'https://pixabay.com/service/license/',
        commercialUseAllowed: true,
        // sourceId/sourcePageUrl/creator/attributionText intentionally left null -- not derivable
        // from the filename, genuinely lost for these pre-migration rows.
      },
    });
    console.log(`Backfilled ${result.count} asset row(s).`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
