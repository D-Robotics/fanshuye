import type { ConfirmedSnapshot } from './cache';
import {
  VersionConflictError,
  type CommandResult,
  type IncrementalResult,
  type RealtimeHandlers,
  type SyncTransport,
} from './controller';
import {
  parseApiError,
  parseConflictTask,
  parseRealtimeMessage,
  parseServerCommandResult,
  parseServerIncremental,
  parseServerSnapshot,
  ServerCreateTaskInputSchema,
  ServerTaskCommandSchema,
  type ServerCreateTaskInput,
  type ServerTaskCommand,
} from './server-adapter';

class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

export class RealtimeAuthenticationError extends Error {
  constructor() {
    super('缺少访问令牌，无法建立实时连接。');
    this.name = 'RealtimeAuthenticationError';
  }
}

export interface HttpSyncAuthenticationCallbacks {
  refreshAccessCredential: () => Promise<void>;
  onAuthenticationRequired: () => void;
  onWorkspaceAccessChanged: () => void;
}

export class HttpSyncTransport implements SyncTransport {
  private readonly workstreamNames = new Map<string, Map<string, string>>();

  constructor(
    private readonly apiUrl: string,
    private readonly wsUrl: string,
    private readonly getAccessToken: () => Promise<string | null>,
    private readonly createWebSocket: (url: string, protocols: string[]) => WebSocket = (
      url,
      protocols,
    ) => new WebSocket(url, protocols),
    private readonly authentication?: HttpSyncAuthenticationCallbacks,
  ) {}

