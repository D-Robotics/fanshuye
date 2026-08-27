import { describe, expect, it } from 'vitest';
import { makeTask } from '../test/fixtures';
import { SqliteConfirmedCache, type ConfirmedSnapshot } from './cache';

class RecordingDatabase {
  readonly statements: Array<{ query: string; values: unknown[] }> = [];
  readonly selections: unknown[][] = [];
  failWhenQueryIncludes: string | null = null;

  select<T>(): Promise<T> {
    return Promise.resolve((this.selections.shift() ?? []) as T);
  }

  execute(query: string, values: unknown[] = []): Promise<unknown> {
    this.statements.push({ query, values });
    if (this.failWhenQueryIncludes !== null && query.includes(this.failWhenQueryIncludes)) {
      return Promise.reject(new Error('injected sqlite failure'));
    }
    return Promise.resolve({ rowsAffected: 1 });
  }
}

function snapshot(): ConfirmedSnapshot {
  return {
    workspaceId: 'workspace-a',
    cursor: 12,
    capturedAt: '2030-01-01T00:00:00.000Z',
    workspace: {
      id: 'workspace-a',
      name: '开发组',
      timezone: 'Asia/Shanghai',
      tree: { id: 'tree-a', name: '任务树' },
    },
    workstreams: [{ id: 'stream-a', name: '平台', sortOrder: 0 }],
    members: [{ id: 'member-a', displayName: '艾达', role: 'ADMIN' }],
    dependencies: [
      {
        prerequisiteTaskId: 'task-complete-prerequisite',
        dependentTaskId: 'task-001',
        relationType: 'BLOCKS',
      },
    ],
    // The complete prerequisite is deliberately absent from
    // incompletePrerequisites; the top-level edge must still be cached.
    tasks: [makeTask({ incompletePrerequisites: [] })],
  };
}

describe('SqliteConfirmedCache', () => {
  it('writes members, the complete dependency graph and cursor in one transaction', async () => {
    const database = new RecordingDatabase();
    const cache = new SqliteConfirmedCache(database);

    await cache.replaceWithConfirmedSnapshot(snapshot());

    expect(database.statements[0]?.query).toBe('BEGIN IMMEDIATE');
    expect(database.statements.at(-1)?.query).toBe('COMMIT');
    expect(
      database.statements.some(({ query }) => query.includes('INSERT INTO member_cache')),
    ).toBe(true);
    expect(
      database.statements.some(
        ({ query, values }) =>
          query.includes('INSERT INTO dependency_cache') &&
          values.includes('task-complete-prerequisite'),
      ),
    ).toBe(true);
    const cursorWrite = database.statements.findIndex(({ query }) =>
      query.includes('INSERT INTO sync_meta'),
    );
    const commit = database.statements.findIndex(({ query }) => query === 'COMMIT');
    expect(cursorWrite).toBeGreaterThan(0);
    expect(cursorWrite).toBeLessThan(commit);
  });

  it('rolls back the cache and cursor when any confirmed-state write fails', async () => {
    const database = new RecordingDatabase();
    database.failWhenQueryIncludes = 'INSERT INTO dependency_cache';
    const cache = new SqliteConfirmedCache(database);

    await expect(cache.replaceWithConfirmedSnapshot(snapshot())).rejects.toThrow(
      'injected sqlite failure',
    );

    expect(database.statements.some(({ query }) => query === 'COMMIT')).toBe(false);
    expect(database.statements.at(-1)?.query).toBe('ROLLBACK');
    expect(database.statements.some(({ query }) => query.includes('INSERT INTO sync_meta'))).toBe(
      false,
    );
  });

  it('restores members and all dependency edges from confirmed cache rows', async () => {
    const database = new RecordingDatabase();
    const expected = snapshot();
    database.selections.push(
      [
        {
          workspace_id: expected.workspaceId,
          cursor: expected.cursor,
          captured_at: expected.capturedAt,
        },
      ],
      expected.tasks.map((task) => ({ payload_json: JSON.stringify(task) })),
      [
        {
          payload_json: JSON.stringify({
            workspace: expected.workspace,
            workstreams: expected.workstreams,
            members: expected.members,
          }),
        },
      ],
      expected.dependencies.map((dependency) => ({
        prerequisite_task_id: dependency.prerequisiteTaskId,
        dependent_task_id: dependency.dependentTaskId,
      })),
    );

    const restored = await new SqliteConfirmedCache(database).loadConfirmedSnapshot(
      expected.workspaceId,
    );

    expect(restored).toEqual(expected);
  });

  it('detects corrupt cached JSON and clears the rebuildable workspace cache', async () => {
    const database = new RecordingDatabase();
    const expected = snapshot();
    database.selections.push(
      [
        {
          workspace_id: expected.workspaceId,
          cursor: expected.cursor,
          captured_at: expected.capturedAt,
        },
      ],
      [{ payload_json: '{broken-json' }],
      [
        {
          payload_json: JSON.stringify({
            workspace: expected.workspace,
            workstreams: expected.workstreams,
            members: expected.members,
          }),
        },
      ],
      [],
    );

    const restored = await new SqliteConfirmedCache(database).loadConfirmedSnapshot(
      expected.workspaceId,
    );

    expect(restored).toBeNull();
    expect(database.statements[0]?.query).toBe('BEGIN IMMEDIATE');
    expect(database.statements.some(({ query }) => query.includes('DELETE FROM task_cache'))).toBe(
      true,
    );
    expect(database.statements.at(-1)?.query).toBe('COMMIT');
  });
});
