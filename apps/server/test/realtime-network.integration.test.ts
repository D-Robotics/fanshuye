import { randomUUID } from 'node:crypto';
import {
  IncrementalSyncResponseSchema,
  RealtimeServerMessageSchema,
  SyncSnapshotResponseSchema,
  TaskCommandResultSchema,
  TaskDetailResponseSchema,
  UuidSchema,
  type IncrementalSyncResponse,
  type RealtimeServerMessage,
  type TaskCommandResult,
  type WireTaskProjection,
} from '@fanshuye/contracts';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import WebSocket, { type RawData } from 'ws';
import { z } from 'zod';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { migrate } from '../src/db/migrate';
import { createPool, type DatabasePool } from '../src/db/pool';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = describe.skipIf(!databaseUrl);
const { Pool } = pg;
const allowedOrigin = 'tauri://localhost';
const realtimeDeadlineMs = 2_000;

const registrationResponseSchema = z.object({
  userId: UuidSchema,
  verificationToken: z.string().min(16),
});
const loginResponseSchema = z.object({
  accessToken: z.string().min(16),
  sessionId: UuidSchema,
});
const workspaceResponseSchema = z.object({ workspace: z.object({ id: UuidSchema }) });
const invitationResponseSchema = z.object({
  invitation: z.object({ token: z.string().min(16) }),
});
const healthResponseSchema = z.object({
  status: z.literal('ok'),
  database: z.literal('ready'),
  realtimeConnections: z.number().int().nonnegative(),
});

interface RealtimeObservation {
  message: RealtimeServerMessage;
  receivedAt: number;
}

interface MessageWaiter {
  predicate: (observation: RealtimeObservation) => boolean;
  resolve: (observation: RealtimeObservation) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

suite('real-network two-client synchronization', () => {
  let administrativePool: InstanceType<typeof Pool>;
  let pool: DatabasePool;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let baseUrl: string;
  const schema = `fanshuye_realtime_${randomUUID().replaceAll('-', '')}`;
  const clients = new Set<NetworkSyncClient>();

  beforeAll(async () => {
    if (!databaseUrl) return;
    administrativePool = new Pool({ connectionString: databaseUrl });
    await administrativePool.query(`CREATE SCHEMA "${schema}"`);
    const scopedUrl = new URL(databaseUrl);
    scopedUrl.searchParams.set('options', `-c search_path=${schema},public`);
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: scopedUrl.toString(),
      SESSION_SECRET: 'realtime-network-secret-that-is-at-least-32-characters',
      LOG_LEVEL: 'silent',
      ALLOWED_ORIGINS: allowedOrigin,
    });
    pool = createPool(config);
    await migrate(pool);
    app = await buildApp({ config, pool });
    baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  });

  afterEach(async () => {
    await Promise.all([...clients].map((client) => client.disconnectRealtime()));
    clients.clear();
  });

  afterAll(async () => {
    if (!databaseUrl) return;
    await app?.close();
    await pool?.end();
    await administrativePool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await administrativePool.end();
  });