  async fetchSnapshot(workspaceId: string): Promise<ConfirmedSnapshot> {
    const input = await this.request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/sync/snapshot`,
    );
    const snapshot = parseServerSnapshot(input);
    if (snapshot.workspaceId !== workspaceId) {
      throw new Error('服务端快照属于另一个工作区。');
    }
    this.workstreamNames.set(
      workspaceId,
      new Map(snapshot.workstreams.map((item) => [item.id, item.name])),
    );
    return snapshot;
  }

  async fetchIncremental(workspaceId: string, afterCursor: number): Promise<IncrementalResult> {
    try {
      const input = await this.request(
        `/v1/workspaces/${encodeURIComponent(workspaceId)}/sync/events?after=${afterCursor.toString()}`,
      );
      const response = parseServerIncremental(input);
      return {
        requiresSnapshot: false,
        events: response.events.map((event) => ({
          workspaceSequence: event.workspaceSequence,
          schemaVersion: event.schemaVersion,
          eventType: event.eventType,
          task: null,
          removedTaskId: null,
          refreshRequired: true,
        })),
      };
    } catch (error) {
      if (
        error instanceof ApiRequestError &&
        (error.status === 410 || error.code === 'SNAPSHOT_REQUIRED')
      ) {
        return { requiresSnapshot: true, events: [] };
      }
      throw error;
    }
  }

  async connectRealtime(
    workspaceId: string,
    _afterCursor: number,
    handlers: RealtimeHandlers,
  ): Promise<() => void> {
    const token = (await this.getAccessToken())?.trim();
    if (!token) throw new RealtimeAuthenticationError();

    const url = new URL(`/v1/workspaces/${encodeURIComponent(workspaceId)}/ws`, this.wsUrl);
    const socket = this.createWebSocket(url.toString(), ['fanshuye.v1', `bearer.${token}`]);
    let ready = false;
    let disconnected = false;
    const notifyDisconnect = () => {
      if (disconnected) return;
      disconnected = true;
      handlers.onDisconnect();
    };

    socket.addEventListener('message', (message) => {
      try {
        if (typeof message.data !== 'string') throw new Error('Realtime frame must be text');
        const parsed = parseRealtimeMessage(JSON.parse(message.data) as unknown);
        if (parsed.kind === 'ready') {
          if (parsed.workspaceId !== workspaceId) {
            socket.close(1008, 'Workspace mismatch');
            return;
          }
          ready = true;
          return;
        }
        if (parsed.kind === 'pong') return;
        if (!ready) {
          socket.close(1008, 'Ready frame required');
          return;
        }
        handlers.onEvent({
          workspaceSequence: parsed.event.workspaceSequence,
          schemaVersion: parsed.event.schemaVersion,
          eventType: parsed.event.eventType,
          task: null,
          removedTaskId: null,
          refreshRequired: true,
        });
      } catch {
        socket.close(1003, 'Unsupported event');
      }
    });
    socket.addEventListener('close', (event) => {
      if (event.code === 4001) this.authentication?.onAuthenticationRequired();
      if (event.code === 4003) this.authentication?.onWorkspaceAccessChanged();
      notifyDisconnect();
    });
    socket.addEventListener('error', notifyDisconnect);
    return () => {
      disconnected = true;
      socket.close(1000, 'Client stopped');
    };
  }

  async sendCommand(
    workspaceId: string,
    taskId: string,
    command: ServerTaskCommand,
  ): Promise<CommandResult> {
    const body = ServerTaskCommandSchema.parse(command);
    try {
      const input = await this.request(
        `/v1/workspaces/${encodeURIComponent(workspaceId)}/tasks/${encodeURIComponent(taskId)}/commands`,
        { method: 'POST', body: JSON.stringify(body) },
      );
      return this.mapCommandResult(workspaceId, input);
    } catch (error) {
      throw this.translateCommandError(workspaceId, error);
    }
  }

  async createTask(workspaceId: string, input: ServerCreateTaskInput): Promise<CommandResult> {
    const body = ServerCreateTaskInputSchema.parse(input);
    try {
      const result = await this.request(`/v1/workspaces/${encodeURIComponent(workspaceId)}/tasks`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return this.mapCommandResult(workspaceId, result);
    } catch (error) {
      throw this.translateCommandError(workspaceId, error);
    }
  }

  private mapCommandResult(workspaceId: string, input: unknown): CommandResult {
    const projection = parseServerCommandResult(input);
    const name = this.workstreamNames.get(workspaceId)?.get(projection.task.workstreamId);
    return name === undefined ? projection : parseServerCommandResult(input, name);
  }

  private translateCommandError(workspaceId: string, error: unknown): unknown {
    if (!(error instanceof ApiRequestError) || error.code !== 'VERSION_CONFLICT') return error;
    const wireTask = error.details.task;
    const workstreamId =
      typeof wireTask === 'object' && wireTask !== null && 'workstreamId' in wireTask
        ? wireTask.workstreamId
        : undefined;
    const workstreamName =
      typeof workstreamId === 'string'
        ? this.workstreamNames.get(workspaceId)?.get(workstreamId)
        : undefined;
    const currentTask = parseConflictTask(error.details, workstreamName);
    return currentTask === null ? error : new VersionConflictError(error.message, currentTask);
  }

  private async request(
    path: string,
    init: RequestInit = {},
    allowAuthenticationRefresh = true,
  ): Promise<unknown> {
    const token = (await this.getAccessToken())?.trim();
    const response = await fetch(new URL(path, this.apiUrl), {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    });
    const body = await response.json().catch(() => null);
    if (
      response.status === 401 &&
      allowAuthenticationRefresh &&
      this.authentication !== undefined
    ) {
      try {
        await this.authentication.refreshAccessCredential();
      } catch (error) {
        this.authentication.onAuthenticationRequired();
        throw error;
      }
      return this.request(path, init, false);
    }
    if (!response.ok) {
      if (response.status === 401) this.authentication?.onAuthenticationRequired();
      const parsed = parseApiError(body);
      throw new ApiRequestError(
        response.status,
        parsed?.code ?? 'HTTP_ERROR',
        parsed?.message ?? `请求失败（${response.status.toString()}）`,
        parsed?.details ?? {},
      );
    }
    return body;
  }
}
