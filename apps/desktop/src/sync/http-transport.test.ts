import { HttpSyncTransport } from './http-transport';
import { ServerTaskCommandSchema } from './server-adapter';
import {
  SERVER_IDS,
  makeServerSnapshot,
  makeServerTask,
  makeTaskStartedEvent,
} from '../test/server-fixtures';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

class FakeSocket extends EventTarget {
  readonly close = vi.fn();

  receive(data: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) }));
  }

  serverClose(code: number): void {
    this.dispatchEvent(new CloseEvent('close', { code }));
  }
}

describe('HttpSyncTransport server contract', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses bearer HTTP auth and parses the server snapshot DTO', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse(makeServerSnapshot()));
    const transport = new HttpSyncTransport(
      'http://127.0.0.1:4310/v1',
      'ws://127.0.0.1:4310/v1/ws',
      () => Promise.resolve('access-token'),
    );

    const snapshot = await transport.fetchSnapshot(SERVER_IDS.workspace);

    expect(snapshot.cursor).toBe(12);
    expect(snapshot.tasks[0]?.workstreamName).toBe('桌面端');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(
      `http://127.0.0.1:4310/v1/workspaces/${SERVER_IDS.workspace}/sync/snapshot`,
    );
    expect(init?.headers).toMatchObject({ authorization: 'Bearer access-token' });
  });

  it('posts a type-discriminated task command to the task command endpoint', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ task: makeServerTask({ version: 4 }), cursor: 13 }),
    );
    const transport = new HttpSyncTransport('http://127.0.0.1:4310', 'ws://127.0.0.1:4310', () =>
      Promise.resolve('access-token'),
    );
    const command = ServerTaskCommandSchema.parse({
      type: 'StartTask',
      commandId: SERVER_IDS.command,
      expectedVersion: 3,
    });

    await transport.sendCommand(SERVER_IDS.workspace, SERVER_IDS.task, command);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toMatch(
      new RegExp(`/v1/workspaces/${SERVER_IDS.workspace}/tasks/${SERVER_IDS.task}/commands$`),
    );
    expect(JSON.parse(String(init?.body))).toEqual({
      schemaVersion: 1,
      type: 'StartTask',
      commandId: SERVER_IDS.command,
      expectedVersion: 3,
    });
  });

  it('creates tasks through POST /tasks rather than a fake task command', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse({ task: makeServerTask(), cursor: 13 }, 201));
    const transport = new HttpSyncTransport('http://127.0.0.1:4310', 'ws://127.0.0.1:4310', () =>
      Promise.resolve('access-token'),
    );

    await transport.createTask(SERVER_IDS.workspace, {
      commandId: SERVER_IDS.command,
      title: '新任务',
      description: '',
      definitionOfDone: '',
      importance: 3,
      dueAt: null,
      ownerId: null,
      collaboratorIds: [],
      workstreamId: SERVER_IDS.workstream,
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toMatch(new RegExp(`/v1/workspaces/${SERVER_IDS.workspace}/tasks$`));
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).not.toHaveProperty('type', 'CreateTask');
  });

  it('reads the latest task from error.error.details.task on a version conflict', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          error: {
            code: 'VERSION_CONFLICT',
            message: 'Task version is out of date',
            details: {
              expectedVersion: 2,
              currentVersion: 3,
              task: makeServerTask({ title: '服务端最新标题' }),
            },
            correlationId: SERVER_IDS.correlation,
          },
        },
        409,
      ),
    );
    const transport = new HttpSyncTransport('http://127.0.0.1:4310', 'ws://127.0.0.1:4310', () =>
      Promise.resolve('access-token'),
    );

    const promise = transport.sendCommand(
      SERVER_IDS.workspace,
      SERVER_IDS.task,
      ServerTaskCommandSchema.parse({
        type: 'PauseTask',
        commandId: SERVER_IDS.command,
        expectedVersion: 2,
      }),
    );

    await expect(promise).rejects.toMatchObject({
      name: 'VersionConflictError',
      currentTask: { title: '服务端最新标题', version: 3 },
    });
  });

  it('turns the server 410 SNAPSHOT_REQUIRED response into snapshot recovery', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(
        {
          error: {
            code: 'SNAPSHOT_REQUIRED',
            message: 'Sync cursor cannot be resumed',
            details: { minimumCursor: 10 },
            correlationId: SERVER_IDS.correlation,
          },
        },
        410,
      ),
    );
    const transport = new HttpSyncTransport('http://127.0.0.1:4310', 'ws://127.0.0.1:4310', () =>
      Promise.resolve('access-token'),
    );

    await expect(transport.fetchIncremental(SERVER_IDS.workspace, 1)).resolves.toEqual({
      requiresSnapshot: true,
      events: [],
    });
  });

  it('authenticates the real WS route with subprotocols and consumes ready before events', async () => {
    const socket = new FakeSocket();
    const createSocket = vi.fn(() => socket as unknown as WebSocket);
    const onEvent = vi.fn();
    const onDisconnect = vi.fn();
    const transport = new HttpSyncTransport(
      'http://127.0.0.1:4310',
      'ws://127.0.0.1:4310/v1/ws',
      () => Promise.resolve('header.payload.signature'),
      createSocket,
    );

    const disconnect = await transport.connectRealtime(SERVER_IDS.workspace, 12, {
      onEvent,
      onDisconnect,
    });

    expect(createSocket).toHaveBeenCalledWith(
      `ws://127.0.0.1:4310/v1/workspaces/${SERVER_IDS.workspace}/ws`,
      ['fanshuye.v1', 'bearer.header.payload.signature'],
    );
    socket.receive({ type: 'ready', workspaceId: SERVER_IDS.workspace, schemaVersion: 1 });
    expect(onEvent).not.toHaveBeenCalled();
    socket.receive({ type: 'event', event: makeTaskStartedEvent() });
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceSequence: 13,
        eventType: 'TaskStarted',
        refreshRequired: true,
      }),
    );

    disconnect();
    expect(socket.close).toHaveBeenCalledWith(1000, 'Client stopped');
    expect(onDisconnect).not.toHaveBeenCalled();
  });

  it('rotates once after an HTTP 401 and retries with the fresh access credential', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: { code: 'UNAUTHORIZED' } }, 401))
      .mockResolvedValueOnce(jsonResponse(makeServerSnapshot()));
    let accessCredential = 'expired-access-token';
    const refreshAccessCredential = vi.fn(() => {
      accessCredential = 'fresh-access-token';
      return Promise.resolve();
    });
    const onAuthenticationRequired = vi.fn();
    const transport = new HttpSyncTransport(
      'http://127.0.0.1:4310',
      'ws://127.0.0.1:4310',
      () => Promise.resolve(accessCredential),
      undefined,
      {
        refreshAccessCredential,
        onAuthenticationRequired,
        onWorkspaceAccessChanged: vi.fn(),
      },
    );

    await expect(transport.fetchSnapshot(SERVER_IDS.workspace)).resolves.toMatchObject({
      cursor: 12,
    });
    expect(refreshAccessCredential).toHaveBeenCalledTimes(1);
    expect(onAuthenticationRequired).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({
      authorization: 'Bearer fresh-access-token',
    });
  });

  it('routes realtime session and workspace revocations to separate safe callbacks', async () => {
    const firstSocket = new FakeSocket();
    const secondSocket = new FakeSocket();
    const createSocket = vi
      .fn<(_: string, __: string[]) => WebSocket>()
      .mockReturnValueOnce(firstSocket as unknown as WebSocket)
      .mockReturnValueOnce(secondSocket as unknown as WebSocket);
    const onAuthenticationRequired = vi.fn();
    const onWorkspaceAccessChanged = vi.fn();
    const callbacks = {
      refreshAccessCredential: vi.fn(() => Promise.resolve()),
      onAuthenticationRequired,
      onWorkspaceAccessChanged,
    };
    const transport = new HttpSyncTransport(
      'http://127.0.0.1:4310',
      'ws://127.0.0.1:4310',
      () => Promise.resolve('header.payload.signature'),
      createSocket,
      callbacks,
    );

    await transport.connectRealtime(SERVER_IDS.workspace, 12, {
      onEvent: vi.fn(),
      onDisconnect: vi.fn(),
    });
    firstSocket.serverClose(4001);
    expect(onAuthenticationRequired).toHaveBeenCalledTimes(1);
    expect(onWorkspaceAccessChanged).not.toHaveBeenCalled();

    await transport.connectRealtime(SERVER_IDS.workspace, 12, {
      onEvent: vi.fn(),
      onDisconnect: vi.fn(),
    });
    secondSocket.serverClose(4003);
    expect(onWorkspaceAccessChanged).toHaveBeenCalledTimes(1);
  });
});
