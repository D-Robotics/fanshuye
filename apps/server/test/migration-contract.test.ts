import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('initial PostgreSQL migration', () => {
  it('contains the durable collaboration, DAG, idempotency and sync constraints', async () => {
    const sql = await readFile(join(process.cwd(), 'migrations', '0001_initial.sql'), 'utf8');
    for (const table of [
      'users',
      'sessions',
      'workspaces',
      'workspace_memberships',
      'task_trees',
      'workstreams',
      'tasks',
      'task_collaborators',
      'task_dependencies',
      'task_external_references',
      'task_events',
      'processed_commands',
      'workspace_sync_state',
    ]) {
      expect(sql).toContain(`CREATE TABLE ${table}`);
    }
    expect(sql).toContain('CHECK (prerequisite_task_id <> dependent_task_id)');
    expect(sql).toContain('UNIQUE (workspace_id, prerequisite_task_id, dependent_task_id)');
    expect(sql).toContain('UNIQUE (workspace_id, workspace_sequence)');
    expect(sql).toContain('task_events_append_only');
  });
});
