import { describe, expect, it } from 'vitest';

import { TaskAggregate, deriveEffectiveBlockState } from '../src/index.js';
import type { DomainError } from '../src/index.js';

const ids = {
  task: '20000000-0000-4000-8000-000000000001',
  workspace: '20000000-0000-4000-8000-000000000002',
  tree: '20000000-0000-4000-8000-000000000003',
  workstream: '20000000-0000-4000-8000-000000000004',
  alice: '20000000-0000-4000-8000-000000000005',
  bob: '20000000-0000-4000-8000-000000000006',
  carol: '20000000-0000-4000-8000-000000000007',
  prerequisite: '20000000-0000-4000-8000-000000000008',
};

const T0 = new Date('2026-08-26T08:00:00.000Z');
const T1 = new Date('2026-08-26T09:00:00.000Z');

function newTask(
  overrides: Partial<Parameters<typeof TaskAggregate.create>[0]> = {},
): TaskAggregate {
  return TaskAggregate.create({
    id: ids.task,
    workspaceId: ids.workspace,
    taskTreeId: ids.tree,
    workstreamId: ids.workstream,
    title: '  Fix login timeout  ',
    occurredAt: T0,
    ...overrides,
  });
}

describe('task aggregate creation and versioning', () => {
  it('creates the minimal unowned TODO with importance 3', () => {
    const task = newTask();

    expect(task.snapshot).toMatchObject({
      title: 'Fix login timeout',
      status: 'TODO',
      ownerId: null,
      collaboratorIds: [],
      importance: 3,
      version: 1,
      archivedAt: null,
    });
    expect(task.uncommittedEvents).toEqual([
      expect.objectContaining({
        eventType: 'TaskCreated',
        aggregateVersion: 1,
      }),
    ]);
  });

  it('detects a stale expected version without mutating the task', () => {
    const task = newTask();

    expect(() => task.assertExpectedVersion(2)).toThrowError(
      expect.objectContaining<Partial<DomainError>>({
        code: 'VERSION_CONFLICT',
      }),
    );
    expect(task.snapshot.version).toBe(1);
  });

  it('increments one aggregate version per successful semantic change', () => {
    const updated = newTask().updateDetails({ description: 'Reproduce with a slow network' }, T1);

    expect(updated.snapshot.version).toBe(2);
    expect(updated.snapshot.updatedAt).toBe(T1.toISOString());
    expect(updated.uncommittedEvents.at(-1)?.eventType).toBe('TaskDetailsUpdated');
    expect(updated.markCommitted().uncommittedEvents).toEqual([]);
  });
});

describe('ownership and workflow semantics', () => {
  it('atomically claims and starts an unowned task', () => {
    const started = newTask().start(ids.alice, [], T1);

    expect(started.snapshot).toMatchObject({
      ownerId: ids.alice,
      status: 'IN_PROGRESS',
      version: 2,
    });
    expect(started.uncommittedEvents.at(-1)?.payload).toMatchObject({
      previousOwnerId: null,
      currentOwnerId: ids.alice,
      previousStatus: 'TODO',
      currentStatus: 'IN_PROGRESS',
    });
  });

  it('lets the assigned owner start but rejects a second independent owner', () => {
    const assigned = newTask({ ownerId: ids.alice });

    expect(assigned.start(ids.alice, [], T1).snapshot.status).toBe('IN_PROGRESS');
    expect(() => assigned.start(ids.bob, [], T1)).toThrowError(
      expect.objectContaining<Partial<DomainError>>({
        code: 'TASK_ALREADY_CLAIMED',
      }),
    );
  });

  it('rejects start while manually or dependency blocked', () => {
    const blocked = newTask().block('TECHNICAL', 'Waiting for a fix', T1);

    expect(() => blocked.start(ids.alice, [], T1)).toThrowError(
      expect.objectContaining<Partial<DomainError>>({ code: 'TASK_BLOCKED' }),
    );
    expect(() => newTask().start(ids.alice, [ids.prerequisite], T1)).toThrowError(
      expect.objectContaining<Partial<DomainError>>({
        code: 'TASK_BLOCKED_BY_DEPENDENCY',
      }),
    );
  });

  it('pauses without clearing owner and releases without clearing collaborators', () => {
    const started = newTask({ collaboratorIds: [ids.bob] }).start(ids.alice, [], T1);
    const paused = started.pause(T1);
    const released = started.release(T1);

    expect(paused.snapshot).toMatchObject({
      status: 'TODO',
      ownerId: ids.alice,
      collaboratorIds: [ids.bob],
    });
    expect(released.snapshot).toMatchObject({
      status: 'TODO',
      ownerId: null,
      collaboratorIds: [ids.bob],
    });
  });

  it('keeps one owner and a distinct set of collaborators', () => {
    const assigned = newTask({ ownerId: ids.alice });

    expect(() => assigned.addCollaborator(ids.alice, T1)).toThrowError(
      expect.objectContaining<Partial<DomainError>>({
        code: 'OWNER_CANNOT_COLLABORATE',
      }),
    );

    const collaborating = assigned.addCollaborator(ids.bob, T1);
    expect(collaborating.addCollaborator(ids.bob, T1)).toBe(collaborating);
    const transferred = collaborating.transferOwner(ids.bob, T1);
    expect(transferred.snapshot.ownerId).toBe(ids.bob);
    expect(transferred.snapshot.collaboratorIds).not.toContain(ids.bob);
  });

  it('supports review, changes requested, optional review, and terminal history', () => {
    const started = newTask().start(ids.alice, [], T1);
    const review = started.requestReview(T1);
    const changes = review.requestChanges(T1);
    const doneWithoutReview = changes.complete(T1);

    expect(review.snapshot.status).toBe('IN_REVIEW');
    expect(changes.snapshot.status).toBe('IN_PROGRESS');
    expect(doneWithoutReview.snapshot).toMatchObject({
      status: 'DONE',
      archivedAt: T1.toISOString(),
    });
    expect(doneWithoutReview.isActive).toBe(false);

    const reopened = doneWithoutReview.reopen(T1);
    expect(reopened.snapshot).toMatchObject({
      status: 'TODO',
      archivedAt: null,
      ownerId: ids.alice,
    });
  });
});

