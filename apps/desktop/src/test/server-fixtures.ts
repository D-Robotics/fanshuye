import type { WireTaskProjection } from '@fanshuye/contracts';

export const SERVER_IDS = {
  workspace: '00000000-0000-4000-8000-000000000001',
  task: '00000000-0000-4000-8000-000000000002',
  tree: '00000000-0000-4000-8000-000000000003',
  workstream: '00000000-0000-4000-8000-000000000004',
  owner: '00000000-0000-4000-8000-000000000005',
  collaborator: '00000000-0000-4000-8000-000000000006',
  command: '00000000-0000-4000-8000-000000000007',
  event: '00000000-0000-4000-8000-000000000008',
  correlation: '00000000-0000-4000-8000-000000000009',
} as const;

export function makeServerTask(overrides: Partial<WireTaskProjection> = {}): WireTaskProjection {
  return {
    id: SERVER_IDS.task,
    workspaceId: SERVER_IDS.workspace,
    treeId: SERVER_IDS.tree,
    workstreamId: SERVER_IDS.workstream,
    title: '修复同步契约',
    description: '让桌面端消费真实服务端投影。',
    definitionOfDone: '契约测试通过',
    owner: { id: SERVER_IDS.owner, displayName: '艾达' },
    collaborators: [{ id: SERVER_IDS.collaborator, displayName: '图灵' }],
    status: 'IN_PROGRESS',
    manualBlock: { type: 'CAPACITY', reason: '等待测试环境' },
    manualBlocked: true,
    dependencyBlocked: false,
    effectiveBlocked: true,
    incompletePrerequisites: [],
    prerequisites: [],
    dependents: [],
    importance: 5,
    leafSize: 'LARGE',
    dueAt: '2030-01-03T08:00:00.000Z',
    overdue: false,
    actionLevel: 'NOW',
    actionReasons: ['HIGH_IMPORTANCE'],
    actionOverride: null,
    manualOrder: '12.5',
    version: 3,
    archivedAt: null,
    createdBy: { id: SERVER_IDS.owner, displayName: '艾达' },
    createdAt: '2030-01-01T00:00:00.000Z',
    updatedAt: '2030-01-02T00:00:00.000Z',
    externalReferences: [],
    workspaceTimezone: 'Asia/Shanghai',
    ...overrides,
  };
}

export function makeServerSnapshot() {
  return {
    schemaVersion: 1,
    snapshotCursor: 12,
    capturedAt: '2030-01-02T00:00:01.000Z',
    workspace: {
      id: SERVER_IDS.workspace,
      name: '开发组',
      timezone: 'Asia/Shanghai',
      tree: { id: SERVER_IDS.tree, name: '开发任务树' },
    },
    workstreams: [{ id: SERVER_IDS.workstream, name: '桌面端', sortOrder: 0 }],
    members: [
      { id: SERVER_IDS.owner, displayName: '艾达', role: 'ADMIN' },
      { id: SERVER_IDS.collaborator, displayName: '图灵', role: 'MEMBER' },
    ],
    tasks: [makeServerTask()],
    dependencies: [],
  };
}

export function makeTaskStartedEvent() {
  return {
    schemaVersion: 1,
    eventId: SERVER_IDS.event,
    workspaceId: SERVER_IDS.workspace,
    workspaceSequence: 13,
    aggregateType: 'Task',
    aggregateId: SERVER_IDS.task,
    aggregateVersion: 4,
    actorType: 'human',
    actorId: SERVER_IDS.owner,
    occurredAt: '2030-01-02T00:00:02.000Z',
    commandId: SERVER_IDS.command,
    correlationId: SERVER_IDS.correlation,
    causationId: null,
    eventType: 'TaskStarted',
    payload: {
      previousStatus: 'TODO',
      currentStatus: 'IN_PROGRESS',
      previousOwnerId: null,
      currentOwnerId: SERVER_IDS.owner,
    },
  };
}
