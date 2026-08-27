import { describe, expect, it } from 'vitest';

import {
  CreateTaskCommandSchema,
  CreateTaskRequestSchema,
  EventEnvelopeSchema,
  ExternalReferenceSchema,
  TaskDomainEventSchema,
  TaskMutationRequestSchema,
  TaskCommandSchema,
  TaskSnapshotSchema,
  WireApiErrorSchema,
} from '../src/index.js';

const ids = {
  command: '10000000-0000-4000-8000-000000000001',
  correlation: '10000000-0000-4000-8000-000000000002',
  workspace: '10000000-0000-4000-8000-000000000003',
  task: '10000000-0000-4000-8000-000000000004',
  tree: '10000000-0000-4000-8000-000000000005',
  workstream: '10000000-0000-4000-8000-000000000006',
  owner: '10000000-0000-4000-8000-000000000007',
};

describe('versioned command contracts', () => {
  it('applies safe defaults to a minimal task creation command', () => {
    const command = CreateTaskCommandSchema.parse({
      schemaVersion: 1,
      type: 'CreateTask',
      commandId: ids.command,
      correlationId: ids.correlation,
      workspaceId: ids.workspace,
      taskId: ids.task,
      taskTreeId: ids.tree,
      workstreamId: ids.workstream,
      title: '  Fix login timeout  ',
    });

    expect(command.title).toBe('Fix login timeout');
    expect(command.importance).toBe(3);
    expect(command.ownerId).toBeNull();
    expect(command.collaboratorIds).toEqual([]);
  });

  it('requires expectedVersion on an existing-task command', () => {
    expect(() =>
      TaskCommandSchema.parse({
        schemaVersion: 1,
        type: 'StartTask',
        commandId: ids.command,
        correlationId: ids.correlation,
        workspaceId: ids.workspace,
        taskId: ids.task,
      }),
    ).toThrow();
  });

  it('rejects actor metadata supplied by a client', () => {
    expect(() =>
      TaskCommandSchema.parse({
        schemaVersion: 1,
        type: 'StartTask',
        commandId: ids.command,
        correlationId: ids.correlation,
        workspaceId: ids.workspace,
        taskId: ids.task,
        expectedVersion: 1,
        actorType: 'agent',
      }),
    ).toThrow();
  });
});

describe('REST wire contracts', () => {
  it('shares the server command body and rejects forged actor metadata', () => {
    expect(
      TaskMutationRequestSchema.parse({
        type: 'StartTask',
        commandId: ids.command,
        expectedVersion: 1,
      }).schemaVersion,
    ).toBe(1);
    expect(() =>
      TaskMutationRequestSchema.parse({
        type: 'StartTask',
        commandId: ids.command,
        expectedVersion: 1,
        actorType: 'agent',
      }),
    ).toThrow();
  });

  it('derives the requester from authentication instead of accepting a forged target owner', () => {
    expect(
      TaskMutationRequestSchema.parse({
        type: 'RequestOwnerTransfer',
        commandId: ids.command,
        expectedVersion: 2,
      }),
    ).toEqual({
      schemaVersion: 1,
      type: 'RequestOwnerTransfer',
      commandId: ids.command,
      expectedVersion: 2,
    });
    expect(() =>
      TaskMutationRequestSchema.parse({
        type: 'RequestOwnerTransfer',
        commandId: ids.command,
        expectedVersion: 2,
        requesterId: ids.owner,
      }),
    ).toThrow();
  });

  it('applies creation defaults and accepts opaque correlation IDs in errors', () => {
    const creation = CreateTaskRequestSchema.parse({
      commandId: ids.command,
      title: 'Ship desktop adapter',
    });
    expect(creation).toMatchObject({ schemaVersion: 1, importance: 3, dueAt: null });

    const error = WireApiErrorSchema.parse({
      error: {
        code: 'VERSION_CONFLICT',
        message: 'Task changed',
        correlationId: 'req-7',
        details: { actualVersion: 3 },
      },
    });
    expect(error.schemaVersion).toBe(1);
    expect(error.error.correlationId).toBe('req-7');
  });
});

