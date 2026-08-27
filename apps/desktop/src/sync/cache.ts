import type { MemberSummary, TaskItem } from '@fanshuye/ui';

export interface WorkspaceSnapshotInfo {
  id: string;
  name: string;
  timezone: string;
  tree: { id: string; name: string };
}

export interface WorkstreamSnapshotInfo {
  id: string;
  name: string;
  sortOrder: number;
}

export interface MemberSnapshotInfo extends MemberSummary {
  role: 'ADMIN' | 'MEMBER';
}

export interface DependencySnapshotInfo {
  prerequisiteTaskId: string;
  dependentTaskId: string;
  relationType: 'BLOCKS';
}

export interface ConfirmedSnapshot {
  workspaceId: string;
  cursor: number;
  capturedAt: string;
  workspace: WorkspaceSnapshotInfo;
  workstreams: WorkstreamSnapshotInfo[];
  members: MemberSnapshotInfo[];
  dependencies: DependencySnapshotInfo[];
  tasks: TaskItem[];
}

export interface ConfirmedCache {
  loadConfirmedSnapshot(workspaceId: string): Promise<ConfirmedSnapshot | null>;
  replaceWithConfirmedSnapshot(snapshot: ConfirmedSnapshot): Promise<void>;
  clearWorkspace(workspaceId: string): Promise<void>;
}

export class MemoryConfirmedCache implements ConfirmedCache {
  private readonly snapshots = new Map<string, ConfirmedSnapshot>();

  loadConfirmedSnapshot(workspaceId: string): Promise<ConfirmedSnapshot | null> {
    const snapshot = this.snapshots.get(workspaceId);
    return Promise.resolve(snapshot === undefined ? null : structuredClone(snapshot));
  }

  replaceWithConfirmedSnapshot(snapshot: ConfirmedSnapshot): Promise<void> {
    this.snapshots.set(snapshot.workspaceId, structuredClone(snapshot));
    return Promise.resolve();
  }

  clearWorkspace(workspaceId: string): Promise<void> {
    this.snapshots.delete(workspaceId);
    return Promise.resolve();
  }
}

interface SnapshotMetaRow {
  workspace_id: string;
  cursor: number;
  captured_at: string;
}

interface TaskCacheRow {
  payload_json: string;
}

interface SnapshotContextRow {
  payload_json: string;
}

interface DependencyCacheRow {
  prerequisite_task_id: string;
  dependent_task_id: string;
}

interface SnapshotContext {
  workspace: WorkspaceSnapshotInfo;
  workstreams: WorkstreamSnapshotInfo[];
  members: MemberSnapshotInfo[];
}

interface SqlDatabase {
  select<T>(query: string, bindValues?: unknown[]): Promise<T>;
  execute(query: string, bindValues?: unknown[]): Promise<unknown>;
}

export class SqliteConfirmedCache implements ConfirmedCache {
  constructor(private readonly database: SqlDatabase) {}

  async loadConfirmedSnapshot(workspaceId: string): Promise<ConfirmedSnapshot | null> {
    const metadata = await this.database.select<SnapshotMetaRow[]>(
      'SELECT workspace_id, cursor, captured_at FROM sync_meta WHERE workspace_id = $1 LIMIT 1',
      [workspaceId],
    );
    const meta = metadata[0];
    if (meta === undefined) return null;

    const rows = await this.database.select<TaskCacheRow[]>(
      'SELECT payload_json FROM task_cache WHERE workspace_id = $1 ORDER BY task_id',
      [workspaceId],
    );
    const contextRows = await this.database.select<SnapshotContextRow[]>(
      'SELECT payload_json FROM snapshot_context_cache WHERE workspace_id = $1 LIMIT 1',
      [workspaceId],
    );
    const dependencyRows = await this.database.select<DependencyCacheRow[]>(
      `SELECT prerequisite_task_id, dependent_task_id
         FROM dependency_cache
        WHERE workspace_id = $1
        ORDER BY prerequisite_task_id, dependent_task_id`,
      [workspaceId],
    );
    try {
      const contextRow = contextRows[0];
      if (contextRow === undefined) throw new Error('Snapshot context is unavailable');
      const context = JSON.parse(contextRow.payload_json) as SnapshotContext;
      return {
        workspaceId: meta.workspace_id,
        cursor: Number(meta.cursor),
        capturedAt: meta.captured_at,
        workspace: context.workspace,
        workstreams: context.workstreams,
        members: context.members,
        dependencies: dependencyRows.map((dependency) => ({
          prerequisiteTaskId: dependency.prerequisite_task_id,
          dependentTaskId: dependency.dependent_task_id,
          relationType: 'BLOCKS',
        })),
        tasks: rows.map((row) => JSON.parse(row.payload_json) as TaskItem),
      };
    } catch {
      await this.clearWorkspace(workspaceId);
      return null;
    }
  }

