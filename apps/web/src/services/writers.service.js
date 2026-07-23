const { AppError } = require('../errors');

function createWritersService({ store, scripts }) {
  async function getPublicProfile(profileSlug, { viewerUserId } = {}) {
    const user = await store.findUserByProfileSlug(profileSlug);
    if (!user) throw new AppError('USER_NOT_FOUND', 'Writer not found', { status: 404 });
    const [followerCount, followingCount, followedByMe, scriptRows] = await Promise.all([
      store.countFollowers(user.id),
      store.countFollowing(user.id),
      viewerUserId ? store.hasFollow(viewerUserId, user.id) : false,
      scripts.listPublic({ createdByUserId: user.id, limit: 50 }),
    ]);
    return {
      id: user.id,
      displayName: user.displayName,
      profileSlug: user.profileSlug,
      bio: user.bio || '',
      followerCount,
      followingCount,
      followedByMe: Boolean(followedByMe),
      scripts: scriptRows,
    };
  }

  async function getMe({ userId }) {
    const user = await store.findUserById(userId);
    if (!user) throw new AppError('USER_NOT_FOUND', 'User not found', { status: 404 });
    const [followerCount, followingCount] = await Promise.all([
      store.countFollowers(user.id),
      store.countFollowing(user.id),
    ]);
    return { ...user, followerCount, followingCount };
  }

  async function updateProfile({ userId }, patch) {
    return store.updateUserProfile(userId, patch);
  }

  async function toggleFollow(followingUserId, { followerUserId }) {
    return store.toggleFollow(followerUserId, followingUserId);
  }

  return { getPublicProfile, getMe, updateProfile, toggleFollow };
}

module.exports = { createWritersService };
