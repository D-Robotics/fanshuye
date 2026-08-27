import { isDependencyBlocked, isTaskActive, selectVisibleTasks, type TaskItem } from '@fanshuye/ui';
import { createDemoTasks } from './demo-data';

export const USABILITY_STUDY_DATASET_ID = 'fanshuye-developer-30-v1';
export const USABILITY_STUDY_TIME_LIMIT_MS = 5_000;
export const USABILITY_STUDY_MAXIMUM_VISIBLE = 15;

export const USABILITY_STUDY_TARGETS = {
  highestAction: 'task-01',
  unassigned: 'task-05',
  blocked: 'task-04',
  ownerHover: 'task-01',
} as const;

const fixedReferenceTime = new Date('2030-01-15T08:00:00.000Z');

export function createUsabilityStudyTasks(): TaskItem[] {
  return createDemoTasks(fixedReferenceTime).map((task) => ({
    ...task,
    // Due dates are deliberately removed from this perception study. Otherwise
    // crossing the fixed reference date would change anomaly sorting and leaf slots.
    dueAt: null,
  }));
}

export function validateUsabilityStudyDataset(tasks: readonly TaskItem[]): string[] {
  const problems: string[] = [];
  const active = tasks.filter(isTaskActive);
  const { visible, overflow } = selectVisibleTasks(tasks, USABILITY_STUDY_MAXIMUM_VISIBLE);
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visibleIds = new Set(visible.map((task) => task.id));

  if (tasks.length !== 30) problems.push(`expected 30 total tasks, received ${tasks.length}`);
  if (active.length !== 26) problems.push(`expected 26 active tasks, received ${active.length}`);
  if (visible.length !== 15) {
    problems.push(`expected 15 directly visible leaves, received ${visible.length}`);
  }
  if (overflow.length !== 11) {
    problems.push(`expected an 11-task overflow cluster, received ${overflow.length}`);
  }
  if (new Set(tasks.map((task) => task.id)).size !== tasks.length) {
    problems.push('task ids must be unique');
  }
  if (new Set(tasks.map((task) => task.title)).size !== tasks.length) {
    problems.push('task titles must be unique');
  }

  validateTarget(
    'highest action',
    USABILITY_STUDY_TARGETS.highestAction,
    (task) => task.actionLevel === 'NOW',
  );
  validateTarget(
    'unassigned',
    USABILITY_STUDY_TARGETS.unassigned,
    (task) => task.ownerId === null && task.ownerName === null,
  );
  validateTarget(
    'blocked',
    USABILITY_STUDY_TARGETS.blocked,
    (task) => task.manualBlock !== null || isDependencyBlocked(task),
  );
  validateTarget(
    'owner hover',
    USABILITY_STUDY_TARGETS.ownerHover,
    (task) => task.ownerId !== null && task.ownerName !== null && task.ownerName.length > 0,
  );

  const actionCounts = active.reduce<Record<TaskItem['actionLevel'], number>>(
    (counts, task) => ({ ...counts, [task.actionLevel]: counts[task.actionLevel] + 1 }),
    { NOW: 0, NEXT: 0, LATER: 0 },
  );
  if (actionCounts.NOW !== 6 || actionCounts.NEXT !== 10 || actionCounts.LATER !== 10) {
    problems.push(`unexpected action-level distribution: ${JSON.stringify(actionCounts)}`);
  }

  return problems;

  function validateTarget(
    label: string,
    taskId: string,
    predicate: (task: TaskItem) => boolean,
  ): void {
    const task = byId.get(taskId);
    if (task === undefined) {
      problems.push(`${label} target ${taskId} is missing`);
      return;
    }
    if (!isTaskActive(task)) problems.push(`${label} target ${taskId} is not active`);
    if (!visibleIds.has(taskId)) problems.push(`${label} target ${taskId} is not directly visible`);
    if (!predicate(task)) problems.push(`${label} target ${taskId} lacks the required semantics`);
  }
}
