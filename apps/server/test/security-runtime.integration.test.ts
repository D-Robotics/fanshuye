import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { loadConfig, type AppConfig } from '../src/config';
import { migrate } from '../src/db/migrate';
import { createPool, type DatabasePool } from '../src/db/pool';
import { EventHub } from '../src/modules/sync/event-hub';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = describe.skipIf(!databaseUrl);
const { Pool } = pg;

type InjectedWebSocket = Awaited<ReturnType<FastifyInstance['injectWS']>>;

suite('immediate authorization revocation', () => {
  let administrativePool: InstanceType<typeof Pool>;
  let pool: DatabasePool;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let config: AppConfig;
  let eventHub: EventHub;
  const sockets = new Set<InjectedWebSocket>();
  const schema = `fanshuye_security_${randomUUID().replaceAll('-', '')}`;

  beforeAll(async () => {
    if (!databaseUrl) return;
    administrativePool = new Pool({ connectionString: databaseUrl });
    await administrativePool.query(`CREATE SCHEMA "${schema}"`);
    const scopedUrl = new URL(databaseUrl);
    scopedUrl.searchParams.set('options', `-c search_path=${schema},public`);
    config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: scopedUrl.toString(),
      SESSION_SECRET: 'security-integration-secret-that-is-at-least-32-characters',
      LOG_LEVEL: 'silent',
      ALLOWED_ORIGINS: 'tauri://localhost,http://localhost:1420',
    });
    pool = createPool(config);
    await migrate(pool);
    eventHub = new EventHub();
    app = await buildApp({ config, pool, eventHub });
    await app.ready();
  });

  afterAll(async () => {
    if (!databaseUrl) return;
    for (const socket of sockets) socket.terminate();
    await app?.close();
    await pool?.end();
    await administrativePool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await administrativePool.end();
  });

  it('applies member removal, role changes, logout and explicit session revocation to API and WebSocket access', async () => {
    const admin = await createUser('security-admin@fanshuye.test', 'Security Admin');
    const member = await createUser('security-member@fanshuye.test', 'Security Member');
    const workspace = await app.inject({
      method: 'POST',
      url: '/v1/workspaces',
      headers: bearer(admin.accessToken),
      payload: { commandId: randomUUID(), name: 'Security team', timezone: 'Asia/Shanghai' },
    });
    expect(workspace.statusCode).toBe(201);
    const workspaceId = workspace.json().workspace.id as string;
    const invitation = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/invitations`,
      headers: bearer(admin.accessToken),
      payload: {
        commandId: randomUUID(),
        email: member.email,
        role: 'MEMBER',
      },
    });
    expect(invitation.statusCode).toBe(201);
    const accepted = await app.inject({
      method: 'POST',
      url: '/v1/workspace-invitations/accept',
      headers: bearer(member.accessToken),
      payload: {
        commandId: randomUUID(),
        token: invitation.json().invitation.token as string,
      },
    });
    expect(accepted.statusCode).toBe(200);

    const promotedSocket = await openAuthorizedSocket(workspaceId, member.accessToken);
    const promotedClose = waitForClose(promotedSocket);
    const promoted = await app.inject({
      method: 'PATCH',
      url: `/v1/workspaces/${workspaceId}/members/${member.userId}`,
      headers: bearer(admin.accessToken),
      payload: { commandId: randomUUID(), role: 'ADMIN' },
    });
    expect(promoted.statusCode).toBe(200);
    expect(promoted.json().member.role).toBe('ADMIN');
    await expect(promotedClose).resolves.toEqual({
      code: 4003,
      reason: 'workspace access revoked',
    });
    const promotedAdminRequest = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/invitations`,
      headers: bearer(member.accessToken),
      payload: {
        commandId: randomUUID(),
        email: 'role-proof@fanshuye.test',
        role: 'MEMBER',
      },
    });
    expect(promotedAdminRequest.statusCode).toBe(201);

    const demotedSocket = await openAuthorizedSocket(workspaceId, member.accessToken);
    const demotedClose = waitForClose(demotedSocket);
    const demoted = await app.inject({
      method: 'PATCH',
      url: `/v1/workspaces/${workspaceId}/members/${member.userId}`,
      headers: bearer(admin.accessToken),
      payload: { commandId: randomUUID(), role: 'MEMBER' },
    });
    expect(demoted.statusCode).toBe(200);
    await expect(demotedClose).resolves.toEqual({
      code: 4003,
      reason: 'workspace access revoked',
    });
    const forbiddenAdminRequest = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/invitations`,
      headers: bearer(member.accessToken),
      payload: {
        commandId: randomUUID(),
        email: 'must-not-invite@fanshuye.test',
        role: 'MEMBER',
      },
    });
    expect(forbiddenAdminRequest.statusCode).toBe(403);

    const removedSocket = await openAuthorizedSocket(workspaceId, member.accessToken);
    const removedClose = waitForClose(removedSocket);
    const removed = await app.inject({
      method: 'DELETE',
      url: `/v1/workspaces/${workspaceId}/members/${member.userId}`,
      headers: bearer(admin.accessToken),
      payload: { commandId: randomUUID() },
    });
    expect(removed.statusCode).toBe(200);
    await expect(removedClose).resolves.toEqual({
      code: 4003,
      reason: 'workspace access revoked',
    });
    const removedApiRequest = await app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/tasks`,
      headers: bearer(member.accessToken),
    });
    expect(removedApiRequest.statusCode).toBe(403);

    const wrongOriginClose = openRejectedSocket(workspaceId, admin.accessToken, {
      origin: 'https://attacker.example',
    });
    await expect(wrongOriginClose).resolves.toEqual({ code: 4003, reason: 'authorization failed' });
    const missingProtocolClose = openRejectedSocket(workspaceId, admin.accessToken, {
      omitVersionProtocol: true,
    });
    await expect(missingProtocolClose).resolves.toEqual({
      code: 4003,
      reason: 'authorization failed',
    });

    const logoutSocket = await openAuthorizedSocket(workspaceId, admin.accessToken);
    const logoutClose = waitForClose(logoutSocket);
    const logout = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: bearer(admin.accessToken),
    });
    expect(logout.statusCode).toBe(204);
    await expect(logoutClose).resolves.toEqual({ code: 4001, reason: 'session revoked' });
    const afterLogout = await app.inject({
      method: 'GET',
      url: '/v1/workspaces',
      headers: bearer(admin.accessToken),
    });
    expect(afterLogout.statusCode).toBe(401);

    const controller = await login(admin.email);
    const target = await login(admin.email);
    const revokedSocket = await openAuthorizedSocket(workspaceId, target.accessToken);
    const revokedClose = waitForClose(revokedSocket);
    const revoked = await app.inject({
      method: 'DELETE',
      url: `/v1/auth/sessions/${target.sessionId}`,
      headers: bearer(controller.accessToken),
    });
    expect(revoked.statusCode).toBe(204);
    await expect(revokedClose).resolves.toEqual({ code: 4001, reason: 'session revoked' });
    const revokedApiRequest = await app.inject({
      method: 'GET',
      url: '/v1/workspaces',
      headers: bearer(target.accessToken),
    });
    expect(revokedApiRequest.statusCode).toBe(401);
    const controllerStillActive = await app.inject({
      method: 'GET',
      url: '/v1/workspaces',
      headers: bearer(controller.accessToken),
    });
    expect(controllerStillActive.statusCode).toBe(200);

    const securityEvents = await pool.query<{ event_type: string }>(
      `SELECT event_type FROM task_events
          WHERE workspace_id = $1
            AND event_type IN ('WorkspaceMemberRoleChanged', 'WorkspaceMemberRemoved')
          ORDER BY workspace_sequence`,
      [workspaceId],
    );
    expect(securityEvents.rows.map((row) => row.event_type)).toEqual([
      'WorkspaceMemberRoleChanged',
      'WorkspaceMemberRoleChanged',
      'WorkspaceMemberRemoved',
    ]);
  }, 60_000);

  async function createUser(
    email: string,
    displayName: string,
  ): Promise<{ accessToken: string; sessionId: string; userId: string; email: string }> {
    const registration = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email, displayName, password: 'SecurityPassword2026!' },
    });
    expect(registration.statusCode).toBe(201);
    const verification = await app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      payload: { token: registration.json().verificationToken as string },
    });
    expect(verification.statusCode).toBe(200);
    const session = await login(email);
    return {
      ...session,
      userId: registration.json().userId as string,
      email,
    };
  }

  async function login(email: string): Promise<{ accessToken: string; sessionId: string }> {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email, password: 'SecurityPassword2026!' },
    });
    expect(response.statusCode).toBe(200);
    return {
      accessToken: response.json().accessToken as string,
      sessionId: response.json().sessionId as string,
    };
  }

  async function openAuthorizedSocket(
    workspaceId: string,
    accessToken: string,
  ): Promise<InjectedWebSocket> {
    const previousCount = eventHub.connectionCount;
    const socket = await app.injectWS(`/v1/workspaces/${workspaceId}/ws`, {
      headers: {
        origin: 'tauri://localhost',
        'sec-websocket-protocol': `fanshuye.v1, bearer.${accessToken}`,
      },
    });
    sockets.add(socket);
    await waitUntil(() => eventHub.connectionCount === previousCount + 1);
    return socket;
  }

  async function openRejectedSocket(
    workspaceId: string,
    accessToken: string,
    options: { origin?: string; omitVersionProtocol?: boolean },
  ): Promise<{ code: number; reason: string }> {
    let resolveClose: ((value: { code: number; reason: string }) => void) | undefined;
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      resolveClose = resolve;
    });
    const socket = await app.injectWS(
      `/v1/workspaces/${workspaceId}/ws`,
      {
        headers: {
          ...(options.origin ? { origin: options.origin } : {}),
          'sec-websocket-protocol': options.omitVersionProtocol
            ? `bearer.${accessToken}`
            : `fanshuye.v1, bearer.${accessToken}`,
        },
      },
      {
        onInit(candidate) {
          candidate.once('close', (code: number, reason: Buffer) => {
            resolveClose?.({ code, reason: reason.toString() });
          });
        },
      },
    );
    sockets.add(socket);
    return closed;
  }
});

function bearer(accessToken: string): { authorization: string } {
  return { authorization: `Bearer ${accessToken}` };
}

function waitForClose(socket: InjectedWebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    socket.once('close', (code: number, reason: Buffer) =>
      resolve({ code, reason: reason.toString() }),
    );
  });
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for WebSocket authorization');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
