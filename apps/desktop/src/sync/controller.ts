import type { SyncStatus, TaskItem } from '@fanshuye/ui';
import type { ConfirmedCache, ConfirmedSnapshot } from './cache';
import type { ServerCreateTaskInput, ServerTaskCommand } from './server-adapter';

export interface WorkspaceEvent {
  workspaceSequence: number;
  schemaVersion: number;
  eventType: string;
  task: TaskItem | null;
  removedTaskId: string | null;
  refreshRequired?: boolean;
}

export interface IncrementalResult {
  requiresSnapshot: boolean;
  events: WorkspaceEvent[];
}

export interface CommandResult {
  task: TaskItem;
  cursor: number;
}

export interface RealtimeHandlers {
  onEvent: (event: WorkspaceEvent) => void;
  onDisconnect: () => void;
}

export interface SyncTransport {
  fetchSnapshot(workspaceId: string): Promise<ConfirmedSnapshot>;
  fetchIncremental(workspaceId: string, afterCursor: number): Promise<IncrementalResult>;
  connectRealtime(
    workspaceId: string,
    afterCursor: number,
    handlers: RealtimeHandlers,
  ): Promise<() => void>;
  sendCommand(
    workspaceId: string,
    taskId: string,
    command: ServerTaskCommand,
  ): Promise<CommandResult>;
  createTask(workspaceId: string, input: ServerCreateTaskInput): Promise<CommandResult>;
}

export interface ControllerView {
  snapshot: ConfirmedSnapshot | null;
  status: SyncStatus;
  message: string | null;
}

export class OfflineWriteError extends Error {
  constructor() {
    super('当前为离线只读状态，任务修改必须由服务端确认。');
    this.name = 'OfflineWriteError';
  }
}

export class VersionConflictError extends Error {
  constructor(
    message: string,
    readonly currentTask: TaskItem,
  ) {
    super(message);
    this.name = 'VersionConflictError';
  }
}

type Listener = (view: ControllerView) => void;

export class DesktopSyncController {
  private view: ControllerView = { snapshot: null, status: 'offline', message: null };
  private readonly listeners = new Set<Listener>();
  private disconnectRealtime: (() => void) | null = null;
  private activeWorkspaceId: string | null = null;
  private eventChain: Promise<void> = Promise.resolve();
  private windowVisible = true;
  private visibilityGeneration = 0;
  private realtimeConnectFlight: { generation: number; promise: Promise<void> } | null = null;

