const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');
const { loadConfig } = require('../src/config/env');
const { createDependencies } = require('../src/dependencies');
const { createApp } = require('../src/app');
const { MemoryIdentityRepository } = require('./support/memory-identity.repository');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-app-'));
  for (const dir of ['public', 'styles', 'style-references']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  const dependencies = createDependencies(loadConfig(root), { identityStore: new MemoryIdentityRepository() });
  return { root, app: createApp(dependencies), projectStore: dependencies.projectStore, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('account registration creates a personal tenant and an HttpOnly session', async () => {
  const f = fixture();
  try {
    const agent = request.agent(f.app);
    const registered = await agent.post('/api/auth/register').send({ email: 'Alice@Example.com', displayName: 'Alice', password: 'a-secure-password' }).expect(201);
    assert.equal(registered.body.session.user.email, 'alice@example.com');
    assert.equal(registered.body.session.tenant.type, 'personal');
    assert.match(registered.headers['set-cookie'][0], /storyboard_session=/);
    assert.match(registered.headers['set-cookie'][0], /HttpOnly/);
    const session = await agent.get('/api/auth/session').expect(200);
    assert.equal(session.body.authenticated, true);
    assert.equal(session.body.session.user.displayName, 'Alice');
  } finally { f.cleanup(); }
});

test('cookie sessions isolate projects by tenant and logout revokes access', async () => {
  const f = fixture();
  try {
    const alice = request.agent(f.app);
    const bob = request.agent(f.app);
    await alice.post('/api/auth/register').send({ email: 'alice@example.com', displayName: 'Alice', password: 'a-secure-password' }).expect(201);
    await bob.post('/api/auth/register').send({ email: 'bob@example.com', displayName: 'Bob', password: 'another-secure-password' }).expect(201);
    const created = await alice.post('/api/projects').send({ id: 'alice-private', title: 'Private' }).expect(201);
    assert.equal(created.body.project.createdByUserId.length > 0, true);
    assert.equal(created.body.project.tenantId.length > 0, true);
    assert.equal(created.body.project.ownerId, undefined);
    await bob.get('/api/projects/alice-private').expect(404);
    await alice.get('/api/projects/alice-private').expect(200);
    await alice.post('/api/auth/logout').send({}).expect(200);
    await alice.get('/api/projects/alice-private').expect(401);
  } finally { f.cleanup(); }
});

test('login rejects invalid credentials without exposing account existence', async () => {
  const f = fixture();
  try {
    await request(f.app).post('/api/auth/register').send({ email: 'alice@example.com', displayName: 'Alice', password: 'a-secure-password' }).expect(201);
    const wrong = await request(f.app).post('/api/auth/login').send({ email: 'alice@example.com', password: 'wrong-password' }).expect(401);
    const missing = await request(f.app).post('/api/auth/login').send({ email: 'missing@example.com', password: 'wrong-password' }).expect(401);
    assert.equal(wrong.body.error.code, 'INVALID_CREDENTIALS');
    assert.equal(missing.body.error.code, 'INVALID_CREDENTIALS');
    assert.equal(wrong.body.error.message, missing.body.error.message);
  } finally { f.cleanup(); }
});
