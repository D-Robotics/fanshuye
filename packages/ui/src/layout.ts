import {
  isDependencyBlocked,
  isTaskActive,
  isTaskOverdue,
  leafSizeForImportance,
  type ActionLevel,
  type LeafSize,
  type TaskItem,
} from './types';

export interface LeafPosition {
  task: TaskItem;
  x: number;
  y: number;
  rotation: number;
  side: 'left' | 'right';
  size: LeafSize;
}

export interface TaskTreeLayout {
  leaves: LeafPosition[];
  overflow: TaskItem[];
}

const levelRank: Record<ActionLevel, number> = { NOW: 0, NEXT: 1, LATER: 2 };

function anomalyRank(task: TaskItem): number {
  if (isTaskOverdue(task)) return 0;
  if (task.manualBlock !== null || isDependencyBlocked(task)) return 1;
  if (task.ownerId === null) return 2;
  return 3;
}

export function stableTaskCompare(left: TaskItem, right: TaskItem): number {
  const levelDifference = levelRank[left.actionLevel] - levelRank[right.actionLevel];
  if (levelDifference !== 0) return levelDifference;

  const anomalyDifference = anomalyRank(left) - anomalyRank(right);
  if (anomalyDifference !== 0) return anomalyDifference;

  const explicitOrder = left.stableOrder - right.stableOrder;
  if (explicitOrder !== 0) return explicitOrder;

  const leftDue = left.dueAt === null ? Number.POSITIVE_INFINITY : new Date(left.dueAt).getTime();
  const rightDue =
    right.dueAt === null ? Number.POSITIVE_INFINITY : new Date(right.dueAt).getTime();
  if (leftDue !== rightDue) return leftDue - rightDue;

  if (left.importance !== right.importance) return right.importance - left.importance;
  return left.id.localeCompare(right.id);
}

export function selectVisibleTasks(
  tasks: readonly TaskItem[],
  maximumVisible = 15,
): { visible: TaskItem[]; overflow: TaskItem[] } {
  const sorted = tasks.filter(isTaskActive).sort(stableTaskCompare);
  return {
    visible: sorted.slice(0, maximumVisible),
    overflow: sorted.slice(maximumVisible),
  };
}

const band: Record<ActionLevel, { top: number; bottom: number }> = {
  NOW: { top: 86, bottom: 220 },
  NEXT: { top: 246, bottom: 390 },
  LATER: { top: 414, bottom: 548 },
};

function positionsForBand(tasks: readonly TaskItem[], actionLevel: ActionLevel): LeafPosition[] {
  const limits = band[actionLevel];
  const count = tasks.length;
  if (count === 0) return [];

  return tasks.map((task, index) => {
    const side = index % 2 === 0 ? 'left' : 'right';
    const row = Math.floor(index / 2);
    const rows = Math.ceil(count / 2);
    const verticalStep = (limits.bottom - limits.top) / Math.max(rows, 1);
    const y = limits.top + verticalStep * (row + 0.48);
    const distance = 92 + (row % 3) * 37;
    const x = 380 + (side === 'left' ? -distance : distance);
    const rotation = side === 'left' ? -32 - (row % 2) * 7 : 32 + (row % 2) * 7;
    return {
      task,
      x,
      y,
      rotation,
      side,
      size: leafSizeForImportance(task.importance),
    };
  });
}

export function buildTaskTreeLayout(
  tasks: readonly TaskItem[],
  maximumVisible = 15,
): TaskTreeLayout {
  const { visible, overflow } = selectVisibleTasks(tasks, maximumVisible);
  const leaves = (['NOW', 'NEXT', 'LATER'] as const).flatMap((actionLevel) =>
    positionsForBand(
      visible.filter((task) => task.actionLevel === actionLevel),
      actionLevel,
    ),
  );
  return { leaves, overflow };
}
