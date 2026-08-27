import { access, readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadConfig } from '../config';
import { createPool, inTransaction, type DatabasePool } from './pool';

async function resolveMigrationDirectory(): Promise<string> {
  const candidates = [
    join(process.cwd(), 'migrations'),
    join(process.cwd(), 'apps', 'server', 'migrations'),
    join(dirname(fileURLToPath(import.meta.url)), '../../migrations'),
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next location. Bundled and source execution have different import paths.
    }
  }
  throw new Error(`Migration directory was not found. Checked: ${candidates.join(', ')}`);
}

export async function migrate(pool: DatabasePool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )
  `);

  const migrationDirectory = await resolveMigrationDirectory();
  const files = (await readdir(migrationDirectory))
    .filter((file) => /^\d+.*\.sql$/.test(file))
    .sort();

  for (const file of files) {
    const applied = await pool.query<{ exists: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version = $1) AS exists',
      [file],
    );
    if (applied.rows[0]?.exists) continue;

    const sql = await readFile(join(migrationDirectory, file), 'utf8');
    await inTransaction(pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(671982164)');
      const raced = await client.query('SELECT 1 FROM schema_migrations WHERE version = $1', [
        file,
      ]);
      if (raced.rowCount) return;
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(version) VALUES ($1)', [file]);
    });
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config);
  try {
    await migrate(pool);
    process.stdout.write('Database migrations are up to date.\n');
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