  it('makes a committed task visible within two seconds and fills disconnected changes by cursor', async () => {
    const admin = await registerAndLogin(baseUrl, 'realtime-admin@fanshuye.test', 'Realtime Admin');
    const member = await registerAndLogin(
      baseUrl,
      'realtime-member@fanshuye.test',
      'Realtime Member',
    );
    const clientA = new NetworkSyncClient(baseUrl, admin.accessToken);
    const clientB = new NetworkSyncClient(baseUrl, member.accessToken);
    clients.add(clientA);
    clients.add(clientB);

    const workspace = workspaceResponseSchema.parse(
      await clientA.request('/v1/workspaces', {
        method: 'POST',
        body: JSON.stringify({
          commandId: randomUUID(),
          name: 'Realtime integration team',
          timezone: 'Asia/Shanghai',
        }),
      }),
    );
    const workspaceId = workspace.workspace.id;
    const invitation = invitationResponseSchema.parse(
      await clientA.request(`/v1/workspaces/${workspaceId}/invitations`, {
        method: 'POST',
        body: JSON.stringify({
          commandId: randomUUID(),
          email: member.email,
          role: 'MEMBER',
        }),
      }),
    );
    await clientB.request('/v1/workspace-invitations/accept', {
      method: 'POST',
      body: JSON.stringify({ commandId: randomUUID(), token: invitation.invitation.token }),
    });

    await Promise.all([clientA.loadSnapshot(workspaceId), clientB.loadSnapshot(workspaceId)]);
    await Promise.all([clientA.connectRealtime(workspaceId), clientB.connectRealtime(workspaceId)]);
    expect(clientA.negotiatedProtocol).toBe('fanshuye.v1');
    expect(clientB.negotiatedProtocol).toBe('fanshuye.v1');
    await waitForConnectionCount(baseUrl, 2);

    const createCommandId = randomUUID();
    const observedByA = clientA.waitForEvent(createCommandId, realtimeDeadlineMs);
    const observedByB = clientB.waitForEvent(createCommandId, realtimeDeadlineMs);
    const submittedAt = performance.now();
    const created = await clientA.createTask(workspaceId, {
      commandId: createCommandId,
      title: 'Two-client realtime visibility',
    });
    const [senderEvent, receiverEvent] = await Promise.all([observedByA, observedByB]);
    expect(senderEvent.message).toMatchObject({ type: 'event' });
    expect(receiverEvent.message).toMatchObject({
      type: 'event',
      event: {
        commandId: createCommandId,
        aggregateId: created.task.id,
        eventType: 'TaskCreated',
      },
    });

    const remainingVisibilityBudget = Math.max(
      1,
      Math.floor(realtimeDeadlineMs - (performance.now() - submittedAt)),
    );
    await clientB.refreshTask(
      workspaceId,
      created.task.id,
      AbortSignal.timeout(remainingVisibilityBudget),
    );
    const visibleAfterMs = performance.now() - submittedAt;
    expect(visibleAfterMs).toBeLessThan(realtimeDeadlineMs);
    expect(clientB.task(created.task.id)).toMatchObject({
      id: created.task.id,
      title: 'Two-client realtime visibility',
      version: 1,
    });

    const disconnectedCursor = clientB.cursor;
    expect(disconnectedCursor).toBe(created.cursor);
    await clientB.disconnectRealtime();
    await waitForConnectionCount(baseUrl, 1);

    const importanceCommandId = randomUUID();
    const importanceChanged = await clientA.executeTaskCommand(workspaceId, created.task.id, {
      type: 'SetImportance',
      commandId: importanceCommandId,
      expectedVersion: 1,
      importance: 5,
    });
    const startCommandId = randomUUID();
    const started = await clientA.executeTaskCommand(workspaceId, created.task.id, {
      type: 'StartTask',
      commandId: startCommandId,
      expectedVersion: importanceChanged.task.version,
    });
    expect(started.task).toMatchObject({ version: 3, status: 'IN_PROGRESS', importance: 5 });

    const recovered = await clientB.recoverFromCursor(workspaceId, disconnectedCursor);
    expect(recovered.events.map((event) => event.commandId)).toEqual([
      importanceCommandId,
      startCommandId,
    ]);
    expect(recovered.events.map((event) => event.workspaceSequence)).toEqual(
      [...recovered.events]
        .map((event) => event.workspaceSequence)
        .sort((left, right) => left - right),
    );
    expect(recovered.nextCursor).toBe(started.cursor);
    expect(clientB.cursor).toBe(started.cursor);
    expect(clientB.task(created.task.id)).toMatchObject({
      id: created.task.id,
      version: 3,
      status: 'IN_PROGRESS',
      importance: 5,
      owner: { id: admin.userId },
    });

    await clientB.connectRealtime(workspaceId);
    await waitForConnectionCount(baseUrl, 2);
    process.stdout.write(
      `${JSON.stringify({
        evidence: 'two-client-realtime',
        visibleAfterMs: Number(visibleAfterMs.toFixed(3)),
        disconnectedCursor,
        recoveredSequences: recovered.events.map((event) => event.workspaceSequence),
        recoveredCursor: recovered.nextCursor,
        negotiatedProtocol: clientB.negotiatedProtocol,
      })}\n`,
    );
  }, 60_000);
});

