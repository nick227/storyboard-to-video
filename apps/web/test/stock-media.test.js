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

function pixabaySearchResponse() {
  return new Response(JSON.stringify({
    total: 1,
    totalHits: 1,
    hits: [{
      id: 555,
      tags: 'forest, trees, mist',
      user: 'testphotographer',
      pageURL: 'https://pixabay.com/photos/forest-555/',
      previewURL: 'https://cdn.pixabay.com/photo/555/preview_150.jpg',
      webformatURL: 'https://pixabay.com/get/555/webformat.jpg',
      largeImageURL: 'https://pixabay.com/get/555/large.jpg',
      imageWidth: 1920,
      imageHeight: 1080,
    }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

test('stock search -> select materializes a committed Asset with provenance', async () => {
  const projectId = id('stock');
  await request(app).post('/api/projects').set(auth()).send({
    id: projectId, title: 'Stock', project: { scenes: [{ id: 'sc1' }] },
  }).expect(201);

  const original = global.fetch;
  try {
    global.fetch = async (url) => {
      const u = String(url);
      if (u.startsWith('https://pixabay.com/api/?')) return pixabaySearchResponse();
      if (u === 'https://pixabay.com/get/555/large.jpg') {
        return new Response(Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43]), {
          status: 200, headers: { 'Content-Type': 'image/jpeg' },
        });
      }
      throw new Error(`Unexpected fetch in test: ${u}`);
    };

    const search = await request(app)
      .get(`/api/projects/${projectId}/stock/search`)
      .set(auth())
      .query({ query: 'forest' })
      .expect(200);
    assert.equal(search.body.ok, true);
    assert.equal(search.body.results.length, 1);
    const result = search.body.results[0];
    assert.equal(result.provider, 'pixabay');
    assert.equal(result.providerId, '555');
    assert.equal(result.fullUrl, 'https://pixabay.com/get/555/large.jpg');
    assert.equal(result.creator, 'testphotographer');

    const select = await request(app)
      .post(`/api/projects/${projectId}/stock/select`)
      .set(auth())
      .send({
        provider: 'pixabay', fullUrl: result.fullUrl,
        sourceId: result.providerId, sourcePageUrl: result.sourcePageUrl, creator: result.creator,
      })
      .expect(200);
    assert.equal(select.body.ok, true);
    assert.match(select.body.fileName, /^stock-pixabay-.*\.jpg$/);
    assert.equal(select.body.provenance.source, 'stock_pixabay');
    assert.equal(select.body.provenance.provider, 'pixabay');
    assert.equal(select.body.provenance.sourceId, '555');
    assert.equal(select.body.provenance.creator, 'testphotographer');
    assert.equal(select.body.provenance.licenseCode, 'pixabay');
    assert.equal(select.body.provenance.commercialUseAllowed, true);

    const asset = await prisma.asset.findFirst({ where: { projectId, fileName: select.body.fileName } });
    assert.ok(asset, 'committed Asset row should exist');
    assert.equal(asset.source, 'stock_pixabay');
    assert.equal(asset.provider, 'pixabay');
    assert.equal(asset.sourceId, '555');
    assert.equal(asset.sourcePageUrl, 'https://pixabay.com/photos/forest-555/');
    assert.equal(asset.licenseCode, 'pixabay');
    assert.equal(asset.commercialUseAllowed, true);
    assert.equal(asset.byteSize, 6n);

    // A redirect off the pixabay.com/cdn.pixabay.com allowlist must be rejected, not followed --
    // this is the SSRF guard on the download step, not the query-URL allowlist.
    global.fetch = async (url) => {
      const u = String(url);
      if (u.startsWith('https://pixabay.com/api/?')) return pixabaySearchResponse();
      return new Response(null, { status: 302, headers: { Location: 'https://evil.example.com/payload.jpg' } });
    };
    await request(app)
      .post(`/api/projects/${projectId}/stock/select`)
      .set(auth())
      .send({ provider: 'pixabay', fullUrl: 'https://pixabay.com/get/555/large.jpg' })
      .expect(502);

    // A non-pixabay host in fullUrl must be rejected before any fetch happens -- exercises the
    // allowlist itself, independent of the redirect guard above.
    await request(app)
      .post(`/api/projects/${projectId}/stock/select`)
      .set(auth())
      .send({ provider: 'pixabay', fullUrl: 'https://evil.example.com/steal.jpg' })
      .expect(400);
  } finally {
    global.fetch = original;
    await cleanupProject(projectId);
  }
});
