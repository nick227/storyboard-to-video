const crypto = require('node:crypto');
const { Prisma } = require('../../dist/generated/prisma/client.js');
const { AppError } = require('../errors');
const { createPrismaClient } = require('./prisma-client');

function publicUser(user) {
  return { id: user.id, email: user.email, displayName: user.displayName, status: user.status };
}

function legacyUuid(value, namespace) {
  const hex = crypto.createHash('sha256').update(`${namespace}:${value}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

class PrismaIdentityRepository {
  constructor(connectionOrClient) {
    this.ownsClient = typeof connectionOrClient === 'string';
    this.prisma = this.ownsClient ? createPrismaClient(connectionOrClient) : connectionOrClient;
    if (!this.prisma) throw new Error('A Prisma client or DATABASE_URL is required');
  }

  async createUserWithPersonalWorkspace({ email, displayName, passwordHash }) {
    try {
      return await this.prisma.$transaction(async (db) => {
        const user = await db.user.create({ data: { id: crypto.randomUUID(), email, displayName, passwordHash } });
        const tenant = await db.workspace.create({ data: { id: crypto.randomUUID(), name: displayName ? `${displayName}'s workspace` : 'Personal workspace', type: 'personal' } });
        await db.membership.create({ data: { userId: user.id, tenantId: tenant.id, role: 'owner' } });
        return { user: publicUser(user), tenant, role: 'owner' };
      });
    } catch (cause) {
      if (cause instanceof Prisma.PrismaClientKnownRequestError && cause.code === 'P2002') {
        throw new AppError('EMAIL_IN_USE', 'An account with that email already exists', { status: 409 });
      }
      throw cause;
    }
  }

  async ensureLegacyIdentity(legacyId) {
    const userId = legacyUuid(legacyId, 'user');
    const tenantId = legacyUuid(legacyId, 'tenant');
    return this.prisma.$transaction(async (db) => {
      const user = await db.user.upsert({
        where: { id: userId },
        update: {},
        create: { id: userId, email: `${userId}@legacy.invalid`, displayName: legacyId, passwordHash: 'legacy-token-only', status: 'legacy' },
      });
      const tenant = await db.workspace.upsert({
        where: { id: tenantId },
        update: {},
        create: { id: tenantId, name: legacyId, type: 'legacy' },
      });
      await db.membership.upsert({
        where: { userId_tenantId: { userId, tenantId } },
        update: {},
        create: { userId, tenantId, role: 'owner' },
      });
      return { user: publicUser(user), tenant, role: 'owner', legacyId };
    });
  }

  async findUserByEmail(email) {
    const user = await this.prisma.user.findUnique({
      where: { email },
      include: { memberships: { include: { workspace: true }, orderBy: { createdAt: 'asc' }, take: 1 } },
    });
    const membership = user?.memberships[0];
    return user && membership ? { ...user, tenant: membership.workspace, role: membership.role } : null;
  }

  async createSession({ tokenHash, userId, tenantId, expiresAt }) {
    await this.prisma.session.create({ data: { id: crypto.randomUUID(), tokenHash, userId, tenantId, expiresAt } });
  }

  async findSession(tokenHash) {
    const session = await this.prisma.session.findUnique({ where: { tokenHash }, include: { user: true, workspace: true } });
    if (!session || session.expiresAt <= new Date() || session.user.status !== 'active') return null;
    const membership = await this.prisma.membership.findUnique({ where: { userId_tenantId: { userId: session.userId, tenantId: session.tenantId } } });
    return membership ? { sessionId: session.id, user: publicUser(session.user), tenant: session.workspace, role: membership.role, expiresAt: session.expiresAt } : null;
  }

  async deleteSession(tokenHash) {
    await this.prisma.session.deleteMany({ where: { tokenHash } });
  }

  async disconnect() {
    if (this.ownsClient) await this.prisma.$disconnect();
  }
}

module.exports = { PrismaIdentityRepository, legacyUuid };
