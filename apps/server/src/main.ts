import { fileURLToPath } from 'node:url';
import { buildApp } from './app';
import { loadConfig } from './config';
import { migrate } from './db/migrate';
import { createPool } from './db/pool';
import { createVerificationEmailSender } from './modules/auth/resend-email';

export async function startServer(): Promise<void> {
  const config = loadConfig();
  const verificationEmailSender = createVerificationEmailSender(config);
  const pool = createPool(config);
  await migrate(pool);
  const app = await buildApp({
    config,
    pool,
    ...(verificationEmailSender ? { verificationEmailSender } : {}),
  });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await pool.end();
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    await app.listen({ host: config.HOST, port: config.PORT });
  } catch (error) {
    app.log.fatal({ err: error }, 'server startup failed');
    await app.close();
    await pool.end();
    throw error;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await startServer();
}
