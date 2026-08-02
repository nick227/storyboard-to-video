require('dotenv').config();

// One-off repair for scripts whose slug is still an auto-placeholder (untitled, untitled-4, ...)
// even though the project was renamed before the resync-on-rename fix existed (see
// PrismaScriptRepository#update / ScriptStore#update). Reuses the real repository `update()` path
// -- including its collision-safe allocateSlug -- so this produces exactly the slug the app would
// have assigned had the fix been in place, instead of reimplementing that logic here.
const { loadConfig } = require('../src/config/env');
const { createPrismaClient } = require('../src/storage/prisma-client');
const { PrismaScriptRepository } = require('../src/storage/prisma-script.repository');
const { isPlaceholderSlug, slugify } = require('../src/shared/text');

function parseArgs(argv) {
  const args = { apply: false };
  for (const arg of argv) {
    if (arg === '--apply') args.apply = true;
    else throw new Error(`Unknown arg: ${arg}\nUsage: node scripts/backfill-placeholder-script-slugs.js [--apply]`);
  }
  return args;
}

class DryRunRollback extends Error {}

async function findStaleRows(prisma) {
  const rows = await prisma.script.findMany({ select: { id: true, tenantId: true, title: true, slug: true } });
  return rows
    .filter((row) => isPlaceholderSlug(row.slug) && !isPlaceholderSlug(slugify(row.title)))
    // Stable order so re-running the (still-pending) dry run reports the same plan each time.
    .sort((a, b) => a.slug.localeCompare(b.slug) || a.id.localeCompare(b.id));
}

// Runs the resync through the real repository update() inside `tx`, so allocateSlug's collision
// suffixing sees each prior row's new slug already committed within the transaction -- the same
// guarantee the live app gets from calling update() once per request.
async function resyncRows(tx, rows) {
  const repo = new PrismaScriptRepository(tx);
  const results = [];
  for (const row of rows) {
    const updated = await repo.update(row.id, { title: row.title }, { tenantId: row.tenantId });
    results.push({ id: row.id, title: row.title, before: row.slug, after: updated.slug });
  }
  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const prisma = createPrismaClient(config.env.DATABASE_URL);

  try {
    const stale = await findStaleRows(prisma);
    if (!stale.length) {
      console.log('No stale placeholder slugs found.');
      return;
    }

    let results;
    if (args.apply) {
      results = await prisma.$transaction((tx) => resyncRows(tx, stale));
    } else {
      try {
        await prisma.$transaction(async (tx) => {
          results = await resyncRows(tx, stale);
          throw new DryRunRollback();
        });
      } catch (error) {
        if (!(error instanceof DryRunRollback)) throw error;
      }
    }

    console.log(JSON.stringify({ mode: args.apply ? 'apply' : 'dry-run', count: results.length, results }, null, 2));
    if (!args.apply) console.error('\nDry run only (rolled back). Re-run with --apply to write changes.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
