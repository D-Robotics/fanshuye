import { ZodError } from 'zod';
import {
  ServerTaskCommandSchema,
  buildServerTaskCommand,
  parseServerIncremental,
  parseServerSnapshot,
} from './server-adapter';
import { SERVER_IDS, makeServerSnapshot, makeTaskStartedEvent } from '../test/server-fixtures';

describe('server contract adapter', () => {
  it('projects the real snapshotCursor/workspace/members/tasks DTO into desktop state', () => {
    const snapshotInput = makeServerSnapshot();
    snapshotInput.tasks[0] = {
      ...snapshotInput.tasks[0]!,
      prerequisites: [
        {
          id: '00000000-0000-4000-8000-000000000010',
          title: '已完成前置',
          status: 'DONE',
          version: 2,
          incomplete: false,
        },
        {
          id: '00000000-0000-4000-8000-000000000011',
          title: '未完成前置',
          status: 'IN_PROGRESS',
          version: 3,
          incomplete: true,
        },
      ],
      incompletePrerequisites: [
        {
          id: '00000000-0000-4000-8000-000000000011',
          title: '未完成前置',
          status: 'IN_PROGRESS',
          version: 3,
          incomplete: true,
        },
      ],
    };
    const snapshot = parseServerSnapshot(snapshotInput);

    expect(snapshot.workspaceId).toBe(SERVER_IDS.workspace);
    expect(snapshot.cursor).toBe(12);
    expect(snapshot.workspace.tree.name).toBe('开发任务树');
    expect(snapshot.members.map((member) => member.displayName)).toEqual(['艾达', '图灵']);
    expect(snapshot.tasks[0]).toMatchObject({
      workstreamName: '桌面端',
      ownerId: SERVER_IDS.owner,
      ownerName: '艾达',
      collaboratorIds: [SERVER_IDS.collaborator],
      collaboratorNames: ['图灵'],
      manualBlock: { type: 'resource', reason: '等待测试环境' },
      prerequisites: [
        expect.objectContaining({ taskId: '00000000-0000-4000-8000-000000000010' }),
        expect.objectContaining({ taskId: '00000000-0000-4000-8000-000000000011' }),
      ],
      incompletePrerequisites: [
        expect.objectContaining({ taskId: '00000000-0000-4000-8000-000000000011' }),
      ],
      stableOrder: 12.5,
    });
  });

  it('rejects drifted snapshots instead of hiding missing fields behind a cast', () => {
    const invalid = makeServerSnapshot();
    Reflect.deleteProperty(invalid.tasks[0]!, 'collaborators');

    expect(() => parseServerSnapshot(invalid)).toThrow(ZodError);
  });

  it('parses shared event envelopes from the incremental wire response', () => {
    const result = parseServerIncremental({
      schemaVersion: 1,
      events: [makeTaskStartedEvent()],
      nextCursor: 13,
      currentCursor: 13,
      hasMore: false,
    });

    expect(result.events[0]?.eventType).toBe('TaskStarted');
    expect(result.events[0]?.workspaceSequence).toBe(13);
  });

  it('recognizes takeover requests as sync events without an owner mutation payload', () => {
    const result = parseServerIncremental({
      schemaVersion: 1,
      events: [
        {
          ...makeTaskStartedEvent(),
          eventType: 'TaskOwnerTransferRequested',
          payload: {
            requesterId: SERVER_IDS.collaborator,
            currentOwnerId: SERVER_IDS.owner,
          },
        },
      ],
      nextCursor: 13,
      currentCursor: 13,
      hasMore: false,
    });

    expect(result.events[0]).toMatchObject({
      eventType: 'TaskOwnerTransferRequested',
      payload: {
        requesterId: SERVER_IDS.collaborator,
        currentOwnerId: SERVER_IDS.owner,
      },
    });
  });

  it('keeps valid workspace-level envelopes as projection invalidations', () => {
    const workspaceEvent = {
      ...makeTaskStartedEvent(),
      aggregateType: 'Workspace',
      aggregateId: SERVER_IDS.workspace,
      eventType: 'WorkspaceMemberRemoved',
      correlationId: null,
      payload: { memberId: SERVER_IDS.collaborator },
    };

    const result = parseServerIncremental({
      schemaVersion: 1,
      events: [workspaceEvent],
      nextCursor: 13,
      currentCursor: 13,
      hasMore: false,
    });

    expect(result.events[0]).toMatchObject({
      aggregateType: 'Workspace',
      eventType: 'WorkspaceMemberRemoved',
    });
  });

  it('builds the server discriminated union without commandType or payload wrappers', () => {
    const command = buildServerTaskCommand(
      {
        name: 'block',
        taskId: SERVER_IDS.task,
        expectedVersion: 3,
        payload: { type: 'resource', reason: '构建机不足' },
      },
      SERVER_IDS.command,
      SERVER_IDS.owner,
    );

    expect(command).toEqual({
      schemaVersion: 1,
      type: 'BlockTask',
      commandId: SERVER_IDS.command,
      expectedVersion: 3,
      blockType: 'CAPACITY',
      reason: '构建机不足',
    });
    expect(ServerTaskCommandSchema.safeParse(command).success).toBe(true);
    expect(command).not.toHaveProperty('commandType');
    expect(command).not.toHaveProperty('payload');
  });

  it('keeps self-join and takeover request as distinct authenticated commands', () => {
    const join = buildServerTaskCommand(
      { name: 'join', taskId: SERVER_IDS.task, expectedVersion: 3 },
      SERVER_IDS.command,
      SERVER_IDS.collaborator,
    );
    const request = buildServerTaskCommand(
      { name: 'request-transfer', taskId: SERVER_IDS.task, expectedVersion: 4 },
      SERVER_IDS.correlation,
      SERVER_IDS.collaborator,
    );

    expect(join).toEqual({
      schemaVersion: 1,
      type: 'AddCollaborator',
      commandId: SERVER_IDS.command,
      expectedVersion: 3,
      userId: SERVER_IDS.collaborator,
    });
    expect(request).toEqual({
      schemaVersion: 1,
      type: 'RequestOwnerTransfer',
      commandId: SERVER_IDS.correlation,
      expectedVersion: 4,
    });
    expect(request).not.toHaveProperty('ownerId');
    expect(request).not.toHaveProperty('requesterId');
  });
});
