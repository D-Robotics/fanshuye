import pg from 'pg';
import type { AppConfig } from '../config';

const { Pool } = pg;

export type DatabasePool = pg.Pool;
export type DatabaseClient = pg.PoolClient;

export function createPool(config: Pick<AppConfig, 'DATABASE_URL' | 'NODE_ENV'>): DatabasePool {
  return new Pool({
    connectionString: config.DATABASE_URL,
    max: config.NODE_ENV === 'test' ? 5 : 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: 'fanshuye-server',
    ssl: config.NODE_ENV === 'production' ? { rejectUnauthorized: true } : false,
  });
}

export async function inTransaction<T>(
  pool: DatabasePool,
  work: (client: DatabaseClient) => Promise<T>,
  options: { isolation?: 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE' } = {},
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (options.isolation) {
      await client.query(`SET TRANSACTION ISOLATION LEVEL ${options.isolation}`);
    }
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
