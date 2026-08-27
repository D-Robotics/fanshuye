export type TaskStatus = 'TODO' | 'IN_PROGRESS' | 'IN_REVIEW' | 'DONE' | 'CANCELED';
export type ActionLevel = 'NOW' | 'NEXT' | 'LATER';
export type LeafSize = 'small' | 'medium' | 'large';
export type SyncStatus = 'online' | 'reconnecting' | 'offline' | 'recovering' | 'conflict';

export interface MemberSummary {
  id: string;
  displayName: string;
}

export interface TaskRelationSummary {
  taskId: string;
  title: string;
  status: TaskStatus;
}

export interface TaskTimelineEntry {
  id: string;
  text: string;
  actorName: string;
  occurredAt: string;
}

export interface TaskExternalReference {
  id: string;
  label: string;
  type: 'repository' | 'issue' | 'pull-request' | 'document' | 'other';
  url: string;
}

export interface ManualBlock {
  type: 'technical' | 'decision' | 'resource' | 'external' | 'other';
  reason: string;
}

export interface TaskItem {
  id: string;
  title: string;
  description: string;
  definitionOfDone: string;
  status: TaskStatus;
  actionLevel: ActionLevel;
  actionReason: string;
  importance: 1 | 2 | 3 | 4 | 5;
  workstreamId: string;
  workstreamName: string;
  ownerId: string | null;
  ownerName: string | null;
  collaboratorIds: string[];
  collaboratorNames: string[];
  dueAt: string | null;
  manualBlock: ManualBlock | null;
  prerequisites: TaskRelationSummary[];
  incompletePrerequisites: TaskRelationSummary[];
  dependents: TaskRelationSummary[];
  externalReferences: TaskExternalReference[];
  timeline: TaskTimelineEntry[];
  version: number;
  stableOrder: number;
  updatedAt: string;
  archivedAt: string | null;
}

export interface TaskDraft {
  title: string;
  description: string;
  definitionOfDone: string;
  importance: TaskItem['importance'];
  dueAt: string | null;
  ownerId: string | null;
  collaboratorIds: string[];
  prerequisiteTaskIds: string[];
  workstreamId: string;
}

export type TaskCommandName =
  | 'claim-and-start'
  | 'start'
  | 'join'
  | 'request-transfer'
  | 'pause'
  | 'release'
  | 'transfer'
  | 'block'
  | 'unblock'
  | 'request-review'
  | 'request-changes'
  | 'complete'
  | 'cancel'
  | 'reopen';

export interface TaskCommandRequest {
  name: TaskCommandName;
  taskId: string;
  expectedVersion: number;
  payload?: Record<string, unknown>;
}

export interface SyncViewState {
  status: SyncStatus;
  lastSyncedAt: string | null;
  message?: string;
}

export const ACTIVE_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'TODO',
  'IN_PROGRESS',
  'IN_REVIEW',
]);

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  TODO: '待处理',
  IN_PROGRESS: '进行中',
  IN_REVIEW: '待评审',
  DONE: '已完成',
  CANCELED: '已取消',
};

export const ACTION_LEVEL_LABELS: Record<ActionLevel, string> = {
  NOW: '立即处理',
  NEXT: '接下来',
  LATER: '稍后',
};

export function leafSizeForImportance(importance: TaskItem['importance']): LeafSize {
  if (importance <= 2) return 'small';
  if (importance === 3) return 'medium';
  return 'large';
}

export function isTaskActive(task: TaskItem): boolean {
  return ACTIVE_STATUSES.has(task.status) && task.archivedAt === null;
}

export function isTaskOverdue(task: TaskItem, now = Date.now()): boolean {
  if (task.dueAt === null || !isTaskActive(task)) return false;
  return new Date(task.dueAt).getTime() < now;
}

export function isDependencyBlocked(task: TaskItem): boolean {
  return task.incompletePrerequisites.length > 0;
}
