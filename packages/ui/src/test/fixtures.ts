import type { TaskItem } from '../types';

export function makeTask(overrides: Partial<TaskItem> = {}): TaskItem {
  return {
    id: 'task-001',
    title: '修复登录超时问题',
    description: '处理刷新令牌竞争导致的偶发超时。',
    definitionOfDone: '自动化测试通过，评审确认。',
    status: 'IN_PROGRESS',
    actionLevel: 'NOW',
    actionReason: '距离截止时间不足 24 小时',
    importance: 4,
    workstreamId: 'platform',
    workstreamName: '平台工程',
    ownerId: 'member-ada',
    ownerName: '艾达',
    collaboratorIds: ['member-lin'],
    collaboratorNames: ['林工'],
    dueAt: '2030-09-01T09:00:00.000Z',
    manualBlock: null,
    prerequisites: [],
    incompletePrerequisites: [],
    dependents: [],
    externalReferences: [],
    timeline: [],
    version: 3,
    stableOrder: 10,
    updatedAt: '2030-08-30T06:00:00.000Z',
    archivedAt: null,
    ...overrides,
  };
}
