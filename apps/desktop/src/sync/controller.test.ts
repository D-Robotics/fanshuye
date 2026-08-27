import { MemoryConfirmedCache, type ConfirmedSnapshot } from './cache';
import {
  DesktopSyncController,
  OfflineWriteError,
  type CommandResult,
  type IncrementalResult,
  type RealtimeHandlers,
  type SyncTransport,
  type WorkspaceEvent,
} from './controller';
import { makeTask } from '../test/fixtures';

class FakeTransport implements SyncTransport {
  snapshot: ConfirmedSnapshot = {
    workspaceId: 'workspace-a',
    cursor: 4,
    capturedAt: '2030-01-01T00:00:00.000Z',
    workspace: {
      id: 'workspace-a',
      name: '开发组',
      timezone: 'Asia/Shanghai',
      tree: { id: 'tree-a', name: '开发任务树' },
    },
    workstreams: [{ id: 'stream-a', name: '平台', sortOrder: 0 }],
    members: [],
    dependencies: [],
    tasks: [makeTask()],
  };
  incremental: IncrementalResult = { requiresSnapshot: false, events: [] };
  snapshotFailure = false;
  handlers: RealtimeHandlers | null = null;
  snapshotCalls = 0;
  incrementalCalls: number[] = [];
  realtimeConnectCalls = 0;
  realtimeDisconnectCalls = 0;
  activeRealtimeConnections = 0;
  maximumRealtimeConnections = 0;
  deferRealtimeConnects = false;
  private readonly pendingRealtimeConnects: Array<() => void> = [];

  get pendingRealtimeConnectCount(): number {
    return this.pendingRealtimeConnects.length;
  }

  releaseRealtimeConnects(): void {
    this.pendingRealtimeConnects.splice(0).forEach((resolve) => resolve());
  }

  fetchSnapshot(): Promise<ConfirmedSnapshot> {
    this.snapshotCalls += 1;
    if (this.snapshotFailure) return Promise.reject(new Error('offline'));
    return Promise.resolve(structuredClone(this.snapshot));
  }

  fetchIncremental(_workspaceId: string, afterCursor: number): Promise<IncrementalResult> {
    this.incrementalCalls.push(afterCursor);
    return Promise.resolve(structuredClone(this.incremental));
  }

  async connectRealtime(
    _workspaceId: string,
    _afterCursor: number,
    handlers: RealtimeHandlers,
  ): Promise<() => void> {
    this.realtimeConnectCalls += 1;
    this.activeRealtimeConnections += 1;
    this.maximumRealtimeConnections = Math.max(
      this.maximumRealtimeConnections,
      this.activeRealtimeConnections,
    );
    if (this.deferRealtimeConnects) {
      await new Promise<void>((resolve) => this.pendingRealtimeConnects.push(resolve));
    }
    this.handlers = handlers;
    let disconnected = false;
    return Promise.resolve(() => {
      if (disconnected) return;
      disconnected = true;
      this.realtimeDisconnectCalls += 1;
      this.activeRealtimeConnections -= 1;
      this.handlers = null;
    });
  }

  sendCommand(): Promise<CommandResult> {
    return Promise.resolve({ task: makeTask({ version: 2 }), cursor: 5 });
  }

  createTask(): Promise<CommandResult> {
    return Promise.resolve({ task: makeTask({ version: 1 }), cursor: 5 });
  }
}

class CountingCache extends MemoryConfirmedCache {
  writes = 0;

  override replaceWithConfirmedSnapshot(snapshot: ConfirmedSnapshot): Promise<void> {
    this.writes += 1;
    return super.replaceWithConfirmedSnapshot(snapshot);
  }
}

function event(sequence: number, overrides: Partial<WorkspaceEvent> = {}): WorkspaceEvent {
  return {
    workspaceSequence: sequence,
    schemaVersion: 1,
    eventType: 'TaskUpdated',
    task: makeTask({ version: sequence }),
    removedTaskId: null,
    ...overrides,
  };
}

