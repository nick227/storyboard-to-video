const test = require('node:test');
const assert = require('node:assert/strict');
const { json, serializable } = require('../src/storage/prisma-shared');

function fakePrisma(transactionImpl) {
  return { $transaction: transactionImpl };
}

test('serializable retries on Prisma P2034 serialization-failure conflicts and eventually succeeds', async () => {
  let attempts = 0;
  const prisma = fakePrisma(async (work) => {
    attempts += 1;
    if (attempts < 3) { const error = new Error('could not serialize access due to concurrent update'); error.code = 'P2034'; throw error; }
    return work();
  });
  const result = await serializable(prisma, async () => 'settled');
  assert.equal(result, 'settled');
  assert.equal(attempts, 3);
});

test('serializable retries on message-matched write conflict / deadlock errors without a P2034 code', async () => {
  let attempts = 0;
  const prisma = fakePrisma(async (work) => {
    attempts += 1;
    if (attempts === 1) throw new Error('write conflict detected while locking row');
    if (attempts === 2) throw new Error('deadlock detected during transaction');
    return work();
  });
  const result = await serializable(prisma, async () => 'ok');
  assert.equal(result, 'ok');
  assert.equal(attempts, 3);
});

test('serializable gives up after 4 attempts when conflicts never clear', async () => {
  let attempts = 0;
  const prisma = fakePrisma(async () => {
    attempts += 1;
    const error = new Error('could not serialize access due to concurrent update');
    error.code = 'P2034';
    throw error;
  });
  await assert.rejects(() => serializable(prisma, async () => 'unreachable'), (error) => error.code === 'P2034');
  assert.equal(attempts, 4);
});

test('serializable propagates non-retryable errors immediately without retrying', async () => {
  let attempts = 0;
  const prisma = fakePrisma(async () => {
    attempts += 1;
    throw new Error('foreign key constraint violated');
  });
  await assert.rejects(() => serializable(prisma, async () => 'unreachable'), (error) => error.message === 'foreign key constraint violated');
  assert.equal(attempts, 1);
});

test('serializable propagates a Prisma error whose code is not P2034 even if it looks transactional', async () => {
  let attempts = 0;
  const prisma = fakePrisma(async () => {
    attempts += 1;
    const error = new Error('unique constraint failed on the fields');
    error.code = 'P2002';
    throw error;
  });
  await assert.rejects(() => serializable(prisma, async () => 'unreachable'), (error) => error.code === 'P2002');
  assert.equal(attempts, 1);
});

test('serializable requests Serializable isolation and forwards the work function to $transaction', async () => {
  let receivedOptions;
  let receivedWork;
  const prisma = fakePrisma(async (work, options) => { receivedWork = work; receivedOptions = options; return work(); });
  const marker = async () => 42;
  const result = await serializable(prisma, marker);
  assert.equal(result, 42);
  assert.equal(receivedWork, marker);
  assert.deepEqual(receivedOptions, { isolationLevel: 'Serializable' });
});

test('serializable handles two overlapping calls with independent transient conflicts', async () => {
  let attemptsA = 0;
  let attemptsB = 0;
  const prisma = fakePrisma(async (work) => {
    if (work.name === 'a') {
      attemptsA += 1;
      if (attemptsA < 2) { const error = new Error('write conflict'); throw error; }
      return work();
    }
    attemptsB += 1;
    if (attemptsB < 4) { const error = new Error('deadlock'); throw error; }
    return work();
  });
  const [resultA, resultB] = await Promise.all([
    serializable(prisma, async function a() { return 'a-done'; }),
    serializable(prisma, async function b() { return 'b-done'; }),
  ]);
  assert.equal(resultA, 'a-done');
  assert.equal(resultB, 'b-done');
  assert.equal(attemptsA, 2);
  assert.equal(attemptsB, 4);
});

test('json passes through null/undefined and deep-clones plain values', () => {
  assert.equal(json(null), undefined);
  assert.equal(json(undefined), undefined);
  const input = { a: 1, nested: { b: 2 } };
  const cloned = json(input);
  assert.deepEqual(cloned, input);
  assert.notEqual(cloned, input);
  assert.notEqual(cloned.nested, input.nested);
});
