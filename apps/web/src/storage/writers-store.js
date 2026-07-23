const { Prisma } = require('../../dist/generated/prisma/client.js');
const { AppError } = require('../errors');
const { slugify, cleanText } = require('../shared/text');

function publicWriter(user) {
  if (!user) return null;
  return {
    id: user.id,
    displayName: user.displayName,
    profileSlug: user.profileSlug,
    bio: user.bio || '',
  };
}

class MemoryWritersRepository {
  constructor() {
    this.users = new Map();
    this.follows = new Set();
  }

  seedUser(user) {
    const row = {
      id: user.id,
      displayName: user.displayName || 'Writer',
      profileSlug: user.profileSlug || slugify(user.displayName || 'writer'),
      bio: user.bio || '',
    };
    this.users.set(row.id, row);
    return publicWriter(row);
  }

  followKey(followerId, followingId) {
    return `${followerId}:${followingId}`;
  }

  async findUserByProfileSlug(slug) {
    return publicWriter([...this.users.values()].find((u) => u.profileSlug === slug));
  }

  async findUserById(userId) {
    return publicWriter(this.users.get(userId));
  }

  async updateUserProfile(userId, patch = {}) {
    const user = this.users.get(userId);
    if (!user) throw new AppError('USER_NOT_FOUND', 'User not found', { status: 404 });
    if (patch.displayName != null) user.displayName = cleanText(patch.displayName, 200) || user.displayName;
    if (patch.bio != null) user.bio = cleanText(patch.bio, 500);
    if (patch.profileSlug != null) {
      const next = slugify(patch.profileSlug).slice(0, 80);
      if (!next) throw new AppError('INVALID_PROFILE_SLUG', 'Invalid profile slug', { status: 400 });
      const conflict = [...this.users.values()].find((u) => u.profileSlug === next && u.id !== userId);
      if (conflict) throw new AppError('PROFILE_SLUG_EXISTS', 'Profile slug already exists', { status: 409 });
      user.profileSlug = next;
    }
    return publicWriter(user);
  }

  async toggleFollow(followerId, followingId) {
    if (followerId === followingId) {
      throw new AppError('CANNOT_FOLLOW_SELF', 'Cannot follow yourself', { status: 400 });
    }
    if (!this.users.has(followingId)) throw new AppError('USER_NOT_FOUND', 'User not found', { status: 404 });
    const key = this.followKey(followerId, followingId);
    if (this.follows.has(key)) {
      this.follows.delete(key);
      return { following: false };
    }
    this.follows.add(key);
    return { following: true };
  }

  async countFollowers(userId) {
    let n = 0;
    for (const key of this.follows) if (key.endsWith(`:${userId}`)) n += 1;
    return n;
  }

  async countFollowing(userId) {
    let n = 0;
    for (const key of this.follows) if (key.startsWith(`${userId}:`)) n += 1;
    return n;
  }

  async hasFollow(followerId, followingId) {
    return this.follows.has(this.followKey(followerId, followingId));
  }
}

class PrismaWritersRepository {
  constructor(prisma) {
    this.prisma = prisma;
  }

  async findUserByProfileSlug(slug) {
    const user = await this.prisma.user.findUnique({ where: { profileSlug: String(slug || '') } });
    return publicWriter(user);
  }

  async findUserById(userId) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    return publicWriter(user);
  }

  async updateUserProfile(userId, patch = {}) {
    const data = {};
    if (patch.displayName != null) data.displayName = cleanText(patch.displayName, 200) || undefined;
    if (patch.bio != null) data.bio = cleanText(patch.bio, 500);
    if (patch.profileSlug != null) {
      const next = slugify(patch.profileSlug).slice(0, 80);
      if (!next) throw new AppError('INVALID_PROFILE_SLUG', 'Invalid profile slug', { status: 400 });
      data.profileSlug = next;
    }
    try {
      const user = await this.prisma.user.update({ where: { id: userId }, data });
      return publicWriter(user);
    } catch (cause) {
      if (cause instanceof Prisma.PrismaClientKnownRequestError && cause.code === 'P2025') {
        throw new AppError('USER_NOT_FOUND', 'User not found', { status: 404 });
      }
      if (cause instanceof Prisma.PrismaClientKnownRequestError && cause.code === 'P2002') {
        throw new AppError('PROFILE_SLUG_EXISTS', 'Profile slug already exists', { status: 409 });
      }
      throw cause;
    }
  }

  async toggleFollow(followerId, followingId) {
    if (followerId === followingId) {
      throw new AppError('CANNOT_FOLLOW_SELF', 'Cannot follow yourself', { status: 400 });
    }
    const target = await this.prisma.user.findUnique({ where: { id: followingId }, select: { id: true } });
    if (!target) throw new AppError('USER_NOT_FOUND', 'User not found', { status: 404 });
    const existing = await this.prisma.writerFollow.findUnique({
      where: { followerUserId_followingUserId: { followerUserId: followerId, followingUserId: followingId } },
    });
    if (existing) {
      await this.prisma.writerFollow.delete({
        where: { followerUserId_followingUserId: { followerUserId: followerId, followingUserId: followingId } },
      });
      return { following: false };
    }
    await this.prisma.writerFollow.create({
      data: { followerUserId: followerId, followingUserId: followingId },
    });
    return { following: true };
  }

  async countFollowers(userId) {
    return this.prisma.writerFollow.count({ where: { followingUserId: userId } });
  }

  async countFollowing(userId) {
    return this.prisma.writerFollow.count({ where: { followerUserId: userId } });
  }

  async hasFollow(followerId, followingId) {
    const row = await this.prisma.writerFollow.findUnique({
      where: { followerUserId_followingUserId: { followerUserId: followerId, followingUserId: followingId } },
    });
    return Boolean(row);
  }
}

module.exports = { MemoryWritersRepository, PrismaWritersRepository, publicWriter };
