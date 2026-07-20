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

test('user media defaults apply only when a new project is created', async () => {
  const f = fixture();
  try {
    const agent = request.agent(f.app);
    await agent.post('/api/auth/register').send({ email: 'media@example.com', displayName: 'Media', password: 'a-secure-password' }).expect(201);
    const first = await agent.post('/api/projects').send({ id: 'before-defaults', title: 'Before' }).expect(201);
    assert.equal(first.body.project.mediaSettings, undefined);
    const defaults = { version: 1, aspectRatio: '16:9', image: { resolutionTier: 'high', quality: 'medium' }, video: { resolutionTier: 'standard', durationSeconds: 6 } };
    await agent.put('/api/auth/preferences/media').send(defaults).expect(200);
    const second = await agent.post('/api/projects').send({ id: 'after-defaults', title: 'After' }).expect(201);
    assert.deepEqual(second.body.project.mediaSettings, defaults);
    const unchanged = await agent.get('/api/projects/before-defaults').expect(200);
    assert.equal(unchanged.body.project.mediaSettings, undefined);
  } finally { f.cleanup(); }
});

test('media quote endpoint resolves provider reality and rejects unsupported combinations', async () => {
  const f = fixture();
  try {
    const agent = request.agent(f.app);
    await agent.post('/api/auth/register').send({ email: 'quote@example.com', displayName: 'Quote', password: 'a-secure-password' }).expect(201);
    const intent = { version: 1, aspectRatio: '16:9', image: { resolutionTier: 'high', quality: 'medium' }, video: { resolutionTier: 'standard' } };
    const quote = await agent.post('/api/media-output/quote').send({ modality: 'image', provider: 'gemini', outputIntent: intent, quantity: 12 }).expect(200);
    assert.equal(quote.body.output.requested.resolutionTier, 'high');
    assert.deepEqual(quote.body.output.resolved.providerSettings, { imageSize: '2K', aspectRatio: '16:9' });
    assert.equal(quote.body.estimate.available, false);
    await agent.post('/api/media-output/quote').send({ modality: 'image', provider: 'openai', outputIntent: intent }).expect(400).expect((response) => assert.equal(response.body.error.code, 'UNSUPPORTED_MEDIA_OUTPUT'));
  } finally { f.cleanup(); }
});
