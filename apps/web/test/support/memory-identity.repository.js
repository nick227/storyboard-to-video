const crypto = require('node:crypto');
const { AppError } = require('../../src/errors');

class MemoryIdentityRepository {
  constructor() {
    this.users = [];
    this.workspaces = [];
    this.memberships = [];
    this.sessions = [];
  }

  async createUserWithPersonalWorkspace({ email, displayName, passwordHash }) {
    if (this.users.some((user) => user.email === email)) throw new AppError('EMAIL_IN_USE', 'An account with that email already exists', { status: 409 });
    const user = { id: crypto.randomUUID(), email, displayName, passwordHash, status: 'active' };
    const tenant = { id: crypto.randomUUID(), name: `${displayName}'s workspace`, type: 'personal' };
    this.users.push(user);
    this.workspaces.push(tenant);
    this.memberships.push({ userId: user.id, tenantId: tenant.id, role: 'owner' });
    return { user: { id: user.id, email, displayName, status: user.status }, tenant, role: 'owner' };
  }

  async findUserByEmail(email) {
    const user = this.users.find((item) => item.email === email);
    const membership = this.memberships.find((item) => item.userId === user?.id);
    const tenant = this.workspaces.find((item) => item.id === membership?.tenantId);
    return user && membership && tenant ? { ...user, tenant, role: membership.role } : null;
  }

  async createSession({ tokenHash, userId, tenantId, expiresAt }) {
    this.sessions.push({ id: crypto.randomUUID(), tokenHash, userId, tenantId, expiresAt });
  }

  async findSession(tokenHash) {
    const session = this.sessions.find((item) => item.tokenHash === tokenHash && item.expiresAt > new Date());
    const user = this.users.find((item) => item.id === session?.userId);
    const tenant = this.workspaces.find((item) => item.id === session?.tenantId);
    const membership = this.memberships.find((item) => item.userId === user?.id && item.tenantId === tenant?.id);
    return session && user && tenant && membership ? { sessionId: session.id, user, tenant, role: membership.role, expiresAt: session.expiresAt } : null;
  }

  async deleteSession(tokenHash) {
    this.sessions = this.sessions.filter((item) => item.tokenHash !== tokenHash);
  }
}

module.exports = { MemoryIdentityRepository };
