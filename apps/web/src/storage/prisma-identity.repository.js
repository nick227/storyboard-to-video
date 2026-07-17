const crypto = require('node:crypto');
const { PrismaPg } = require('@prisma/adapter-pg');
const { PrismaClient } = require('../../dist/generated/prisma/client.js');
const { Prisma } = require('../../dist/generated/prisma/client.js');
const { AppError } = require('../errors');

function publicUser(user) {
  return { id: user.id, email: user.email, displayName: user.displayName, status: user.status };
}

class PrismaIdentityRepository {
  constructor(connectionString) {
    if (!connectionString) throw new Error('DATABASE_URL is required');
    this.prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
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
    await this.prisma.$disconnect();
  }
}

module.exports = { PrismaIdentityRepository };
