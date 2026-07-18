function json(value) { return value == null ? undefined : JSON.parse(JSON.stringify(value)); }

async function serializable(prisma, work) {
  for (let attempt = 1; ; attempt += 1) {
    try { return await prisma.$transaction(work, { isolationLevel: 'Serializable' }); }
    catch (error) {
      if (attempt >= 4 || (error.code !== 'P2034' && !/write conflict|deadlock/i.test(error.message))) throw error;
    }
  }
}

module.exports = { json, serializable };
