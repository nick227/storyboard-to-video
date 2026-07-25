process.env.PIXABAY_API_KEY ||= 'test-pixabay-key';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const request = require('supertest');
const { app, projectStore, prisma } = require('../server');

const auth = (token = 'alice-token') => ({ Authorization: `Bearer ${token}` });
const id = (label) => `test-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`;

async function cleanupProject(projectId) {
  await prisma.project.deleteMany({ where: { id: projectId } });
  await prisma.projectTombstone.deleteMany({ where: { projectId } });
  fs.rmSync(projectStore.projectDir(projectId), { recursive: true, force: true });
}

// basic-cartoon has default character/world reference images, and pixabay (like dezgo_flux)
// declares maxReferences: 0 -- so a naive POST /generate 409s on REFERENCE_OMISSIONS_CONFIRMATION_
// REQUIRED, same as any other zero-reference provider would. A real client always preflights first;
// this mirrors that instead of dodging it.
async function generateImage(body) {
  const preflight = await request(app).post('/api/images/preflight').set(auth()).send(body).expect(200);
  return request(app).post('/api/images/generate').set(auth()).set('Idempotency-Key', id('key'))
    .send({ ...body, confirmedReferencePlanHash: preflight.body.referencePlanHash });
}

function pixabayHit(pixId, tag = 'fox') {
  return {
    id: pixId,
    tags: `${tag}, forest`,
    user: `photographer-${pixId}`,
    pageURL: `https://pixabay.com/photos/${tag}-${pixId}/`,
    previewURL: `https://cdn.pixabay.com/photo/${pixId}/preview_150.jpg`,
    webformatURL: `https://pixabay.com/get/${pixId}/webformat.jpg`,
    largeImageURL: `https://pixabay.com/get/${pixId}/large.jpg`,
    imageWidth: 1920,
    imageHeight: 1080,
  };
}

function pixabayImageBytes() {
  return new Response(Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43]), {
    status: 200, headers: { 'Content-Type': 'image/jpeg' },
  });
}