class NetworkSyncClient {
  readonly #tasks = new Map<string, WireTaskProjection>();
  readonly #inbox: RealtimeObservation[] = [];
  readonly #waiters = new Set<MessageWaiter>();
  #socket: WebSocket | null = null;
  #cursor = 0;

  constructor(
    private readonly baseUrl: string,
    private readonly accessToken: string,
  ) {}

  get cursor(): number {
    return this.#cursor;
  }

  get negotiatedProtocol(): string | null {
    return this.#socket?.protocol ?? null;
  }

  task(taskId: string): WireTaskProjection | undefined {
    return this.#tasks.get(taskId);
  }

  async request(path: string, init: RequestInit = {}): Promise<unknown> {
    return requestJson(this.baseUrl, path, {
      ...init,
      headers: {
        authorization: `Bearer ${this.accessToken}`,
        'content-type': 'application/json',
        ...init.headers,
      },
    });
  }

  async loadSnapshot(workspaceId: string): Promise<void> {
    const snapshot = SyncSnapshotResponseSchema.parse(
      await this.request(`/v1/workspaces/${workspaceId}/sync/snapshot`),
    );
    this.#cursor = snapshot.snapshotCursor;
    this.#tasks.clear();
    for (const task of snapshot.tasks) this.#tasks.set(task.id, task);
  }