describe('DesktopSyncController', () => {
  it('falls back to confirmed cache in explicit offline read-only mode', async () => {
    const cache = new MemoryConfirmedCache();
    const transport = new FakeTransport();
    await cache.replaceWithConfirmedSnapshot({
      workspaceId: 'workspace-a',
      cursor: 2,
      capturedAt: '2030-01-01T00:00:00.000Z',
      workspace: transport.snapshot.workspace,
      workstreams: transport.snapshot.workstreams,
      members: [],
      dependencies: [],
      tasks: [makeTask()],
    });
    transport.snapshotFailure = true;
    const controller = new DesktopSyncController(transport, cache);

    await controller.start('workspace-a');

    expect(controller.getView().status).toBe('offline');
    expect(controller.getView().snapshot?.cursor).toBe(2);
    await expect(
      controller.execute('task-a', {
        type: 'StartTask',
        commandId: 'command-a',
        expectedVersion: 1,
      }),
    ).rejects.toBeInstanceOf(OfflineWriteError);
  });

  it('ignores duplicate events and applies the next confirmed sequence', async () => {
    const transport = new FakeTransport();
    const cache = new MemoryConfirmedCache();
    const controller = new DesktopSyncController(transport, cache);
    await controller.start('workspace-a');

    await controller.acceptRealtimeEvent(event(4));
    expect(controller.getView().snapshot?.cursor).toBe(4);
    await controller.acceptRealtimeEvent(
      event(5, { task: makeTask({ version: 5, title: '已更新' }) }),
    );
    expect(controller.getView().snapshot?.cursor).toBe(5);
    expect(controller.getView().snapshot?.tasks[0]?.title).toBe('已更新');
  });

  it('serializes back-to-back realtime events before advancing the cache cursor', async () => {
    const transport = new FakeTransport();
    const controller = new DesktopSyncController(transport, new MemoryConfirmedCache());
    await controller.start('workspace-a');

    await Promise.all([
      controller.acceptRealtimeEvent(event(5, { task: makeTask({ version: 5 }) })),
      controller.acceptRealtimeEvent(event(6, { task: makeTask({ version: 6 }) })),
    ]);

    expect(controller.getView().snapshot?.cursor).toBe(6);
    expect(controller.getView().snapshot?.tasks[0]?.version).toBe(6);
    expect(transport.incrementalCalls).toEqual([]);
  });

  it('recovers a sequence gap through authorized increments', async () => {
    const transport = new FakeTransport();
    transport.incremental = { requiresSnapshot: false, events: [event(5), event(6)] };
    const controller = new DesktopSyncController(transport, new MemoryConfirmedCache());
    await controller.start('workspace-a');

    await controller.acceptRealtimeEvent(event(7));

    expect(transport.incrementalCalls).toEqual([4]);
    expect(controller.getView().snapshot?.cursor).toBe(6);
    expect(controller.getView().status).toBe('online');
  });

  it('rebuilds a snapshot for an unknown event schema', async () => {
    const transport = new FakeTransport();
    const controller = new DesktopSyncController(transport, new MemoryConfirmedCache());
    await controller.start('workspace-a');
    transport.snapshot = {
      ...transport.snapshot,
      cursor: 8,
      tasks: [makeTask({ title: '重建后' })],
    };
    transport.incremental = { requiresSnapshot: true, events: [] };

    await controller.acceptRealtimeEvent(event(5, { schemaVersion: 99 }));

    expect(transport.snapshotCalls).toBe(2);
    expect(controller.getView().snapshot?.cursor).toBe(8);
    expect(controller.getView().snapshot?.tasks[0]?.title).toBe('重建后');
  });

  it('refreshes projection when completion makes a downstream task executable', async () => {
    const transport = new FakeTransport();
    transport.snapshot = {
      ...transport.snapshot,
      tasks: [
        makeTask({
          status: 'TODO',
          incompletePrerequisites: [
            { taskId: 'prerequisite', title: '前置任务', status: 'IN_PROGRESS' },
          ],
        }),
      ],
    };
    const controller = new DesktopSyncController(transport, new MemoryConfirmedCache());
    await controller.start('workspace-a');
    transport.snapshot = {
      ...transport.snapshot,
      cursor: 5,
      tasks: [
        makeTask({
          status: 'TODO',
          actionLevel: 'NOW',
          actionReason: '前置任务完成后重新计算',
          incompletePrerequisites: [],
        }),
      ],
    };

    await controller.acceptRealtimeEvent(
      event(5, {
        eventType: 'TaskExecutabilityChanged',
        task: null,
        refreshRequired: true,
      }),
    );

    expect(transport.snapshotCalls).toBe(2);
    expect(controller.getView().snapshot?.tasks[0]).toMatchObject({
      status: 'TODO',
      actionLevel: 'NOW',
      incompletePrerequisites: [],
    });
  });

  it('pauses realtime work while hidden and resumes through the cursor with bounded resources', async () => {
    vi.useFakeTimers();
    try {
      const transport = new FakeTransport();
      const controller = new DesktopSyncController(transport, new MemoryConfirmedCache());
      await controller.start('workspace-a');

      expect(transport.activeRealtimeConnections).toBe(1);
      await controller.setWindowVisible(false);
      expect(transport.activeRealtimeConnections).toBe(0);
      const hiddenActivity = {
        snapshots: transport.snapshotCalls,
        increments: transport.incrementalCalls.length,
        connects: transport.realtimeConnectCalls,
      };

      vi.advanceTimersByTime(60_000);
      await Promise.resolve();
      expect({
        snapshots: transport.snapshotCalls,
        increments: transport.incrementalCalls.length,
        connects: transport.realtimeConnectCalls,
      }).toEqual(hiddenActivity);

      for (let index = 0; index < 12; index += 1) {
        await controller.setWindowVisible(true);
        expect(transport.incrementalCalls.at(-1)).toBe(4);
        expect(transport.activeRealtimeConnections).toBe(1);
        await controller.setWindowVisible(false);
        expect(transport.activeRealtimeConnections).toBe(0);
      }

      expect(transport.snapshotCalls).toBe(1);
      expect(transport.maximumRealtimeConnections).toBe(1);
      expect(transport.realtimeConnectCalls).toBe(transport.realtimeDisconnectCalls);
      controller.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('loads only confirmed cache when initially hidden and defers all network work until shown', async () => {
    const transport = new FakeTransport();
    const cache = new MemoryConfirmedCache();
    const controller = new DesktopSyncController(transport, cache);

    await controller.setWindowVisible(false);
    await controller.start('workspace-a');

    expect(transport.snapshotCalls).toBe(0);
    expect(transport.incrementalCalls).toEqual([]);
    expect(transport.realtimeConnectCalls).toBe(0);

    await controller.setWindowVisible(true);

    expect(transport.snapshotCalls).toBe(1);
    expect(transport.realtimeConnectCalls).toBe(1);
    expect(controller.getView().status).toBe('online');
    controller.stop();
  });

  it('drops an event queued while visible when the window hides before its event-chain turn', async () => {
    const transport = new FakeTransport();
    const cache = new CountingCache();
    const controller = new DesktopSyncController(transport, cache);
    await controller.start('workspace-a');
    expect(cache.writes).toBe(1);

    const queuedEvent = controller.acceptRealtimeEvent(
      event(5, { task: makeTask({ version: 5, title: '隐藏后不得应用' }) }),
    );
    await controller.setWindowVisible(false);
    await queuedEvent;

    expect(cache.writes).toBe(1);
    expect(controller.getView().snapshot?.cursor).toBe(4);
    expect(controller.getView().snapshot?.tasks[0]?.title).not.toBe('隐藏后不得应用');
    expect(transport.activeRealtimeConnections).toBe(0);
  });

  it('single-flights concurrent visibility recovery and reconnect without leaking a socket', async () => {
    const transport = new FakeTransport();
    const controller = new DesktopSyncController(transport, new MemoryConfirmedCache());
    await controller.start('workspace-a');
    await controller.setWindowVisible(false);
    transport.deferRealtimeConnects = true;

    const resume = controller.setWindowVisible(true);
    const reconnect = controller.reconnect();
    await vi.waitFor(() => expect(transport.pendingRealtimeConnectCount).toBe(1));

    expect(transport.realtimeConnectCalls).toBe(2);
    expect(transport.activeRealtimeConnections).toBe(1);
    expect(transport.maximumRealtimeConnections).toBe(1);

    transport.releaseRealtimeConnects();
    await Promise.all([resume, reconnect]);
    expect(transport.activeRealtimeConnections).toBe(1);
    expect(transport.maximumRealtimeConnections).toBe(1);

    controller.stop();
    expect(transport.activeRealtimeConnections).toBe(0);
    expect(transport.realtimeConnectCalls).toBe(transport.realtimeDisconnectCalls);
  });

  it.each(['hidden', 'stopped'] as const)(
    'disconnects a late realtime connection after the controller becomes %s',
    async (terminalState) => {
      const transport = new FakeTransport();
      const controller = new DesktopSyncController(transport, new MemoryConfirmedCache());
      await controller.start('workspace-a');
      await controller.setWindowVisible(false);
      transport.deferRealtimeConnects = true;

      const resume = controller.setWindowVisible(true);
      await vi.waitFor(() => expect(transport.pendingRealtimeConnectCount).toBe(1));
      if (terminalState === 'hidden') {
        await controller.setWindowVisible(false);
      } else {
        controller.stop();
      }

      transport.releaseRealtimeConnects();
      await resume;

      expect(transport.activeRealtimeConnections).toBe(0);
      expect(transport.realtimeConnectCalls).toBe(transport.realtimeDisconnectCalls);
    },
  );
});
