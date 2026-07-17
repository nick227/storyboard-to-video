require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadConfig } = require('../src/config/env');
const { createPrismaClient } = require('../src/storage/prisma-client');
const { PrismaIdentityRepository } = require('../src/storage/prisma-identity.repository');
const { PrismaProjectRepository } = require('../src/storage/prisma-project.repository');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function resolveIdentity(prisma, identity, document) {
  const tenantValue = String(document.tenantId || document.ownerId || 'local-user');
  const userValue = String(document.createdByUserId || document.ownerId || tenantValue);
  if (UUID.test(tenantValue) && UUID.test(userValue)) {
    const [tenant, user] = await Promise.all([
      prisma.workspace.findUnique({ where: { id: tenantValue } }),
      prisma.user.findUnique({ where: { id: userValue } }),
    ]);
    if (tenant && user) return { tenantId: tenant.id, userId: user.id };
  }
  const legacy = await identity.ensureLegacyIdentity(tenantValue);
  return { tenantId: legacy.tenant.id, userId: legacy.user.id };
}

async function main() {
  const config = loadConfig();
  const prisma = createPrismaClient(config.env.DATABASE_URL);
  const identity = new PrismaIdentityRepository(prisma);
  const projects = new PrismaProjectRepository(config.paths.projects, prisma);
  const summary = { projectsImported: 0, projectsSkipped: 0, assetsImported: 0 };
  try {
    const entries = fs.existsSync(config.paths.projects)
      ? fs.readdirSync(config.paths.projects, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      : [];
    for (const entry of entries) {
      const documentFile = path.join(config.paths.projects, entry.name, 'project.json');
      if (!fs.existsSync(documentFile)) continue;
      if (await prisma.project.findUnique({ where: { id: entry.name }, select: { id: true } })) { summary.projectsSkipped += 1; continue; }
      const document = JSON.parse(fs.readFileSync(documentFile, 'utf8'));
      const owner = await resolveIdentity(prisma, identity, document);
      const project = await projects.create({ id: entry.name, title: document.title, project: document }, { tenantId: owner.tenantId, createdByUserId: owner.userId });
      summary.projectsImported += 1;
      for (const type of ['images', 'audio', 'videos', 'exports']) {
        const directory = projects.assetDir(project.id, type, { create: false });
        if (!fs.existsSync(directory)) continue;
        for (const assetEntry of fs.readdirSync(directory, { withFileTypes: true })) {
          if (!assetEntry.isFile() || assetEntry.name.startsWith('.') || assetEntry.name.endsWith('.tmp')) continue;
          const sourcePath = path.join(directory, assetEntry.name);
          const publicPath = `/projects/${encodeURIComponent(project.id)}/assets/${type}/${encodeURIComponent(assetEntry.name)}`;
          const storageKey = `projects/${project.id}/assets/${type}/${assetEntry.name}`;
          await prisma.asset.upsert({
            where: { projectId_type_fileName: { projectId: project.id, type, fileName: assetEntry.name } },
            update: { byteSize: BigInt(fs.statSync(sourcePath).size), status: 'committed' },
            create: { id: crypto.randomUUID(), tenantId: owner.tenantId, userId: owner.userId, projectId: project.id, type, fileName: assetEntry.name, storageKey, publicPath, byteSize: BigInt(fs.statSync(sourcePath).size), status: 'committed' },
          });
          summary.assetsImported += 1;
        }
      }
    }
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } finally { await prisma.$disconnect(); }
}

main().catch((error) => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; });
