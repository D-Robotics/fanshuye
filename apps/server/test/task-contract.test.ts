import { describe, expect, it } from 'vitest';
import { mapTaskProjection, type TaskProjectionRow } from '../src/modules/tasks/projection';
import { CreateTaskSchema, TaskCommandSchema } from '../src/modules/tasks/schemas';

const baseRow: TaskProjectionRow = {
  id: '50000000-0000-4000-8000-000000000001',
  workspace_id: '20000000-0000-4000-8000-000000000001',
  tree_id: '30000000-0000-4000-8000-000000000001',
  workstream_id: '40000000-0000-4000-8000-000000000001',
  title: 'Implement sync',
  description: '',
  definition_of_done: '',
  owner_id: null,
  owner_display_name: null,
  creator_display_name: 'Developer',
  status: 'TODO',
  manual_block_type: null,
  manual_block_reason: null,
  importance: 3,
  due_at: null,
  action_override: null,
  action_override_reason: null,
  action_override_expires_at: null,
  manual_order: null,
  version: 1,
  archived_at: null,
  created_by: '10000000-0000-4000-8000-000000000001',
  created_at: new Date('2026-01-01T00:00:00Z'),
  updated_at: new Date('2026-01-01T00:00:00Z'),
  workspace_timezone: 'Asia/Shanghai',
  collaborators: [],
  prerequisites: [],
  dependents: [],
  external_references: [],
  dependency_blocked: false,
  highest_blocked_dependent_level: null,
};

describe('task contract', () => {
  it('keeps importance, urgency and blocking as separate explainable fields', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const projected = mapTaskProjection(
      {
        ...baseRow,
        importance: 5,
        due_at: new Date('2026-01-01T12:00:00Z'),
        manual_block_type: 'EXTERNAL',
        manual_block_reason: 'Waiting for a test device',
      },
      now,
    );
    expect(projected.leafSize).toBe('LARGE');
    // Blocked work retains the objective deadline warning but is not presented
    // as directly executable NOW work.
    expect(projected.actionLevel).toBe('NEXT');
    expect(projected.actionReasons).toContain('DEADLINE_WITHIN_24_HOURS');
    expect(projected.manualBlocked).toBe(true);
    expect(projected.status).toBe('TODO');
  });

  it('expires an action override without rewriting importance', () => {
    const projected = mapTaskProjection(
      {
        ...baseRow,
        importance: 2,
        action_override: 'NOW',
        action_override_reason: 'Incident follow-up',
        action_override_expires_at: new Date('2025-12-31T00:00:00Z'),
      },
      new Date('2026-01-01T00:00:00Z'),
    );
    expect(projected.actionLevel).toBe('LATER');
    expect(projected.importance).toBe(2);
    expect(projected.actionOverride).toMatchObject({ active: false });
  });

  it('promotes an unlocking prerequisite by at most one action level', () => {
    const projected = mapTaskProjection(
      {
        ...baseRow,
        importance: 1,
        highest_blocked_dependent_level: 'NOW',
      },
      new Date('2026-01-01T00:00:00Z'),
    );
    expect(projected.actionLevel).toBe('NEXT');
    expect(projected.actionReasons).toContain('UNLOCKS_DOWNSTREAM');
  });

  it('rejects arbitrary actor and target-state fields from semantic commands', () => {
    const parsed = TaskCommandSchema.safeParse({
      type: 'StartTask',
      commandId: '70000000-0000-4000-8000-000000000001',
      expectedVersion: 1,
      actorType: 'agent',
      targetStatus: 'DONE',
    });
    expect(parsed.success).toBe(false);
  });

  it('requires a useful title and bounded importance', () => {
    expect(
      CreateTaskSchema.safeParse({
        commandId: '70000000-0000-4000-8000-000000000001',
        title: '   ',
      }).success,
    ).toBe(false);
    expect(
      CreateTaskSchema.safeParse({
        commandId: '70000000-0000-4000-8000-000000000001',
        title: 'Valid task',
        importance: 6,
      }).success,
    ).toBe(false);
  });
});
