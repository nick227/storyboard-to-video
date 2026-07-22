const fs = require('node:fs');
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} = require('@aws-sdk/client-s3');
const { AppError } = require('../errors');

function createR2BlobStore({ bucket, endpoint, accessKeyId, secretAccessKey, client }) {
  const s3 = client || new S3Client({
    region: 'auto',
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
  });

  async function head(storageKey) {
    try {
      await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: storageKey }));
      return true;
    } catch (error) {
      if (error?.$metadata?.httpStatusCode === 404 || error?.name === 'NotFound' || error?.Code === 'NotFound') {
        return false;
      }
      throw error;
    }
  }

  return {
    backend: 'r2',

    async put(storageKey, sourcePath, { mimeType, overwrite = false } = {}) {
      if (!overwrite && await head(storageKey)) {
        throw new AppError('ASSET_EXISTS', 'An asset with that filename already exists', { status: 409 });
      }
      await s3.send(new PutObjectCommand({
        Bucket: bucket,
        Key: storageKey,
        Body: fs.createReadStream(sourcePath),
        ContentType: mimeType || undefined,
      }));
      return { storageKey };
    },

    async getStream(storageKey) {
      try {
        const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: storageKey }));
        return result.Body;
      } catch (error) {
        if (error?.$metadata?.httpStatusCode === 404 || error?.name === 'NoSuchKey') {
          throw new AppError('ASSET_NOT_FOUND', 'Asset not found', { status: 404 });
        }
        throw error;
      }
    },

    async delete(storageKey) {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: storageKey }));
    },

    async exists(storageKey) {
      return head(storageKey);
    },

    resolveLocalPath() {
      return null;
    },
  };
}

module.exports = { createR2BlobStore };