describe('orthogonal manual blocking and priority metadata', () => {
  it('does not change workflow state when blocking or unblocking', () => {
    const started = newTask().start(ids.alice, [], T1);
    const blocked = started.block('EXTERNAL', 'Vendor API is down', T1);
    const unblocked = blocked.unblock(T1);

    expect(blocked.snapshot.status).toBe('IN_PROGRESS');
    expect(blocked.snapshot.manualBlock).toMatchObject({
      type: 'EXTERNAL',
      reason: 'Vendor API is down',
    });
    expect(unblocked.snapshot.status).toBe('IN_PROGRESS');
    expect(unblocked.snapshot.manualBlock).toBeNull();
  });

  it('reports manual and dependency blocking independently', () => {
    const manualBlock = newTask().block('DECISION', 'Need an API decision', T1).snapshot
      .manualBlock;
    const state = deriveEffectiveBlockState(manualBlock, [ids.prerequisite, ids.prerequisite]);

    expect(state).toMatchObject({
      blocked: true,
      manuallyBlocked: true,
      dependencyBlocked: true,
      incompletePrerequisiteTaskIds: [ids.prerequisite],
    });
  });

  it.each(['TODO', 'IN_PROGRESS', 'IN_REVIEW'] as const)(
    'preserves the %s workflow state across a complete block/unblock round trip',
    (status) => {
      let task = newTask({ ownerId: ids.alice });
      if (status !== 'TODO') task = task.start(ids.alice, [], T1);
      if (status === 'IN_REVIEW') task = task.requestReview(T1);

      const blocked = task.block('TECHNICAL', '  Waiting for a reproducible build  ', T1);
      const unblocked = blocked.unblock(T1);

      expect(blocked.snapshot).toMatchObject({
        status,
        manualBlock: {
          type: 'TECHNICAL',
          reason: 'Waiting for a reproducible build',
        },
      });
      expect(unblocked.snapshot).toMatchObject({ status, manualBlock: null });
    },
  );

  it('requires a future expiry and clears an expired override', () => {
    expect(() =>
      newTask().setActionOverride('NOW', 'Incident response', '2026-08-26T07:59:00.000Z', T0),
    ).toThrowError(
      expect.objectContaining<Partial<DomainError>>({
        code: 'INVALID_ACTION_OVERRIDE',
      }),
    );

    const pinned = newTask().setActionOverride(
      'NOW',
      'Incident response',
      '2026-08-26T10:00:00.000Z',
      T0,
    );
    expect(pinned.expireActionOverride(T1).snapshot.manualActionOverride).not.toBeNull();
    const expired = pinned.expireActionOverride(new Date('2026-08-26T10:00:00.000Z'));
    expect(expired.snapshot.manualActionOverride).toBeNull();
    expect(expired.uncommittedEvents.at(-1)?.payload).toEqual({ expired: true });
  });
});

describe('idempotent aggregate commands', () => {
  it('does not advance version or append events for an already-satisfied command', () => {
    const task = newTask({
      ownerId: ids.alice,
      collaboratorIds: [ids.bob],
      importance: 3,
    });
    const originalVersion = task.snapshot.version;
    const originalEventCount = task.uncommittedEvents.length;

    const noOps = [
      task.transferOwner(ids.alice, T1),
      task.addCollaborator(ids.bob, T1),
      task.removeCollaborator(ids.carol, T1),
      task.unblock(T1),
      task.clearActionOverride(T1),
      task.expireActionOverride(T1),
      task.setImportance(3, T1),
    ];

    for (const result of noOps) {
      expect(result).toBe(task);
      expect(result.snapshot.version).toBe(originalVersion);
      expect(result.uncommittedEvents).toHaveLength(originalEventCount);
    }
  });
});