  async replaceWithConfirmedSnapshot(snapshot: ConfirmedSnapshot): Promise<void> {
    await this.database.execute('BEGIN IMMEDIATE');
    try {
      await this.database.execute('DELETE FROM task_cache WHERE workspace_id = $1', [
        snapshot.workspaceId,
      ]);
      await this.database.execute('DELETE FROM dependency_cache WHERE workspace_id = $1', [
        snapshot.workspaceId,
      ]);
      await this.database.execute('DELETE FROM member_cache WHERE workspace_id = $1', [
        snapshot.workspaceId,
      ]);
      for (const task of snapshot.tasks) {
        await this.database.execute(
          `INSERT INTO task_cache (workspace_id, task_id, version, payload_json)
           VALUES ($1, $2, $3, $4)`,
          [snapshot.workspaceId, task.id, task.version, JSON.stringify(task)],
        );
      }
      for (const dependency of snapshot.dependencies) {
        await this.database.execute(
          `INSERT INTO dependency_cache
           (workspace_id, prerequisite_task_id, dependent_task_id)
           VALUES ($1, $2, $3)`,
          [snapshot.workspaceId, dependency.prerequisiteTaskId, dependency.dependentTaskId],
        );
      }
      for (const member of snapshot.members) {
        await this.database.execute(
          `INSERT INTO member_cache (workspace_id, member_id, display_name)
           VALUES ($1, $2, $3)`,
          [snapshot.workspaceId, member.id, member.displayName],
        );
      }
      await this.database.execute(
        `INSERT INTO snapshot_context_cache (workspace_id, payload_json)
         VALUES ($1, $2)
         ON CONFLICT(workspace_id) DO UPDATE SET payload_json = excluded.payload_json`,
        [
          snapshot.workspaceId,
          JSON.stringify({
            workspace: snapshot.workspace,
            workstreams: snapshot.workstreams,
            members: snapshot.members,
          } satisfies SnapshotContext),
        ],
      );
      await this.database.execute(
        `INSERT INTO sync_meta (workspace_id, cursor, captured_at)
         VALUES ($1, $2, $3)
         ON CONFLICT(workspace_id) DO UPDATE SET
           cursor = excluded.cursor,
           captured_at = excluded.captured_at`,
        [snapshot.workspaceId, snapshot.cursor, snapshot.capturedAt],
      );
      await this.database.execute('COMMIT');
    } catch (error) {
      await this.database.execute('ROLLBACK');
      throw error;
    }
  }

  async clearWorkspace(workspaceId: string): Promise<void> {
    await this.database.execute('BEGIN IMMEDIATE');
    try {
      await this.database.execute('DELETE FROM task_cache WHERE workspace_id = $1', [workspaceId]);
      await this.database.execute('DELETE FROM member_cache WHERE workspace_id = $1', [
        workspaceId,
      ]);
      await this.database.execute('DELETE FROM dependency_cache WHERE workspace_id = $1', [
        workspaceId,
      ]);
      await this.database.execute('DELETE FROM snapshot_context_cache WHERE workspace_id = $1', [
        workspaceId,
      ]);
      await this.database.execute('DELETE FROM sync_meta WHERE workspace_id = $1', [workspaceId]);
      await this.database.execute('COMMIT');
    } catch (error) {
      await this.database.execute('ROLLBACK');
      throw error;
    }
  }
}

export async function createConfirmedCache(): Promise<ConfirmedCache> {
  if (window.__TAURI_INTERNALS__ === undefined) return new MemoryConfirmedCache();
  try {
    const { default: Database } = await import('@tauri-apps/plugin-sql');
    const database = await Database.load('sqlite:fanshuye-cache.db');
    return new SqliteConfirmedCache(database);
  } catch {
    return new MemoryConfirmedCache();
  }
}
