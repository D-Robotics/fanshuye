import { vi } from 'vitest';
import { makeTask } from '../test/fixtures';
import { MemoryConfirmedCache, type ConfirmedSnapshot } from './cache';
import {
  DesktopSyncController,
  type CommandResult,
  type IncrementalResult,
  type RealtimeHandlers,
  type SyncTransport,
  type WorkspaceEvent,
} from './controller';
import type { ServerTaskCommand } from './server-adapter';

const workspaceId = '20000000-0000-4000-8000-000000000001';
const commandIds = Array.from(
  { length: 8 },
  (_, index) => `70000000-0000-4000-8000-${(index + 1).toString().padStart(12, '0')}`,
);

class SharedSyncBackend {
  private snapshot: ConfirmedSnapshot = {
    workspaceId,
    cursor: 4,
    capturedAt: '2030-01-01T00:00:00.000Z',
    workspace: {
      id: workspaceId,
      name: '开发组',
      timezone: 'Asia/Shanghai',
      tree: { id: '30000000-0000-4000-8000-000000000001', name: '开发任务树' },
    },
    workstreams: [{ id: '40000000-0000-4000-8000-000000000001', name: '平台', sortOrder: 0 }],
    members: [],
    dependencies: [],
    tasks: [makeTask({ id: '50000000-0000-4000-8000-000000000001' })],
  };
  private readonly events: WorkspaceEvent[] = [];
  private readonly subscribers = new Map<string, RealtimeHandlers>();
  minimumCursor = 0;

  transport(clientId: string): IntegrationTransport {
    return new IntegrationTransport(this, clientId);
  }

  fetchSnapshot(): ConfirmedSnapshot {
    return structuredClone(this.snapshot);
  }

  fetchIncremental(afterCursor: number): IncrementalResult {
    if (afterCursor < this.minimumCursor) return { requiresSnapshot: true, events: [] };
    return {
      requiresSnapshot: false,
      events: structuredClone(this.events.filter((event) => event.workspaceSequence > afterCursor)),
    };
  }

  subscribe(clientId: string, handlers: RealtimeHandlers): () => void {
    this.subscribers.set(clientId, handlers);
    return () => this.subscribers.delete(clientId);
  }

  disconnect(clientId: string): void {
    const handlers = this.subscribers.get(clientId);
    this.subscribers.delete(clientId);
    handlers?.onDisconnect();
  }

  update(command: ServerTaskCommand): CommandResult {
    const current = this.snapshot.tasks[0]!;
    const title =
      command.type === 'UpdateTaskDetails' ? (command.title ?? current.title) : current.title;
    const task = makeTask({
      ...current,
      title,
      version: current.version + 1,
      updatedAt: new Date(Date.parse(current.updatedAt) + 1_000).toISOString(),
    });
    const sequence = this.snapshot.cursor + 1;
    this.snapshot = {
      ...this.snapshot,
      cursor: sequence,
      capturedAt: task.updatedAt,
      tasks: [task],
    };
    const event: WorkspaceEvent = {
      workspaceSequence: sequence,
      schemaVersion: 1,
      eventType: 'TaskUpdated',
      task,
      removedTaskId: null,
    };
    this.events.push(event);
    for (const handlers of this.subscribers.values()) {
      handlers.onEvent(structuredClone(event));
    }
    return { task: structuredClone(task), cursor: sequence };
  }

  eventAt(sequence: number): WorkspaceEvent {
    const event = this.events.find((candidate) => candidate.workspaceSequence === sequence);
    if (event === undefined) throw new Error(`No event exists at sequence ${sequence}`);
    return structuredClone(event);
  }
}

class IntegrationTransport implements SyncTransport {
  constructor(
    private readonly backend: SharedSyncBackend,
    private readonly clientId: string,
  ) {}

  fetchSnapshot(): Promise<ConfirmedSnapshot> {
    return Promise.resolve(this.backend.fetchSnapshot());
  }

  fetchIncremental(_workspaceId: string, afterCursor: number): Promise<IncrementalResult> {
    return Promise.resolve(this.backend.fetchIncremental(afterCursor));
  }

  connectRealtime(
    _workspaceId: string,
    _afterCursor: number,
    handlers: RealtimeHandlers,
  ): Promise<() => void> {
    return Promise.resolve(this.backend.subscribe(this.clientId, handlers));
  }

  sendCommand(
    _workspaceId: string,
    _taskId: string,
    command: ServerTaskCommand,
  ): Promise<CommandResult> {
    return Promise.resolve(this.backend.update(command));
  }

  createTask(): Promise<CommandResult> {
    return Promise.reject(new Error('Not needed by this sync scenario'));
  }

  disconnect(): void {
    this.backend.disconnect(this.clientId);
  }
}

function updateCommand(expectedVersion: number, title: string, index: number): ServerTaskCommand {
  return {
    type: 'UpdateTaskDetails',
    commandId: commandIds[index]!,
    expectedVersion,
    title,
  };
}

describe('two-client synchronization integration', () => {
  it('recovers duplicates, gaps, disconnects and expired cursors without a restart', async () => {
    const backend = new SharedSyncBackend();
    const firstTransport = backend.transport('first');
    const secondTransport = backend.transport('second');
    const first = new DesktopSyncController(firstTransport, new MemoryConfirmedCache());
    const second = new DesktopSyncController(secondTransport, new MemoryConfirmedCache());
    await Promise.all([first.start(workspaceId), second.start(workspaceId)]);
    const taskId = first.getView().snapshot!.tasks[0]!.id;

    await first.execute(taskId, updateCommand(1, '双客户端可见', 0));
    await vi.waitFor(() => {
      expect(second.getView().snapshot).toMatchObject({
        cursor: 5,
        tasks: [{ title: '双客户端可见', version: 2 }],
      });
    });

    await second.acceptRealtimeEvent(backend.eventAt(5));
    expect(second.getView().snapshot?.cursor).toBe(5);

    secondTransport.disconnect();
    expect(second.getView().status).toBe('reconnecting');
    await first.execute(taskId, updateCommand(2, '断线变化一', 1));
    await first.execute(taskId, updateCommand(3, '断线变化二', 2));
    expect(second.getView().snapshot?.cursor).toBe(5);

    await second.reconnect();
    expect(second.getView().snapshot).toMatchObject({
      cursor: 7,
      tasks: [{ title: '断线变化二', version: 4 }],
    });

    secondTransport.disconnect();
    await first.execute(taskId, updateCommand(4, '缺口变化一', 3));
    await first.execute(taskId, updateCommand(5, '缺口变化二', 4));
    await second.acceptRealtimeEvent(backend.eventAt(9));
    expect(second.getView().snapshot).toMatchObject({
      cursor: 9,
      tasks: [{ title: '缺口变化二', version: 6 }],
    });

    secondTransport.disconnect();
    await first.execute(taskId, updateCommand(6, '游标过期后的快照', 5));
    backend.minimumCursor = 10;
    await second.reconnect();
    expect(second.getView()).toMatchObject({
      status: 'online',
      snapshot: {
        cursor: 10,
        tasks: [{ title: '游标过期后的快照', version: 7 }],
      },
    });
  });
});