test('pixabay as an image provider: query composition, download, and Asset commit', async (t) => {
  const projectId = id('pixgen');
  await request(app).post('/api/projects').set(auth()).send({
    id: projectId, title: 'Pixabay Gen', project: { scenes: [{ id: 'sc1' }] },
  }).expect(201);
  t.after(() => cleanupProject(projectId));

  const searchUrls = [];
  const original = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith('https://pixabay.com/api/?')) {
      searchUrls.push(u);
      return new Response(JSON.stringify({ total: 1, totalHits: 1, hits: [pixabayHit(111)] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    if (u === 'https://pixabay.com/get/111/large.jpg') return pixabayImageBytes();
    throw new Error(`Unexpected fetch in test: ${u}`);
  };

  try {
    const body = {
      projectId, sceneId: 'sc1', sceneNumber: 1, sceneTitle: 'Opening',
      scenePrompt: 'A red fox runs through a snowy forest at dawn.',
      styleId: 'basic-cartoon', provider: 'pixabay',
    };
    const res = await generateImage(body);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.image.path, 'generated image should have a path');

    // The composed query should combine the style keyword with subject terms from the prompt --
    // not the raw sentence.
    const query = new URL(searchUrls[0]).searchParams.get('q');
    assert.equal(query, 'cartoon red fox runs snowy forest');

    const asset = await prisma.asset.findFirst({ where: { projectId, type: 'images' } });
    assert.ok(asset, 'committed Asset row should exist');
    assert.equal(asset.byteSize, 6n);

    const usage = await prisma.usageEvent.findFirst({ where: { projectId, modality: 'image' } });
    assert.ok(usage, 'a zero-cost usage event should still be recorded for audit parity with other providers');
    assert.equal(usage.provider, 'pixabay');
  } finally {
    global.fetch = original;
  }
});

test('pixabay falls back to a broader query when the full query has zero results', async (t) => {
  const projectId = id('pixfallback');
  await request(app).post('/api/projects').set(auth()).send({
    id: projectId, title: 'Pixabay Fallback', project: { scenes: [{ id: 'sc1' }] },
  }).expect(201);
  t.after(() => cleanupProject(projectId));

  const searchQueries = [];
  const original = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith('https://pixabay.com/api/?')) {
      const query = new URL(u).searchParams.get('q');
      searchQueries.push(query);
      // Only the last-resort style-word-only query actually has results.
      const hasResults = query === 'cartoon';
      return new Response(JSON.stringify({ total: hasResults ? 1 : 0, totalHits: hasResults ? 1 : 0, hits: hasResults ? [pixabayHit(222, 'castle')] : [] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    if (u === 'https://pixabay.com/get/222/large.jpg') return pixabayImageBytes();
    throw new Error(`Unexpected fetch in test: ${u}`);
  };

  try {
    const body = {
      projectId, sceneId: 'sc1', sceneNumber: 1, sceneTitle: 'Opening',
      scenePrompt: 'A crumbling ancient castle looms over the misty valley below.',
      styleId: 'basic-cartoon', provider: 'pixabay',
    };
    const res = await generateImage(body);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.image.path);
    // Broadened all the way down to the last-resort style-word-only query before finding a hit.
    assert.equal(searchQueries.length, 5);
    assert.equal(searchQueries.at(-1), 'cartoon');
  } finally {
    global.fetch = original;
  }
});

test('pixabay generation fails cleanly when every broadened query returns zero results', async (t) => {
  const projectId = id('pixempty');
  await request(app).post('/api/projects').set(auth()).send({
    id: projectId, title: 'Pixabay Empty', project: { scenes: [{ id: 'sc1' }] },
  }).expect(201);
  t.after(() => cleanupProject(projectId));

  const original = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith('https://pixabay.com/api/?')) {
      return new Response(JSON.stringify({ total: 0, totalHits: 0, hits: [] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`Unexpected fetch in test: ${u}`);
  };

  try {
    const body = {
      projectId, sceneId: 'sc1', sceneNumber: 1, sceneTitle: 'Opening',
      scenePrompt: 'A shape shifting entity of pure light.',
      styleId: 'basic-cartoon', provider: 'pixabay',
    };
    const res = await generateImage(body);
    assert.ok(res.status >= 400, `expected a failure status, got ${res.status}`);
  } finally {
    global.fetch = original;
  }
});

test('pixabay regenerate rotates to a different result via attemptIndex', async (t) => {
  const projectId = id('pixrotate');
  await request(app).post('/api/projects').set(auth()).send({
    id: projectId, title: 'Pixabay Rotate', project: { scenes: [{ id: 'sc1' }] },
  }).expect(201);
  t.after(() => cleanupProject(projectId));

  const downloaded = [];
  const original = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith('https://pixabay.com/api/?')) {
      return new Response(JSON.stringify({ total: 2, totalHits: 2, hits: [pixabayHit(301, 'owl'), pixabayHit(302, 'owl')] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    if (u === 'https://pixabay.com/get/301/large.jpg' || u === 'https://pixabay.com/get/302/large.jpg') {
      downloaded.push(u);
      return pixabayImageBytes();
    }
    throw new Error(`Unexpected fetch in test: ${u}`);
  };

  try {
    const body = {
      projectId, sceneId: 'sc1', sceneNumber: 1, sceneTitle: 'Opening',
      scenePrompt: 'An owl perches on a moonlit branch.',
      styleId: 'basic-cartoon', provider: 'pixabay',
    };
    const first = await generateImage(body);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    // Second generate call: the scene now has one existing version, so attemptIndex=1 should pick
    // the second search result instead of repeating the first.
    const second = await generateImage(body);
    assert.equal(second.status, 200, JSON.stringify(second.body));

    assert.equal(downloaded.length, 2);
    assert.notEqual(downloaded[0], downloaded[1], 'regenerate should not silently redownload the same photo');
  } finally {
    global.fetch = original;
  }
});
