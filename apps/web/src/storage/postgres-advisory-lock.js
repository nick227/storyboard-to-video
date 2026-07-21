const { Pool } = require('pg');

class PostgresAdvisoryLock {
  constructor(connectionString, { pool } = {}) {
    this.pool = pool || new Pool({ connectionString, max: 1, allowExitOnIdle: true });
  }

  async tryRun(name, operation) {
    const client = await this.pool.connect();
    let acquired = false;
    try {
      const result = await client.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired', [name]);
      acquired = result.rows[0]?.acquired === true;
      if (!acquired) return { acquired: false };
      return { acquired: true, value: await operation() };
    } finally {
      if (acquired) await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [name]).catch(() => null);
      client.release();
    }
  }

  async close() { await this.pool.end(); }
}

module.exports = { PostgresAdvisoryLock };
