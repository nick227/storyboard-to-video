process.env.AUTH_TOKENS = 'alice-token:alice,bob-token:bob';
process.env.ADMIN_OWNER_IDS = 'alice';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const request = require('supertest');
const { app, projectStore, prisma } = require('../server');

const auth = (token = 'alice-token') => ({ Authorization: `Bearer ${token}` });
const id = (label) => `test-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`;

async function cleanupProject(projectId) {
  await prisma.project.deleteMany({ where: { id: projectId } });
  await prisma.projectTombstone.deleteMany({ where: { projectId } });
  fs.rmSync(projectStore.projectDir(projectId), { recursive: true, force: true });
}

test('Image Library Endpoints', async (t) => {
  const projectId = id('lib');
  t.after(() => cleanupProject(projectId));

  // Create a project
  await request(app)
    .post('/api/projects')
    .set(auth())
    .send({ id: projectId, title: 'Library Test Project' })
    .expect(201);

  // 1. Get empty library
  const libraryRes = await request(app)
    .get(`/api/projects/${projectId}/assets/library`)
    .set(auth())
    .expect(200);

  assert.equal(libraryRes.body.ok, true);
  assert.ok(Array.isArray(libraryRes.body.uploads));
  assert.ok(Array.isArray(libraryRes.body.generations));

  // 2. Upload reference image to library
  const dummyBuffer = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64'
  );
  
  const uploadRes = await request(app)
    .post(`/api/projects/${projectId}/images/upload-reference`)
    .set(auth())
    .attach('files', dummyBuffer, 'test-image.png')
    .expect(200);

  assert.equal(uploadRes.body.ok, true);
  assert.ok(Array.isArray(uploadRes.body.files));
  assert.equal(uploadRes.body.files.length, 1);
  assert.match(uploadRes.body.files[0].path, /upload-ref/);

  // 3. Generate a reference image (stub mode)
  const generateRes = await request(app)
    .post(`/api/projects/${projectId}/images/generate-reference`)
    .set(auth())
    .send({
      userPrompt: 'A simple test prompt',
      provider: 'stub',
      styleId: 'basic-cartoon'
    });

  if (generateRes.status !== 200) {
    console.error('generate-reference failed:', generateRes.status, generateRes.body || generateRes.text);
  }
  assert.equal(generateRes.status, 200);

  assert.equal(generateRes.body.ok, true);
  assert.ok(generateRes.body.path);
  assert.match(generateRes.body.fileName, /^reference-/);

  // 4. Check library lists now contain uploaded and generated images
  const libraryUpdatedRes = await request(app)
    .get(`/api/projects/${projectId}/assets/library`)
    .set(auth())
    .expect(200);

  assert.ok(libraryUpdatedRes.body.uploads.some(f => f.fileName.includes('upload-ref')));
  assert.ok(libraryUpdatedRes.body.generations.some(f => f.fileName.includes('reference-')));

  // 5. Upload scene image
  // Create a scene first
  const project = await projectStore.read(projectId);
  const sceneId = 'scene-1';
  project.scenes = [{ id: sceneId, title: 'Scene 1', versions: [], activeVersionIndex: 0 }];
  await projectStore.write(projectId, project, { expectedRevision: project.revision });

  const sceneUploadRes = await request(app)
    .post(`/api/projects/${projectId}/scenes/${sceneId}/images/upload`)
    .set(auth())
    .attach('file', dummyBuffer, 'scene-upload.png')
    .expect(200);

  assert.equal(sceneUploadRes.body.ok, true);
  assert.equal(sceneUploadRes.body.scene.shots[0].versions.length, 1);
  assert.match(sceneUploadRes.body.scene.shots[0].versions[0].path, /scene-image-/);
  assert.equal(sceneUploadRes.body.scene.shots[0].activeVersionIndex, 0);

  // 6. Retrieve past storyboards (create another project with a scene version first)
  const pastProjectId = id('past');
  t.after(() => cleanupProject(pastProjectId));
  await request(app)
    .post('/api/projects')
    .set(auth())
    .send({ id: pastProjectId, title: 'Past Project' })
    .expect(201);
    
  const pastProject = await projectStore.read(pastProjectId);
  pastProject.scenes = [{
    id: 'past-scene-1',
    title: 'Past Scene 1',
    versions: [{ path: `/projects/${pastProjectId}/assets/scene-images/past.png`, prompt: 'Past scene' }],
    activeVersionIndex: 0
  }];
  await projectStore.write(pastProjectId, pastProject, { expectedRevision: pastProject.revision });

  const pastRes = await request(app)
    .get(`/api/projects/${projectId}/assets/past-storyboards`)
    .set(auth())
    .expect(200);

  assert.equal(pastRes.body.ok, true);
  assert.ok(Array.isArray(pastRes.body.pastStoryboards));
  assert.ok(pastRes.body.pastStoryboards.some(item => item.projectId === pastProjectId));
});

test('Cross-project asset reuse and deletion durability', async (t) => {
  const projectAId = id('proja');
  const projectBId = id('projb');
  t.after(() => {
    cleanupProject(projectAId);
    cleanupProject(projectBId);
  });

  await request(app).post('/api/projects').set(auth()).send({ id: projectAId, title: 'Project A' }).expect(201);
  await request(app).post('/api/projects').set(auth()).send({ id: projectBId, title: 'Project B' }).expect(201);

  const dummyBuffer = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64'
  );

  const uploadRes = await request(app)
    .post(`/api/projects/${projectAId}/images/upload-reference`)
    .set(auth())
    .attach('files', dummyBuffer, 'source-a.png')
    .expect(200);

  const assetAPath = uploadRes.body.files[0].path;

  const projB = await projectStore.read(projectBId);
  projB.scenes = [{ id: 'scene-b', title: 'Scene B', versions: [], activeVersionIndex: 0 }];
  await projectStore.write(projectBId, projB, { expectedRevision: projB.revision });

  const resolvedA = await projectStore.resolveAsset(projectAId, assetAPath);
  assert.ok(resolvedA);
  assert.ok(fs.existsSync(resolvedA.sourcePath));

  const fileContent = fs.readFileSync(resolvedA.sourcePath);
  const uploadBRes = await request(app)
    .post(`/api/projects/${projectBId}/scenes/scene-b/images/upload`)
    .set(auth())
    .attach('file', fileContent, 'reused.png')
    .expect(200);

  const assetBPath = uploadBRes.body.scene.shots[0].versions[0].path;

  assert.match(assetBPath, /scene-images/);
  assert.notEqual(assetBPath, assetAPath);

  const resolvedBBefore = await projectStore.resolveAsset(projectBId, assetBPath);
  assert.ok(resolvedBBefore);
  assert.ok(fs.existsSync(resolvedBBefore.sourcePath));

  await request(app).delete(`/api/projects/${projectAId}`).set(auth()).expect(204);

  const resolvedAAfter = await projectStore.resolveAsset(projectAId, assetAPath).catch(() => null);
  assert.ok(!resolvedAAfter);

  const resolvedBAfter = await projectStore.resolveAsset(projectBId, assetBPath);
  assert.ok(resolvedBAfter);
  assert.ok(fs.existsSync(resolvedBAfter.sourcePath));
});