  constructor(
    private readonly transport: SyncTransport,
    private readonly cache: ConfirmedCache,
  ) {}

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.getView());
    return () => this.listeners.delete(listener);
  }

  getView(): ControllerView {
    return structuredClone(this.view);
  }

  private publish(next: ControllerView): void {
    this.view = next;
    for (const listener of this.listeners) listener(this.getView());
  }

  private setStatus(status: SyncStatus, message: string | null = null): void {
    this.publish({ ...this.view, status, message });
  }

  async start(workspaceId: string): Promise<void> {
    const generation = ++this.visibilityGeneration;
    this.disconnectRealtime?.();
    this.disconnectRealtime = null;
    this.activeWorkspaceId = workspaceId;
    const cached = await this.cache.loadConfirmedSnapshot(workspaceId);
    if (!this.isCurrentGeneration(generation)) return;
    if (cached !== null) {
      this.publish({ snapshot: cached, status: 'recovering', message: '正在检查服务器更新' });
    } else {
      this.setStatus('recovering', '正在加载团队任务');
    }

    // A hidden native webview may still execute JavaScript. Cache reads are
    // useful for the next reveal, but network and realtime work must wait.
    if (!this.windowVisible) return;

    try {
      await this.rebuildFromSnapshot(generation);
      if (!this.isActiveGeneration(generation)) return;
      await this.openRealtime(generation);
      if (!this.isActiveGeneration(generation)) return;
      this.setStatus('online');
    } catch {
      if (!this.isActiveGeneration(generation)) return;
      this.publish({
        snapshot: cached,
        status: 'offline',
        message: cached === null ? '离线且没有已确认缓存' : '正在显示最近一次确认的数据',
      });
    }
  }

  stop(): void {
    this.visibilityGeneration += 1;
    this.disconnectRealtime?.();
    this.disconnectRealtime = null;
    this.activeWorkspaceId = null;
  }

  async setWindowVisible(visible: boolean): Promise<void> {
    if (this.windowVisible === visible) return;
    this.windowVisible = visible;
    const generation = ++this.visibilityGeneration;

    if (!visible) {
      this.disconnectRealtime?.();
      this.disconnectRealtime = null;
      return;
    }
    if (this.activeWorkspaceId === null) return;

    try {
      const cursor = this.view.snapshot?.cursor ?? 0;
      if (this.view.snapshot === null) {
        await this.rebuildFromSnapshot(generation);
      } else {
        await this.recoverAfter(cursor, generation);
      }
      if (!this.isActiveGeneration(generation)) return;
      await this.openRealtime(generation);
      if (!this.isActiveGeneration(generation)) return;
      this.setStatus('online');
    } catch {
      if (this.isActiveGeneration(generation)) {
        this.setStatus('offline', '窗口恢复后同步失败，正在显示确认缓存');
      }
    }
  }

  async reconnect(): Promise<void> {
    if (this.activeWorkspaceId === null || !this.windowVisible) return;
    const generation = this.visibilityGeneration;
    this.setStatus('reconnecting', '网络已恢复，正在补齐变化');
    try {
      const cursor = this.view.snapshot?.cursor ?? 0;
      await this.recoverAfter(cursor, generation);
      if (!this.isActiveGeneration(generation)) return;
      await this.openRealtime(generation);
      if (!this.isActiveGeneration(generation)) return;
      this.setStatus('online');
    } catch {
      if (this.isActiveGeneration(generation)) {
        this.setStatus('offline', '同步恢复失败，将继续显示确认缓存');
      }
    }
  }

  markDisconnected(): void {
    if (!this.windowVisible) return;
    if (this.view.status !== 'offline') {
      this.setStatus('reconnecting', '实时连接中断，正在等待恢复');
    }
  }

  async acceptRealtimeEvent(event: WorkspaceEvent): Promise<void> {
    return this.acceptRealtimeEventForGeneration(event, this.visibilityGeneration);
  }

  private async acceptRealtimeEventForGeneration(
    event: WorkspaceEvent,
    generation: number,
  ): Promise<void> {
    if (!this.isActiveGeneration(generation)) return;
    const work = this.eventChain.then(() => this.applyRealtimeEvent(event, generation));
    this.eventChain = work.catch(() => undefined);
    return work;
  }

  private async applyRealtimeEvent(event: WorkspaceEvent, generation: number): Promise<void> {
    if (!this.isActiveGeneration(generation)) return;
    const snapshot = this.view.snapshot;
    if (snapshot === null || this.activeWorkspaceId === null) return;
    if (event.workspaceSequence <= snapshot.cursor) return;
    if (event.schemaVersion !== 1 || event.workspaceSequence !== snapshot.cursor + 1) {
      await this.recoverAfter(snapshot.cursor, generation);
      return;
    }
    if (event.refreshRequired === true) {
      await this.refreshProjection(generation);
      return;
    }
    const next = this.applyEvent(snapshot, event);
    if (next === null) {
      await this.rebuildFromSnapshot(generation);
      return;
    }
    if (!this.isActiveGeneration(generation)) return;
    await this.cache.replaceWithConfirmedSnapshot(next);
    if (!this.isActiveGeneration(generation)) return;
    this.publish({ snapshot: next, status: 'online', message: null });
  }

  async execute(taskId: string, command: ServerTaskCommand): Promise<CommandResult> {
    if (this.view.status !== 'online' || this.activeWorkspaceId === null) {
      throw new OfflineWriteError();
    }
    try {
      const result = await this.transport.sendCommand(this.activeWorkspaceId, taskId, command);
      await this.acceptCommandResult(result);
      return result;
    } catch (error) {
      if (error instanceof VersionConflictError) {
        const current = this.view.snapshot;
        if (current !== null) {
          const next = {
            ...current,
            tasks: current.tasks
              .filter((task) => task.id !== error.currentTask.id)
              .concat(error.currentTask),
          };
          await this.cache.replaceWithConfirmedSnapshot(next);
          this.publish({ snapshot: next, status: 'conflict', message: error.message });
        } else {
          this.setStatus('conflict', error.message);
        }
      }
      throw error;
    }
  }

  async create(input: ServerCreateTaskInput): Promise<CommandResult> {
    if (this.view.status !== 'online' || this.activeWorkspaceId === null) {
      throw new OfflineWriteError();
    }
    const result = await this.transport.createTask(this.activeWorkspaceId, input);
    await this.acceptCommandResult(result);
    return result;
  }

  private async acceptCommandResult(result: CommandResult): Promise<void> {
    const current = this.view.snapshot;
    if (current === null) return;
    const tasks = current.tasks.filter((task) => task.id !== result.task.id).concat(result.task);
    const next: ConfirmedSnapshot = {
      ...current,
      cursor: Math.max(current.cursor, result.cursor),
      capturedAt: new Date().toISOString(),
      tasks,
    };
    await this.cache.replaceWithConfirmedSnapshot(next);
    this.publish({ snapshot: next, status: 'online', message: null });
  }

  private applyEvent(snapshot: ConfirmedSnapshot, event: WorkspaceEvent): ConfirmedSnapshot | null {
    if (event.task === null && event.removedTaskId === null) return null;
    let tasks = snapshot.tasks;
    if (event.removedTaskId !== null) {
      tasks = tasks.filter((task) => task.id !== event.removedTaskId);
    }
    if (event.task !== null) {
      tasks = tasks.filter((task) => task.id !== event.task!.id).concat(event.task);
    }
    return {
      ...snapshot,
      cursor: event.workspaceSequence,
      capturedAt: new Date().toISOString(),
      tasks,
    };
  }

  private async recoverAfter(cursor: number, generation: number): Promise<void> {
    if (!this.isActiveGeneration(generation) || this.activeWorkspaceId === null) return;
    const workspaceId = this.activeWorkspaceId;
    this.setStatus('recovering', '检测到序号缺口，正在补齐变化');
    const incremental = await this.transport.fetchIncremental(workspaceId, cursor);
    if (!this.isActiveGeneration(generation)) return;
    if (incremental.requiresSnapshot) {
      await this.rebuildFromSnapshot(generation);
      return;
    }

    let snapshot = this.view.snapshot;
    if (snapshot === null) {
      await this.rebuildFromSnapshot(generation);
      return;
    }
    for (const event of [...incremental.events].sort(
      (left, right) => left.workspaceSequence - right.workspaceSequence,
    )) {
      if (event.workspaceSequence <= snapshot.cursor) continue;
      if (event.schemaVersion !== 1 || event.workspaceSequence !== snapshot.cursor + 1) {
        await this.rebuildFromSnapshot(generation);
        return;
      }
      if (event.refreshRequired === true) {
        await this.refreshProjection(generation);
        return;
      }
      const next = this.applyEvent(snapshot, event);
      if (next === null) {
        await this.rebuildFromSnapshot(generation);
        return;
      }
      snapshot = next;
    }
    if (!this.isActiveGeneration(generation)) return;
    await this.cache.replaceWithConfirmedSnapshot(snapshot);
    if (!this.isActiveGeneration(generation)) return;
    this.publish({ snapshot, status: 'online', message: null });
  }

  private async rebuildFromSnapshot(generation: number): Promise<void> {
    await this.refreshProjection(generation);
  }

  private async refreshProjection(generation: number): Promise<void> {
    if (!this.isActiveGeneration(generation) || this.activeWorkspaceId === null) return;
    const workspaceId = this.activeWorkspaceId;
    const snapshot = await this.transport.fetchSnapshot(workspaceId);
    if (!this.isActiveGeneration(generation)) return;
    await this.cache.replaceWithConfirmedSnapshot(snapshot);
    if (!this.isActiveGeneration(generation)) return;
    this.publish({ snapshot, status: 'online', message: null });
  }

  private async openRealtime(generation: number): Promise<void> {
    while (this.isActiveGeneration(generation)) {
      const existingFlight = this.realtimeConnectFlight;
      if (existingFlight !== null) {
        try {
          await existingFlight.promise;
        } catch (error) {
          if (existingFlight.generation === generation) throw error;
        }
        if (existingFlight.generation === generation) return;
        continue;
      }

      const promise = this.connectRealtimeForGeneration(generation).finally(() => {
        if (this.realtimeConnectFlight?.promise === promise) {
          this.realtimeConnectFlight = null;
        }
      });
      this.realtimeConnectFlight = { generation, promise };
      await promise;
      return;
    }
  }

  private async connectRealtimeForGeneration(generation: number): Promise<void> {
    if (
      !this.isActiveGeneration(generation) ||
      this.activeWorkspaceId === null ||
      this.view.snapshot === null
    ) {
      return;
    }
    const workspaceId = this.activeWorkspaceId;
    const cursor = this.view.snapshot.cursor;
    this.disconnectRealtime?.();
    this.disconnectRealtime = null;
    const disconnect = await this.transport.connectRealtime(workspaceId, cursor, {
      onEvent: (event) => {
        void this.acceptRealtimeEventForGeneration(event, generation).catch(() => {
          if (!this.isActiveGeneration(generation)) return;
          this.setStatus('reconnecting', '实时事件无法解释，准备重建快照');
          void this.rebuildFromSnapshot(generation).catch(() => {
            if (this.isActiveGeneration(generation)) {
              this.setStatus('offline', '快照重建失败，正在显示确认缓存');
            }
          });
        });
      },
      onDisconnect: () => {
        if (this.isActiveGeneration(generation)) this.markDisconnected();
      },
    });
    if (!this.isActiveGeneration(generation)) {
      disconnect();
      return;
    }
    this.disconnectRealtime = disconnect;
  }

  private isCurrentGeneration(generation: number): boolean {
    return generation === this.visibilityGeneration && this.activeWorkspaceId !== null;
  }

  private isActiveGeneration(generation: number): boolean {
    return this.windowVisible && this.isCurrentGeneration(generation);
  }
}
