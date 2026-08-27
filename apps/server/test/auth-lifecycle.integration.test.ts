import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { loadConfig, type AppConfig } from '../src/config';
import { migrate } from '../src/db/migrate';
import { createPool, type DatabasePool } from '../src/db/pool';
import { hashToken } from '../src/lib/security';
import type { VerificationEmail, VerificationEmailSender } from '../src/modules/auth/email';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = describe.skipIf(!databaseUrl);
const { Pool } = pg;

suite('PostgreSQL authentication lifecycle', () => {
  let administrativePool: InstanceType<typeof Pool>;
  let pool: DatabasePool;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let config: AppConfig;
  const delivered: VerificationEmail[] = [];
  let rejectNextDelivery = false;
  let rejectedDeliveryToken: string | undefined;
  const schema = `fanshuye_auth_${randomUUID().replaceAll('-', '')}`;
  const emailSender: VerificationEmailSender = {
    async sendVerificationEmail(message) {
      if (rejectNextDelivery) {
        rejectNextDelivery = false;
        rejectedDeliveryToken = message.token;
        throw new Error(`injected email provider rejection: ${message.token}`);
      }
      delivered.push(message);
    },
  };

  beforeAll(async () => {
    if (!databaseUrl) return;
    administrativePool = new Pool({ connectionString: databaseUrl });
    await administrativePool.query(`CREATE SCHEMA "${schema}"`);
    const scopedUrl = new URL(databaseUrl);
    scopedUrl.searchParams.set('options', `-c search_path=${schema},public`);
    const databaseConfig = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: scopedUrl.toString(),
      SESSION_SECRET: 'auth-integration-secret-that-is-at-least-32-characters',
      LOG_LEVEL: 'silent',
    });
    pool = createPool(databaseConfig);
    await migrate(pool);
    config = { ...databaseConfig, NODE_ENV: 'production' };
    app = await buildApp({ config, pool, verificationEmailSender: emailSender });
    await app.ready();
  });

  afterAll(async () => {
    if (!databaseUrl) return;
    await app?.close();
    await pool?.end();
    await administrativePool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await administrativePool.end();
  });

  it('refuses production startup without a real verification-email delivery adapter', async () => {
    await expect(buildApp({ config, pool })).rejects.toThrow(
      'Production startup requires a VerificationEmailSender',
    );
  });

  it('rolls registration back when the email provider rejects delivery', async () => {
    rejectNextDelivery = true;
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: 'delivery-failed@fanshuye.test',
        displayName: 'Delivery Failure',
        password: 'StrongPassword2026!',
      },
    });
    expect(response.statusCode).toBe(500);
    expect(rejectedDeliveryToken).toBeDefined();
    expect(response.body).not.toContain(rejectedDeliveryToken);
    expect(response.body).not.toContain('injected email provider rejection');
    const persisted = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM users WHERE email = $1`,
      ['delivery-failed@fanshuye.test'],
    );
    expect(persisted.rows[0]?.count).toBe('0');
  });

  it('verifies email once, uses Argon2id, rotates refresh tokens and revokes sessions', async () => {
    const email = `Auth-Lifecycle-${randomUUID()}@Fanshuye.Test`;
    const password = 'StrongPassword2026!';
    const registration = await register(email, 'Auth User', password);
    expect(registration.body.verificationToken).toBeNull();
    expect(registration.body.verificationRequired).toBe(true);

    const verificationEmail = delivered.at(-1);
    expect(verificationEmail).toMatchObject({
      email: email.toLowerCase(),
      displayName: 'Auth User',
    });
    expect(verificationEmail?.token).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(verificationEmail?.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const persisted = await pool.query<{
      email: string;
      email_verified_at: Date | null;
      password_hash: string;
      token_hash: string;
    }>(
      `SELECT u.email::text, u.email_verified_at, p.password_hash, evt.token_hash
         FROM users u
         JOIN password_credentials p ON p.user_id = u.id
         JOIN email_verification_tokens evt ON evt.user_id = u.id
        WHERE u.id = $1`,
      [registration.body.userId],
    );
    expect(persisted.rows[0]).toMatchObject({
      email: email.toLowerCase(),
      email_verified_at: null,
      token_hash: hashToken(verificationEmail!.token),
    });
    expect(persisted.rows[0]?.password_hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=3,p=1\$/);
    expect(persisted.rows[0]?.password_hash).not.toContain(password);

    const beforeVerification = await login(email, password);
    expect(beforeVerification.statusCode).toBe(403);
    expect(beforeVerification.json().error.code).toBe('EMAIL_NOT_VERIFIED');
    const wrongPassword = await login(email, 'WrongPassword2026!');
    expect(wrongPassword.statusCode).toBe(401);
    expect(wrongPassword.json().error.code).toBe('INVALID_CREDENTIALS');

    const invalidVerification = await app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      payload: { token: 'invalid-verification-token-value' },
    });
    expect(invalidVerification.statusCode).toBe(400);
    const verified = await app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      payload: { token: verificationEmail!.token },
    });
    expect(verified.statusCode).toBe(200);
    const replayedVerification = await app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      payload: { token: verificationEmail!.token },
    });
    expect(replayedVerification.statusCode).toBe(400);

    const firstLogin = await login(email, password);
    expect(firstLogin.statusCode).toBe(200);
    const first = firstLogin.json<SessionResponse>();
    const refresh = await refreshSession(first.refreshToken);
    expect(refresh.statusCode).toBe(200);
    const rotated = refresh.json<SessionResponse>();
    expect(rotated.sessionId).toBe(first.sessionId);
    expect(rotated.refreshToken).not.toBe(first.refreshToken);
    expect((await refreshSession(first.refreshToken)).statusCode).toBe(401);

    const competing = await Promise.all([
      refreshSession(rotated.refreshToken),
      refreshSession(rotated.refreshToken),
    ]);
    expect(competing.map((response) => response.statusCode).sort()).toEqual([200, 401]);
    const winner = competing.find((response) => response.statusCode === 200)!;
    const active = winner.json<SessionResponse>();
    expect(active.sessionId).toBe(first.sessionId);

    const controllerLogin = await login(email, password);
    expect(controllerLogin.statusCode).toBe(200);
    const controller = controllerLogin.json<SessionResponse>();
    const revoked = await app.inject({
      method: 'DELETE',
      url: `/v1/auth/sessions/${active.sessionId}`,
      headers: bearer(controller.accessToken),
    });
    expect(revoked.statusCode).toBe(204);
    expect((await listWorkspaces(active.accessToken)).statusCode).toBe(401);
    expect((await refreshSession(active.refreshToken)).statusCode).toBe(401);
    expect((await listWorkspaces(controller.accessToken)).statusCode).toBe(200);

    const logout = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: bearer(controller.accessToken),
    });
    expect(logout.statusCode).toBe(204);
    expect((await listWorkspaces(controller.accessToken)).statusCode).toBe(401);
    expect((await refreshSession(controller.refreshToken)).statusCode).toBe(401);
  }, 60_000);

  it('does not allow one user to revoke another user session', async () => {
    const first = await createVerifiedSession(`revoker-${randomUUID()}@fanshuye.test`);
    const second = await createVerifiedSession(`target-${randomUUID()}@fanshuye.test`);
    const crossUserRevoke = await app.inject({
      method: 'DELETE',
      url: `/v1/auth/sessions/${second.sessionId}`,
      headers: bearer(first.accessToken),
    });
    expect(crossUserRevoke.statusCode).toBe(404);
    expect((await listWorkspaces(second.accessToken)).statusCode).toBe(200);
  }, 60_000);

  async function register(email: string, displayName: string, password: string) {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email, displayName, password },
    });
    expect(response.statusCode).toBe(201);
    return {
      response,
      body: response.json<{
        userId: string;
        verificationToken: null;
        verificationRequired: true;
      }>(),
    };
  }

  async function createVerifiedSession(email: string): Promise<SessionResponse> {
    const password = 'StrongPassword2026!';
    await register(email, 'Session User', password);
    const verificationEmail = delivered.at(-1)!;
    const verified = await app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      payload: { token: verificationEmail.token },
    });
    expect(verified.statusCode).toBe(200);
    const response = await login(email, password);
    expect(response.statusCode).toBe(200);
    return response.json<SessionResponse>();
  }

  function login(email: string, password: string) {
    return app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email, password },
    });
  }

  function refreshSession(refreshToken: string) {
    return app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken },
    });
  }

  function listWorkspaces(accessToken: string) {
    return app.inject({
      method: 'GET',
      url: '/v1/workspaces',
      headers: bearer(accessToken),
    });
  }
});

interface SessionResponse {
  sessionId: string;
  accessToken: string;
  refreshToken: string;
}

function bearer(accessToken: string): { authorization: string } {
  return { authorization: `Bearer ${accessToken}` };
}