  async connectRealtime(workspaceId: string): Promise<void> {
    if (this.#socket !== null) throw new Error('Realtime connection is already open');
    const url = new URL(`/v1/workspaces/${workspaceId}/ws`, this.baseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url, ['fanshuye.v1', `bearer.${this.accessToken}`], {
      origin: allowedOrigin,
      handshakeTimeout: realtimeDeadlineMs,
    });
    this.#socket = socket;
    socket.on('message', (data) => this.#receive(data));
    socket.on('error', (error) => this.#failWaiters(toError(error)));
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    const ready = await this.#waitFor(
      (observation) =>
        observation.message.type === 'ready' && observation.message.workspaceId === workspaceId,
      realtimeDeadlineMs,
    );
    expect(ready.message).toMatchObject({
      type: 'ready',
      workspaceId,
      schemaVersion: 1,
    });
  }

  async disconnectRealtime(): Promise<void> {
    const socket = this.#socket;
    this.#socket = null;
    if (socket === null || socket.readyState === WebSocket.CLOSED) return;
    if (socket.readyState === WebSocket.CONNECTING) {
      socket.terminate();
      return;
    }
    await new Promise<void>((resolve) => {
      socket.once('close', () => resolve());
      socket.close(1000, 'integration client disconnected');
    });
  }

  async waitForEvent(commandId: string, timeoutMs: number): Promise<RealtimeObservation> {
    const observation = await this.#waitFor(
      (candidate) =>
        candidate.message.type === 'event' && candidate.message.event.commandId === commandId,
      timeoutMs,
    );
    if (observation.message.type !== 'event') throw new Error('Expected an event message');
    this.#cursor = Math.max(this.#cursor, observation.message.event.workspaceSequence);
    return observation;
  }

  async createTask(
    workspaceId: string,
    input: { commandId: string; title: string },
  ): Promise<TaskCommandResult> {
    const result = TaskCommandResultSchema.parse(
      await this.request(`/v1/workspaces/${workspaceId}/tasks`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    );
    this.#tasks.set(result.task.id, result.task);
    this.#cursor = Math.max(this.#cursor, result.cursor);
    return result;
  }

  async executeTaskCommand(
    workspaceId: string,
    taskId: string,
    command: Record<string, unknown>,
  ): Promise<TaskCommandResult> {
    const result = TaskCommandResultSchema.parse(
      await this.request(`/v1/workspaces/${workspaceId}/tasks/${taskId}/commands`, {
        method: 'POST',
        body: JSON.stringify(command),
      }),
    );
    this.#tasks.set(result.task.id, result.task);
    this.#cursor = Math.max(this.#cursor, result.cursor);
    return result;
  }

  async refreshTask(workspaceId: string, taskId: string, signal?: AbortSignal): Promise<void> {
    const detail = TaskDetailResponseSchema.parse(
      await this.request(
        `/v1/workspaces/${workspaceId}/tasks/${taskId}`,
        signal === undefined ? {} : { signal },
      ),
    );
    this.#tasks.set(taskId, detail.task);
  }

  async recoverFromCursor(
    workspaceId: string,
    afterCursor: number,
  ): Promise<IncrementalSyncResponse> {
    const incremental = IncrementalSyncResponseSchema.parse(
      await this.request(
        `/v1/workspaces/${workspaceId}/sync/events?after=${afterCursor.toString()}`,
      ),
    );
    const taskIds = new Set(
      incremental.events
        .filter((event) => event.aggregateType === 'Task')
        .map((event) => event.aggregateId),
    );
    await Promise.all([...taskIds].map((taskId) => this.refreshTask(workspaceId, taskId)));
    this.#cursor = incremental.nextCursor;
    return incremental;
  }

  #receive(data: RawData): void {
    try {
      const observation: RealtimeObservation = {
        message: RealtimeServerMessageSchema.parse(JSON.parse(data.toString()) as unknown),
        receivedAt: performance.now(),
      };
      const waiter = [...this.#waiters].find((candidate) => candidate.predicate(observation));
      if (waiter === undefined) {
        this.#inbox.push(observation);
        return;
      }
      clearTimeout(waiter.timer);
      this.#waiters.delete(waiter);
      waiter.resolve(observation);
    } catch (error) {
      this.#failWaiters(toError(error));
    }
  }

  #waitFor(
    predicate: (observation: RealtimeObservation) => boolean,
    timeoutMs: number,
  ): Promise<RealtimeObservation> {
    const inboxIndex = this.#inbox.findIndex(predicate);
    if (inboxIndex >= 0) {
      const observation = this.#inbox.splice(inboxIndex, 1)[0];
      if (observation !== undefined) return Promise.resolve(observation);
    }
    return new Promise((resolve, reject) => {
      const waiter: MessageWaiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.#waiters.delete(waiter);
          reject(new Error(`Timed out after ${timeoutMs.toString()}ms waiting for realtime data`));
        }, timeoutMs),
      };
      this.#waiters.add(waiter);
    });
  }

  #failWaiters(error: Error): void {
    for (const waiter of this.#waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.#waiters.clear();
  }
}

async function registerAndLogin(
  baseUrl: string,
  email: string,
  displayName: string,
): Promise<{ accessToken: string; userId: string; email: string }> {
  const registration = registrationResponseSchema.parse(
    await requestJson(baseUrl, '/v1/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, displayName, password: 'RealtimePassword2026!' }),
    }),
  );
  await requestJson(baseUrl, '/v1/auth/verify-email', {
    method: 'POST',
    body: JSON.stringify({ token: registration.verificationToken }),
  });
  const login = loginResponseSchema.parse(
    await requestJson(baseUrl, '/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'RealtimePassword2026!' }),
    }),
  );
  return { accessToken: login.accessToken, userId: registration.userId, email };
}

async function requestJson(
  baseUrl: string,
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const response = await fetch(new URL(path, baseUrl), {
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
  const body = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    throw new Error(`HTTP ${response.status.toString()} ${path}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function waitForConnectionCount(baseUrl: string, expected: number): Promise<void> {
  const deadline = performance.now() + realtimeDeadlineMs;
  while (performance.now() < deadline) {
    const health = healthResponseSchema.parse(await requestJson(baseUrl, '/health'));
    if (health.realtimeConnections === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${expected.toString()} realtime connections`);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
