import type { TaskItem } from '@fanshuye/ui';

export function makeTask(overrides: Partial<TaskItem> = {}): TaskItem {
  return {
    id: 'task-a',
    title: '实现同步控制器',
    description: '处理快照与增量事件。',
    definitionOfDone: '缺口恢复测试通过。',
    status: 'IN_PROGRESS',
    actionLevel: 'NOW',
    actionReason: '阻塞发布流程',
    importance: 5,
    workstreamId: 'desktop',
    workstreamName: '桌面端',
    ownerId: 'me',
    ownerName: '我',
    collaboratorIds: [],
    collaboratorNames: [],
    dueAt: null,
    manualBlock: null,
    prerequisites: [],
    incompletePrerequisites: [],
    dependents: [],
    externalReferences: [],
    timeline: [],
    version: 1,
    stableOrder: 1,
    updatedAt: '2030-01-01T00:00:00.000Z',
    archivedAt: null,
    ...overrides,
  };
}