describe('task runtime contracts', () => {
  const snapshot = {
    id: ids.task,
    workspaceId: ids.workspace,
    taskTreeId: ids.tree,
    workstreamId: ids.workstream,
    title: 'Fix login timeout',
    description: '',
    definitionOfDone: '',
    status: 'TODO',
    ownerId: ids.owner,
    collaboratorIds: [],
    importance: 3,
    deadlineAt: null,
    manualBlock: null,
    manualActionOverride: null,
    manualOrder: null,
    version: 1,
    createdAt: '2026-08-26T08:00:00.000Z',
    updatedAt: '2026-08-26T08:00:00.000Z',
    archivedAt: null,
  } as const;

  it('rejects a primary owner duplicated as a collaborator', () => {
    expect(() =>
      TaskSnapshotSchema.parse({
        ...snapshot,
        collaboratorIds: [ids.owner],
      }),
    ).toThrow(/primary owner/i);
  });

  it('allows only HTTP(S) external references', () => {
    const base = {
      id: ids.command,
      taskId: ids.task,
      type: 'ISSUE',
      displayName: 'Issue',
    } as const;

    expect(() => ExternalReferenceSchema.parse({ ...base, url: 'file:///secret' })).toThrow();
    expect(
      ExternalReferenceSchema.parse({
        ...base,
        url: 'https://example.test/issues/1',
      }).url,
    ).toBe('https://example.test/issues/1');
  });
});

describe('event envelopes', () => {
  it('models a takeover request as an auditable event without an owner replacement', () => {
    const event = TaskDomainEventSchema.parse({
      schemaVersion: 1,
      eventId: ids.command,
      workspaceId: ids.workspace,
      workspaceSequence: 9,
      aggregateType: 'Task',
      aggregateId: ids.task,
      aggregateVersion: 3,
      eventType: 'TaskOwnerTransferRequested',
      actorType: 'human',
      actorId: ids.owner,
      occurredAt: '2026-08-26T08:00:00.000Z',
      commandId: ids.command,
      correlationId: ids.correlation,
      causationId: null,
      payload: { requesterId: ids.owner, currentOwnerId: ids.correlation },
    });

    expect(event.eventType).toBe('TaskOwnerTransferRequested');
    expect(event.payload).toEqual({ requesterId: ids.owner, currentOwnerId: ids.correlation });
  });

  it('requires the complete versioned audit metadata', () => {
    const event = EventEnvelopeSchema.parse({
      schemaVersion: 1,
      eventId: ids.command,
      workspaceId: ids.workspace,
      workspaceSequence: 8,
      aggregateType: 'Task',
      aggregateId: ids.task,
      aggregateVersion: 2,
      eventType: 'TaskStarted',
      actorType: 'human',
      actorId: ids.owner,
      occurredAt: '2026-08-26T08:00:00.000Z',
      commandId: ids.command,
      correlationId: ids.correlation,
      causationId: null,
      payload: {},
    });

    expect(event.workspaceSequence).toBe(8);
    expect(event.actorType).toBe('human');
  });

  it('validates metadata for forward-compatible non-task events', () => {
    const event = EventEnvelopeSchema.parse({
      schemaVersion: 1,
      eventId: ids.command,
      workspaceId: ids.workspace,
      workspaceSequence: 1,
      aggregateType: 'Workspace',
      aggregateId: ids.workspace,
      aggregateVersion: 1,
      eventType: 'WorkspaceCreated',
      actorType: 'human',
      actorId: ids.owner,
      occurredAt: '2026-08-26T08:00:00.000Z',
      commandId: ids.command,
      correlationId: null,
      causationId: null,
      payload: { name: 'Team' },
    });

    expect(event.aggregateType).toBe('Workspace');
    expect(event.eventType).toBe('WorkspaceCreated');
  });
});
