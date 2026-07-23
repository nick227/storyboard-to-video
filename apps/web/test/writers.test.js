const test = require('node:test');
const assert = require('node:assert/strict');
const { ScriptStore } = require('../src/storage/script-store');
const { MemoryWritersRepository } = require('../src/storage/writers-store');
const { createScriptsService } = require('../src/services/scripts.service');
const { createWritersService } = require('../src/services/writers.service');

test('writers service profiles and follow toggle', async () => {
  const scriptStore = new ScriptStore();
  const scripts = createScriptsService({ store: scriptStore });
  const writersStore = new MemoryWritersRepository();
  const writers = createWritersService({ store: writersStore, scripts });

  const author = writersStore.seedUser({ id: 'author-1', displayName: 'Homer', profileSlug: 'homer', bio: 'Epic poet' });
  const reader = writersStore.seedUser({ id: 'reader-1', displayName: 'Reader', profileSlug: 'reader' });

  const script = await scripts.create({
    title: 'Iliad',
    logline: 'Rage of Achilles',
    scriptText: 'Sing, muse',
  }, { tenantId: 't1', userId: author.id });
  await scripts.setVisibility(script.id, 'public', { tenantId: 't1' });

  const profile = await writers.getPublicProfile('homer', { viewerUserId: reader.id });
  assert.equal(profile.displayName, 'Homer');
  assert.equal(profile.bio, 'Epic poet');
  assert.equal(profile.followerCount, 0);
  assert.equal(profile.followedByMe, false);
  assert.equal(profile.scripts.length, 1);
  assert.equal(profile.scripts[0].slug, 'iliad');

  const followed = await writers.toggleFollow(author.id, { followerUserId: reader.id });
  assert.equal(followed.following, true);
  const after = await writers.getPublicProfile('homer', { viewerUserId: reader.id });
  assert.equal(after.followerCount, 1);
  assert.equal(after.followedByMe, true);

  const unfollowed = await writers.toggleFollow(author.id, { followerUserId: reader.id });
  assert.equal(unfollowed.following, false);

  await assert.rejects(
    () => writers.toggleFollow(reader.id, { followerUserId: reader.id }),
    (error) => error.code === 'CANNOT_FOLLOW_SELF',
  );

  const updated = await writers.updateProfile({ userId: author.id }, { bio: 'Singer of tales' });
  assert.equal(updated.bio, 'Singer of tales');
});
