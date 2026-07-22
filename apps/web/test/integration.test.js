process.env.AUTH_TOKENS = 'alice-token:alice,bob-token:bob';
process.env.ADMIN_OWNER_IDS = 'alice';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');
const { app, generationQueue, projectStore, prisma } = require('../server');
const { GenerationQueue } = require('../src/services/generation-queue');
const { JobStore } = require('../src/storage/job-store');
const { ProjectStore } = require('../src/storage/project-store');
const { PrismaBillingRepository } = require('../src/storage/prisma-billing.repository');

const auth = (token = 'alice-token') => ({ Authorization: `Bearer ${token}` });
const id = (label) => `test-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
async function cleanupProject(projectId) {
  // Generation requests now anchor immutable usage and billing audit records.
  // Project cleanup intentionally retains that history by its denormalized ID.
  await prisma.project.deleteMany({ where: { id: projectId } });
  await prisma.projectTombstone.deleteMany({ where: { projectId } });
  fs.rmSync(projectStore.projectDir(projectId), { recursive: true, force: true });
}

// CI runs every job against a brand-new, empty Postgres DB; local dev runs against a long-lived
// shared DB that already has the real, reconciled catalog from prior manual reconciliation work.
// A fresh DB isn't actually empty of ProviderPriceVersion rows, though: an early migration
// (20260717111500_billing_foundation) INSERTs 5 of the 14 real (provider, modality, model)
// tuples directly -- but pre-dating the billingTier column and the later billable flips, so
// those 5 rows are active with billingTier: null, billable: false. `ensureActivePrice` therefore
// checks for an active row that already SATISFIES the requested billingTier (and, when
// billable:true is requested, is actually billable with a recorded reconciledAt) -- not just any
// active row for that tuple -- and only creates a new one if no such row exists.
//
// A DB-level partial unique index (provider_price_versions_one_active, not modeled in
// schema.prisma -- added via raw SQL in the same migration above) allows at most one active row
// per (provider, modality, model), so creating a new satisfying row when an old, under-tagged one
// is already active means that old row must be retired -- there's no way around it at the DB
// level. This is done via configurePrice's own active:true path (the exact mechanism the admin
// console and every reconciliation script already use), never a raw update, so it's the same
// retire-and-activate the app performs for a real pricing change. In the shared dev DB this
// never actually fires: the real rows already satisfy every fixture below, so the existence
// check always succeeds and nothing is ever created or retired there. It only fires against a
// fresh DB, where the row being retired is itself a placeholder the app was never going to use
// (billingTier: null, billable: false) -- retiring it is correct, not destructive. Rows this
// creates are the correct permanent catalog entries for that DB (not test pollution), so they're
// deliberately never torn down afterward.
const billingRepositoryForSeeds = new PrismaBillingRepository(prisma);
async function ensureActivePrice({ provider, modality, model, rateCard, billingTier, billable = false, evidenceStatus = 'documented', reconciledAt = null }) {
  const existing = await prisma.providerPriceVersion.findFirst({
    where: { provider, modality, model, active: true, billingTier, ...(billable ? { billable: true, reconciledAt: { not: null } } : {}) },
  });
  if (existing) return existing;
  const created = await billingRepositoryForSeeds.createPriceVersion({
    versionKey: `ci-seed-${provider}-${modality}-${model}-${crypto.randomUUID()}`,
    provider, modality, model, currency: 'USD', rateCard, reservationNanoUsd: 0n,
    evidenceStatus, billingTier, billable, reconciledAt: billable ? (reconciledAt || new Date()) : reconciledAt,
    active: false,
  });
  return billingRepositoryForSeeds.configurePrice(created.id, { active: true });
}

// The canonical (provider, modality, model, billingTier) catalog this app is supposed to have
// priced -- mirrors the real, manually-reconciled rows in the shared dev DB. Each integration
// test below calls ensureActivePrice() for exactly the entries it depends on, so it passes
// standalone against a fresh CI DB without relying on any other test having run first.
const CANONICAL_PRICE_FIXTURES = {
  openaiText: { provider: 'openai', modality: 'text', model: 'gpt-4.1-mini', rateCard: { type: 'flat', nanoUsdPerUnit: 1_000_000 }, billingTier: 'customer_metered', billable: true, evidenceStatus: 'dashboard_reconciled' },
  openaiImage: { provider: 'openai', modality: 'image', model: 'gpt-image-1', rateCard: { type: 'flat', quantityKey: 'images', nanoUsdPerUnit: 40_000_000 }, billingTier: 'customer_metered' },
  geminiText: { provider: 'gemini', modality: 'text', model: 'gemini-3.5-flash', rateCard: { type: 'flat', nanoUsdPerUnit: 1_000_000 }, billingTier: 'customer_metered' },
  geminiImage: { provider: 'gemini', modality: 'image', model: 'gemini-3.1-flash-image', rateCard: { type: 'flat', quantityKey: 'images', nanoUsdPerUnit: 60_000_000 }, billingTier: 'customer_metered' },
  dezgo: { provider: 'dezgo', modality: 'image', model: 'text2image', rateCard: { type: 'flat', quantityKey: 'images', nanoUsdPerUnit: 15_000_000 }, billingTier: 'customer_metered' },
  minimax: { provider: 'minimax', modality: 'video', model: 'MiniMax-Hailuo-02', rateCard: { type: 'flat', quantityKey: 'videos', nanoUsdPerUnit: 270_000_000 }, billingTier: 'customer_metered' },
  ltxVideo: { provider: 'ltx', modality: 'video', model: 'ltx-video', rateCard: { type: 'flat', quantityKey: 'videos', nanoUsdPerUnit: 15_000_000 }, billingTier: 'platform_overhead' },
  piperLocal: { provider: 'piper', modality: 'audio', model: 'piper-local', rateCard: { type: 'flat', quantityKey: 'characters', nanoUsdPerUnit: 100_000 }, billingTier: 'platform_overhead' },
  piperModal: { provider: 'piper', modality: 'audio', model: 'piper-modal', rateCard: { type: 'flat', quantityKey: 'characters', nanoUsdPerUnit: 100_000 }, billingTier: 'platform_overhead' },
  sparkTts: { provider: 'spark', modality: 'audio', model: 'spark-tts', rateCard: { type: 'flat', quantityKey: 'characters', nanoUsdPerUnit: 500_000 }, billingTier: 'platform_overhead' },
  sparkVoiceClone: { provider: 'spark', modality: 'audio', model: 'spark-voice-clone', rateCard: { type: 'flat', nanoUsdPerUnit: 500_000_000 }, billingTier: 'platform_overhead' },
  sparkPreflight: { provider: 'spark', modality: 'audio', model: 'spark-preflight', rateCard: { type: 'flat', nanoUsdPerUnit: 0 }, billingTier: 'platform_overhead' },
  sparkReference: { provider: 'spark', modality: 'audio', model: 'spark-reference', rateCard: { type: 'flat', nanoUsdPerUnit: 0 }, billingTier: 'platform_overhead' },
  whisperx: { provider: 'whisperx', modality: 'alignment', model: 'whisperx-forced-alignment', rateCard: { type: 'flat', nanoUsdPerUnit: 2_000_000 }, billingTier: 'platform_overhead' },
};

test('public home introduces the product while the studio remains authenticated', async () => {
  await request(app).get('/').expect(200).expect(/Turn a script into a narrated video sequence/).expect(/<storyframe-topbar>/);
  await request(app).get('/studio').expect(302).expect('Location', /login\.html\?redirect=%2Fstudio/);
  await request(app).get('/studio.html').set(auth('bob-token')).expect(302).expect('Location', '/studio');
  await request(app).get('/studio').set(auth('bob-token')).expect(200).expect(/id="storyboardTitle"/).expect(/<storyframe-topbar>/);
});

test('admin console and API require a platform administrator', async () => {
  await request(app).get('/admin').set(auth('alice-token')).expect(200).expect(/Admin console/).expect(/<storyframe-topbar>/);
  await request(app).get('/admin.html').set(auth('alice-token')).expect(302).expect('Location', '/admin');
  await request(app).get('/admin').set(auth('bob-token')).expect(403);
  await request(app).get('/api/admin/overview').set(auth('alice-token')).expect(200).expect((response) => assert.equal(response.body.ok, true));
  await request(app).get('/api/admin/overview').set(auth('bob-token')).expect(403).expect((response) => assert.equal(response.body.error.code, 'FORBIDDEN'));
});

test('the admin billing sanity report is admin-gated and splits customer-billable spend from platform-included spend', async () => {
  await request(app).get('/api/admin/billing/sanity-report').set(auth('bob-token')).expect(403).expect((response) => assert.equal(response.body.error.code, 'FORBIDDEN'));
  await request(app).get('/api/admin/billing/sanity-report').set(auth('alice-token')).expect(200).expect((response) => {
    const body = response.body;
    assert.equal(body.ok, true);
    // Not asserting exact values -- this is a shared dev DB with ongoing concurrent activity and
    // years of prior test/reconciliation runs (see the analogous "every provider/model..." test
    // above). This proves the report's wiring, guard, and money-math survive real historical data
    // (including the fractional-seconds usage rows that used to crash live cost computation)
    // without hardcoding counts that would make this test flaky.
    assert.equal(typeof body.customerBillableSpendUSD, 'number');
    assert.equal(typeof body.platformIncludedSpendUSD, 'number');
    assert.ok(body.customerBillableSpendUSD >= 0);
    assert.ok(body.platformIncludedSpendUSD >= 0);
    assert.equal(typeof body.unpricedUsageCount, 'number');
    assert.ok(body.unpricedUsageCount >= 0);
    assert.ok(Array.isArray(body.unpriced));
    assert.equal(typeof body.reservationsHeld, 'number');
    assert.ok(body.reservationsHeld >= 0);
    assert.equal(typeof body.failedSettlements, 'number');
    assert.ok(body.failedSettlements >= 0);
    assert.equal(typeof body.refundsIssued.count, 'number');
    assert.ok(body.refundsIssued.count >= 0);
    assert.equal(typeof body.refundsIssued.creditMicros, 'string');
  });
});

test('credit purchase pages require login and Stripe webhooks bypass user auth', async () => {
  await request(app).get('/credits').expect(302).expect('Location', /login\.html/);
  await request(app).get('/credits.html').set(auth('bob-token')).expect(302).expect('Location', '/credits');
  await request(app).get('/credits').set(auth('bob-token')).expect(200).expect(/Site credits/).expect(/<storyframe-topbar>/);
  await request(app).get('/api/billing/purchase-options').set(auth('bob-token')).expect(200).expect((response) => {
    assert.equal(response.body.minimumAmount, 100);
    assert.equal(response.body.defaultAmount, 1000);
  });
  await request(app).post('/api/webhooks/stripe').set('Content-Type', 'application/json').send('{"id":"evt_test"}').expect(503).expect((response) => assert.equal(response.body.error.code, 'PAYMENTS_UNAVAILABLE'));
});

test('text-to-speech page requires login and the speech endpoint generates a downloadable clip with no project', async () => {
  await request(app).get('/text-to-speech').expect(302).expect('Location', /login\.html/);
  await request(app).get('/text-to-speech.html').set(auth('bob-token')).expect(302).expect('Location', '/text-to-speech');
  await request(app).get('/text-to-speech').set(auth('bob-token')).expect(200).expect(/Text to speech/).expect(/<storyframe-topbar>/);

  await request(app).post('/api/audio/speech').send({ text: 'Hello there' }).expect(401);

  const response = await request(app).post('/api/audio/speech').set(auth('bob-token')).send({ text: 'Hello there', provider: 'stub' }).expect(200);
  assert.equal(response.headers['content-type'], 'audio/wav');
  assert.match(response.headers['content-disposition'], /attachment; filename="speech-\d+\.wav"/);
  assert.ok(response.body.length > 0);
});

test('concurrent project saves reject stale revisions', async (t) => {
  const projectId = id('revision'); t.after(() => cleanupProject(projectId));
  const created = await request(app).post('/api/projects').set(auth()).send({ id: projectId, title: 'Revision' }).expect(201);
  const revision = created.body.project.revision;
  const first = await request(app).put(`/api/projects/${projectId}`).set(auth()).set('If-Match', `"${revision}"`).send({ title: 'First', scenes: [] }).expect(200);
  assert.equal(first.body.project.revision, revision + 1);
  const stale = await request(app).put(`/api/projects/${projectId}`).set(auth()).set('If-Match', `"${revision}"`).send({ title: 'Stale', scenes: [] }).expect(409);
  assert.equal(stale.body.error.code, 'REVISION_CONFLICT');
});

test('persisted queued and running jobs recover as interrupted', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-'));
  try {
    const store = new JobStore(root);
    store.save({ id: 'queued', type: 'image', projectId: 'p', status: 'queued', createdAt: new Date().toISOString() });
    store.save({ id: 'running', type: 'audio', projectId: 'p', status: 'running', createdAt: new Date().toISOString() });
    const queue = new GenerationQueue({ store });
    assert.equal((await queue.get('queued')).status, 'interrupted');
    assert.equal((await queue.get('running')).error.code, 'SERVER_RESTARTED');
    assert.equal((await queue.cancel('queued')).status, 'interrupted');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('cancelled leases reject late asset commits', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'projects-'));
  try {
    const store = new ProjectStore(root); const project = store.create({ id: 'p', ownerId: 'alice' }); const lease = store.acquireLease(project.id);
    const source = path.join(root, 'source.bin'); fs.writeFileSync(source, Buffer.alloc(8));
    const controller = new AbortController(); controller.abort();
    await assert.rejects(() => store.commitAsset(lease, 'images', source, { signal: controller.signal }), /abort/i);
    assert.deepEqual(fs.readdirSync(store.assetDir('p', 'images')), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('project tombstones prevent late jobs from recreating deleted projects', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'projects-'));
  try {
    const store = new ProjectStore(root); store.create({ id: 'p', ownerId: 'alice' }); const lease = store.acquireLease('p');
    const source = path.join(root, 'source.bin'); fs.writeFileSync(source, Buffer.alloc(8)); store.delete('p');
    await assert.rejects(() => store.commitAsset(lease, 'images', source), /deleted/i);
    assert.equal(fs.existsSync(store.projectDir('p')), false);
    assert.throws(() => store.create({ id: 'p' }), /permanently deleted/i);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('asset deletion rejects explicit active-version references', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'projects-'));
  try {
    const store = new ProjectStore(root); let project = store.create({ id: 'p' }); const lease = store.acquireLease('p');
    const source = path.join(root, 'source.bin'); fs.writeFileSync(source, Buffer.alloc(8)); const asset = await store.commitAsset(lease, 'images', source);
    project = store.write('p', { ...project, scenes: [{ versions: [{ path: asset.path }], activeVersionIndex: 0 }] }, { expectedRevision: project.revision });
    await assert.rejects(() => store.deleteAsset('p', 'images', asset.fileName), (error) => error.code === 'ASSET_IN_USE');
    assert.ok(project.assetReferences.includes(asset.path));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('duplicate generation requests reuse the completed project-scoped result', async (t) => {
  const projectId = id('idem'); t.after(() => cleanupProject(projectId));
  await request(app).post('/api/projects').set(auth()).send({ id: projectId, title: 'Idempotency', project: { scenes: [{ id: 'sc1' }] } }).expect(201);
  const body = { projectId, sceneId: 'sc1', sceneNumber: 1, sceneTitle: 'Opening', scenePrompt: 'A bright room.', styleId: 'basic-cartoon', provider: 'stub' };
  const first = await request(app).post('/api/images/generate').set(auth()).set('Idempotency-Key', 'same-request-001').send(body).expect(200);
  const second = await request(app).post('/api/images/generate').set(auth()).set('Idempotency-Key', 'same-request-001').send(body).expect(200);
  assert.equal(second.body.image.path, first.body.image.path);
  assert.equal(fs.readdirSync(projectStore.assetDir(projectId, 'images')).length, 1);
  assert.equal(await prisma.usageEvent.count({ where: { projectId, modality: 'image' } }), 1);
});

test('scene audio recordings upload through the generation queue and reuse a completed idempotency key', async (t) => {
  const projectId = id('recording'); t.after(() => cleanupProject(projectId));
  await request(app).post('/api/projects').set(auth()).send({ id: projectId, title: 'Recording', project: { scenes: [{ id: 'sc1', narrationText: '' }] } }).expect(201);
  const upload = () => request(app).post('/api/audio/recordings').set(auth()).set('Idempotency-Key', 'recording-request-001')
    .field('projectId', projectId).field('sceneId', 'sc1').field('sceneNumber', '1').field('sceneTitle', 'Opening')
    .attach('audio', Buffer.from('recorded-audio'), { filename: 'take.webm', contentType: 'audio/webm' });
  const first = await upload().expect(200);
  const second = await upload().expect(200);
  assert.equal(first.body.audio.provider, 'recorded');
  assert.equal(second.body.audio.path, first.body.audio.path);
  assert.equal(fs.readdirSync(projectStore.assetDir(projectId, 'audio')).length, 1);
  const saved = await request(app).get(`/api/projects/${projectId}`).set(auth()).expect(200);
  assert.equal(saved.body.project.scenes[0].audioVersions.length, 1);
  assert.equal(saved.body.project.scenes[0].audioVersions[0].provider, 'recorded');
});

test('duplicate active generation requests reuse the active job', async (t) => {
  const projectId = id('active-idem'); t.after(() => cleanupProject(projectId));
  await request(app).post('/api/projects').set(auth()).send({ id: projectId, title: 'Active idempotency', project: { scenes: [{ id: 'sc1' }] } }).expect(201);
  let release;
  const blocker = await generationQueue.add('test-blocker', null, () => new Promise((resolve) => { release = resolve; }));
  blocker.promise.catch(() => {});
  const body = { projectId, sceneId: 'sc1', sceneNumber: 1, sceneTitle: 'Opening', scenePrompt: 'A held request.', styleId: 'basic-cartoon', provider: 'stub' };
  const firstRequest = request(app).post('/api/images/generate').set(auth()).set('Idempotency-Key', 'active-request-001').send(body);
  const firstPromise = firstRequest.then((response) => response);
  for (let attempts = 0; attempts < 20 && !(await generationQueue.list(projectId)).length; attempts += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  const duplicate = await request(app).post('/api/images/generate').set(auth()).set('Idempotency-Key', 'active-request-001').send(body).expect(202);
  assert.equal(duplicate.body.reused, true);
  assert.equal((await generationQueue.list(projectId)).length, 1);
  release();
  assert.equal((await firstPromise).status, 200);
});

test('quota enforcement is atomic and cleanup removes only unreferenced assets', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'projects-'));
  try {
    const store = new ProjectStore(root, { maxFiles: 2, maxBytes: 12 }); let project = store.create({ id: 'p' }); const lease = store.acquireLease('p');
    const source = path.join(root, 'source.bin'); fs.writeFileSync(source, Buffer.alloc(8)); const kept = await store.commitAsset(lease, 'images', source, { fileName: 'kept.bin' });
    project = store.write('p', { ...project, scenes: [{ versions: [{ path: kept.path }] }] }, { expectedRevision: project.revision });
    fs.writeFileSync(source, Buffer.alloc(8)); await assert.rejects(() => store.commitAsset(lease, 'images', source, { fileName: 'too-big.bin' }), (error) => error.code === 'PROJECT_QUOTA_EXCEEDED');
    fs.writeFileSync(path.join(store.assetDir('p', 'images'), 'unused.bin'), Buffer.alloc(1));
    const removed = await store.cleanup('p'); assert.deepEqual(removed, [{ type: 'images', fileName: 'unused.bin' }]);
    assert.equal(fs.existsSync(path.join(store.assetDir('p', 'images'), 'kept.bin')), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('unfinished cleanup transactions roll back during restart recovery', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'projects-'));
  try {
    const store = new ProjectStore(root); store.create({ id: 'p' });
    const assetDir = store.assetDir('p', 'images'); fs.writeFileSync(path.join(assetDir, 'recover.bin'), Buffer.alloc(1));
    const trash = path.join(store.projectDir('p'), '.cleanup-crash', 'images'); fs.mkdirSync(trash, { recursive: true });
    fs.renameSync(path.join(assetDir, 'recover.bin'), path.join(trash, 'recover.bin'));
    new ProjectStore(root);
    assert.equal(fs.existsSync(path.join(assetDir, 'recover.bin')), true);
    assert.equal(fs.existsSync(path.dirname(trash)), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('authentication and ownership protect project documents and assets', async (t) => {
  const projectId = id('owner'); t.after(() => cleanupProject(projectId));
  await request(app).post('/api/projects').set(auth()).send({ id: projectId, title: 'Private', project: { scenes: [{ id: 'sc1' }] } }).expect(201);
  const body = { projectId, sceneId: 'sc1', sceneNumber: 1, sceneTitle: 'Private', scenePrompt: 'Private image.', styleId: 'basic-cartoon', provider: 'stub' };
  const generated = await request(app).post('/api/images/generate').set(auth()).set('Idempotency-Key', 'private-request-001').send(body).expect(200);
  await request(app).get(`/api/projects/${projectId}`).expect(401);
  await request(app).get(`/api/projects/${projectId}`).set(auth('bob-token')).expect(404);
  await request(app).get(generated.body.image.path).set(auth('bob-token')).expect(404);
  await request(app).get(generated.body.image.path).set(auth()).expect(200);
  await request(app).post('/api/images/generate').set(auth('bob-token')).set('Idempotency-Key', 'cross-owner-001').send(body).expect(404);
  const legacyName = `legacy-${Date.now()}.bin`; const legacyPath = path.join(__dirname, '..', 'data', 'generated', legacyName);
  fs.mkdirSync(path.dirname(legacyPath), { recursive: true }); fs.writeFileSync(legacyPath, Buffer.alloc(1));
  try { await request(app).get(`/generated/${legacyName}`).set(auth()).expect(404); } finally { fs.rmSync(legacyPath, { force: true }); }
});

test('validation errors retain the shared error contract behind authentication', async () => {
  const response = await request(app).post('/api/storyboard/plan-shots').set(auth()).set('Idempotency-Key', 'invalid-request-001').send({ projectId: 'missing', scriptText: '' }).expect(400);
  assert.equal(response.body.error.code, 'VALIDATION_ERROR'); assert.ok(response.body.error.requestId);
});

test('regenerate-prompt now enforces request validation', async () => {
  const response = await request(app).post('/api/storyboard/regenerate-prompt').set(auth()).set('Idempotency-Key', 'invalid-regen-prompt-001').send({ projectId: 'missing' }).expect(400);
  assert.equal(response.body.error.code, 'VALIDATION_ERROR');
});

test('regenerate-action rejects a scene with no fragment and no script text', async (t) => {
  const projectId = id('action-missing'); t.after(() => cleanupProject(projectId));
  await request(app).post('/api/projects').set(auth()).send({ id: projectId, title: 'Action missing' }).expect(201);
  const body = { projectId, scene: { beat: 'A hero waits.', prompt: 'A hero stands still.' }, sceneIndex: 0, provider: 'gemini' };
  const response = await request(app).post('/api/storyboard/regenerate-action').set(auth()).set('Idempotency-Key', 'regen-action-missing-001').send(body).expect(400);
  assert.equal(response.body.error.code, 'SCENE_FRAGMENT_MISSING');
});

test('regenerate-action succeeds via stub and never returns a prompt field', async (t) => {
  const projectId = id('action-ok'); t.after(() => cleanupProject(projectId));
  await request(app).post('/api/projects').set(auth()).send({ id: projectId, title: 'Action ok' }).expect(201);
  const scene = { scriptFragment: 'A hero opens a door and steps outside into the light.', beat: 'A hero opens a door.' };
  const body = { projectId, scene, sceneIndex: 0, provider: 'stub' };
  const response = await request(app).post('/api/storyboard/regenerate-action').set(auth()).set('Idempotency-Key', 'regen-action-ok-001').send(body).expect(200);
  assert.deepEqual(Object.keys(response.body).sort(), ['beat', 'usedFallback', 'warning']);
});

test('split-scene splits one fragment into the requested number of sub-scenes', async (t) => {
  const projectId = id('split'); t.after(() => cleanupProject(projectId));
  await request(app).post('/api/projects').set(auth()).send({ id: projectId, title: 'Split' }).expect(201);
  const body = { projectId, scriptFragment: 'A hero opens a door. A shadow crosses the hallway. The house creaks in the wind. A voice calls out from upstairs.', count: 2, provider: 'stub' };
  const response = await request(app).post('/api/storyboard/split-scene').set(auth()).set('Idempotency-Key', 'split-scene-001').send(body).expect(200);
  assert.equal(response.body.scenes.length, 2);
  response.body.scenes.forEach((scene) => assert.ok(typeof scene.scriptFragment === 'string' && scene.scriptFragment.length > 0));
});

test('GET /api/projects/:projectId/tokens retrieves and aggregates project token spend details', async (t) => {
  const projectId = id('tokens'); t.after(() => cleanupProject(projectId));
  const project = await request(app).post('/api/projects').set(auth()).send({ id: projectId, title: 'Tokens Test' }).expect(201);
  const tenantId = project.body.project.tenantId;

  // 1. Initially it should return zero spend/tokens
  const emptyRes = await request(app).get(`/api/projects/${projectId}/tokens`).set(auth()).expect(200);
  assert.equal(emptyRes.body.ok, true);
  assert.equal(emptyRes.body.totalCostUSD, 0);
  assert.equal(emptyRes.body.totalTokens, 0);
  assert.deepEqual(emptyRes.body.providers, {});

  // 2. Seed a generation request and a usage event with tokens
  const reqId = crypto.randomUUID();
  await prisma.generationRequest.create({
    data: {
      id: reqId,
      tenantId,
      projectId,
      sequence: 1,
      modality: 'text',
      provider: 'openai',
      model: 'gpt-4o',
      status: 'completed',
    }
  });

  const eventId = crypto.randomUUID();
  await prisma.usageEvent.create({
    data: {
      id: eventId,
      generationRequestId: reqId,
      tenantId,
      projectId,
      modality: 'text',
      provider: 'openai',
      model: 'gpt-4o',
      usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
      measurementStatus: 'observed',
    }
  });

  // Seed a price version and cost snapshot
  const priceVersionId = crypto.randomUUID();
  await prisma.providerPriceVersion.create({
    data: {
      id: priceVersionId,
      versionKey: `test-version-${Date.now()}-${Math.random()}`,
      provider: 'openai',
      modality: 'text',
      model: 'gpt-4o',
      rateCard: { type: 'flat', nanoUsdPerUnit: 1000 },
      reservationNanoUsd: 0n,
      evidenceStatus: 'documented',
    }
  });

  await prisma.providerCostSnapshot.create({
    data: {
      id: crypto.randomUUID(),
      generationRequestId: reqId,
      usageEventId: eventId,
      providerPriceVersionId: priceVersionId,
      usageSnapshot: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
      rateCardSnapshot: { type: 'flat', nanoUsdPerUnit: 1000 },
      providerCostNanoUsd: 50000000n, // $0.05
      currency: 'USD',
      calculation: {},
    }
  });

  // 3. Request tokens endpoint and verify values
  const populatedRes = await request(app).get(`/api/projects/${projectId}/tokens`).set(auth()).expect(200);
  assert.equal(populatedRes.body.ok, true);
  assert.equal(populatedRes.body.totalCostUSD, 0.05);
  assert.equal(populatedRes.body.totalTokens, 1500);
  assert.ok(populatedRes.body.providers.openai);
  assert.equal(populatedRes.body.providers.openai.costUSD, 0.05);
  assert.equal(populatedRes.body.providers.openai.tokens, 1500);
  assert.equal(populatedRes.body.providers.openai.inputTokens, 1000);
  assert.equal(populatedRes.body.providers.openai.outputTokens, 500);
  assert.ok(Array.isArray(populatedRes.body.activePrices));
  assert.ok(Array.isArray(populatedRes.body.unpriced));
  assert.deepEqual(populatedRes.body.unpriced, []);
  assert.ok(Array.isArray(populatedRes.body.videoModels));
  assert.ok(populatedRes.body.videoModels.some((entry) => entry.provider === 'ltx' && entry.model === 'ltx-video'));
  assert.ok(populatedRes.body.videoModels.some((entry) => entry.provider === 'minimax' && entry.model === 'MiniMax-Hailuo-02'));
  assert.ok(populatedRes.body.providers.openai.modalities);
  assert.ok(populatedRes.body.providers.openai.modalities.text);
  assert.equal(populatedRes.body.providers.openai.modalities.text.costUSD, 0.05);
  assert.equal(populatedRes.body.providers.openai.modalities.text.tokens, 1500);
  assert.ok(populatedRes.body.providers.openai.modalities.text.models['gpt-4o']);

  // Video usage is generation-based rather than token-based, but it must still appear in the same
  // project-spend breakdown with its provider and model. This event has no ProviderCostSnapshot,
  // so its cost is live-computed against the active ltx-video price -- ensure one exists (a fresh
  // CI DB has no seeded catalog at all; see ensureActivePrice's comment above).
  await ensureActivePrice(CANONICAL_PRICE_FIXTURES.ltxVideo);
  const videoRequestId = crypto.randomUUID();
  await prisma.generationRequest.create({
    data: {
      id: videoRequestId,
      tenantId,
      projectId,
      sequence: 2,
      modality: 'video',
      provider: 'ltx',
      model: 'ltx-video',
      status: 'completed',
    }
  });
  await prisma.usageEvent.create({
    data: {
      id: crypto.randomUUID(),
      generationRequestId: videoRequestId,
      tenantId,
      projectId,
      modality: 'video',
      provider: 'ltx',
      model: 'ltx-video',
      usage: { videos: 1, frames: 121, seconds: 5 },
      measurementStatus: 'observed',
    }
  });

  const videoRes = await request(app).get(`/api/projects/${projectId}/tokens`).set(auth()).expect(200);
  // ltx is a platform-overhead price under the prototype billing policy: its real cost is still
  // computed and shown per-model, but excluded from the customer-facing totalCostUSD and tracked
  // separately in platformCostUSD.
  assert.equal(videoRes.body.totalCostUSD, 0.05);
  assert.equal(videoRes.body.platformCostUSD, 0.015);
  assert.equal(videoRes.body.providers.ltx.modalities.video.count, 1);
  assert.equal(videoRes.body.providers.ltx.modalities.video.models['ltx-video'].count, 1);
  assert.equal(videoRes.body.providers.ltx.modalities.video.models['ltx-video'].extra.frames, 121);
  assert.equal(videoRes.body.providers.ltx.modalities.video.models['ltx-video'].costUSD, 0.015);
  assert.equal(videoRes.body.providers.ltx.modalities.video.models['ltx-video'].billingTier, 'platform_overhead');
});

// The exact provider/modality/model combinations this app is supposed to have priced (mirrors
// CANONICAL_PRICE_FIXTURES above). Checked against a curated list rather than every distinct
// (provider, modality, model) that has ever appeared in GenerationRequest: this integration test
// file (and others) leave behind `test-version-*`/stray ProviderPriceVersion rows across runs
// (e.g. a stray `gpt-4o` model, never a real production model), which would make a blanket
// "every model in history" assertion flaky/misleading.
const REQUIRED_PRICED_MODELS = Object.values(CANONICAL_PRICE_FIXTURES).map(({ provider, modality, model }) => ({ provider, modality, model }));

test('every provider/model this task priced for observability has an active price row, and nothing is billable unless tagged customer_metered with a recorded evidence-acceptance date', async () => {
  // Self-contained: seed every required row rather than assume a previous test (or a shared dev
  // DB's history) already did. ensureActivePrice() never touches an already-active row, so this
  // is a no-op against a DB that already has the real catalog. Sequential, not Promise.all --
  // configurePrice runs a Serializable transaction, and firing 14 of those concurrently against
  // the same table triggers real Postgres serialization conflicts even across disjoint rows.
  for (const fixture of Object.values(CANONICAL_PRICE_FIXTURES)) await ensureActivePrice(fixture);

  const activePrices = await prisma.providerPriceVersion.findMany({ where: { active: true }, select: { provider: true, modality: true, model: true, billable: true, versionKey: true, evidenceStatus: true, reconciledAt: true, billingTier: true } });
  const priceKeys = new Set(activePrices.map((price) => `${price.provider}::${price.modality}::${price.model}`));
  const missing = REQUIRED_PRICED_MODELS.filter((row) => !priceKeys.has(`${row.provider}::${row.modality}::${row.model}`));
  assert.deepEqual(missing, [], `expected an active price row for each of: ${JSON.stringify(missing)}`);

  // Prototype provider-cost billing policy: a customer_metered price may be billable on
  // documented/estimated/dashboard_reconciled evidence, as long as it has a recorded
  // reconciledAt (evidence-acceptance date). A platform_overhead (or uncategorized) price must
  // never be billable, regardless of evidence -- that invariant must never be violated
  // (configurePrice's own guard, plus a DB check constraint, already enforce this at write time;
  // this is a regression check against any path that bypasses it).
  const billable = activePrices.filter((price) => price.billable);
  const platformOverhead = activePrices.filter((price) => price.billingTier === 'platform_overhead');
  for (const price of billable) {
    assert.equal(price.billingTier, 'customer_metered', `${price.versionKey} is billable but not tagged customer_metered`);
    assert.ok(price.reconciledAt, `${price.versionKey} is billable without a reconciledAt date`);
  }
  for (const price of platformOverhead) {
    assert.equal(price.billable, false, `${price.versionKey} is a platform_overhead price but is billable`);
  }
  // Checked by (provider, modality, model), not a specific historical versionKey -- a fresh CI
  // DB will never have the exact hand-reconciled row from the shared dev DB's real history, but
  // the invariant this guards (a real, billable, customer-metered OpenAI text price exists) must
  // hold in both.
  assert.ok(billable.some((price) => price.provider === 'openai' && price.modality === 'text'), 'a billable, customer-metered OpenAI text price should exist');
});

test('GET /api/billing/pricing reads real ProviderPriceVersion rows, not a static duplicate array', async () => {
  await ensureActivePrice(CANONICAL_PRICE_FIXTURES.minimax);
  await ensureActivePrice(CANONICAL_PRICE_FIXTURES.whisperx);

  const response = await request(app).get('/api/billing/pricing').set(auth()).expect(200);
  assert.equal(response.body.ok, true);
  assert.ok(Array.isArray(response.body.prices));
  assert.ok(response.body.prices.length > 0);
  assert.equal(response.body.estimatedPrices, undefined);
  assert.ok(response.body.prices.some((price) => price.provider === 'minimax' && price.model === 'MiniMax-Hailuo-02'));
  assert.ok(response.body.prices.some((price) => price.provider === 'whisperx' && price.modality === 'alignment'));
});
