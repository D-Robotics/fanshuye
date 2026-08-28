import { stableTaskCompare } from '../layout';
import {
  ACTION_LEVEL_LABELS,
  TASK_STATUS_LABELS,
  isDependencyBlocked,
  isTaskActive,
  isTaskOverdue,
  type TaskItem,
} from '../types';

export const TASK_PLANT_CAPACITY = 8;

export interface BinaryTaskLeafSlot {
  pair: 0 | 1 | 2 | 3;
  side: 'left' | 'right';
  outwardRank: 0 | 1 | 2 | 3;
  x: number;
  y: number;
  tilt: number;
}

export const BINARY_TASK_LEAF_SLOTS: readonly BinaryTaskLeafSlot[] = [
  { pair: 0, side: 'left', outwardRank: 0, x: 22, y: 116, tilt: -30 },
  { pair: 0, side: 'right', outwardRank: 0, x: 116, y: 112, tilt: 30 },
  { pair: 1, side: 'left', outwardRank: 1, x: 33, y: 66, tilt: -45 },
  { pair: 1, side: 'right', outwardRank: 1, x: 105, y: 62, tilt: 45 },
  { pair: 2, side: 'left', outwardRank: 2, x: 49, y: 4, tilt: -10 },
  { pair: 2, side: 'right', outwardRank: 2, x: 89, y: 4, tilt: 12 },
  { pair: 3, side: 'left', outwardRank: 3, x: 34, y: 37, tilt: -28 },
  { pair: 3, side: 'right', outwardRank: 3, x: 104, y: 35, tilt: 30 },
] as const;

export interface TaskPlantSelection {
  visible: TaskItem[];
  overflow: TaskItem[];
}

export function taskPlantCompare(left: TaskItem, right: TaskItem): number {
  const importanceDifference = right.importance - left.importance;
  return importanceDifference === 0 ? stableTaskCompare(left, right) : importanceDifference;
}

export function selectTaskPlantTasks(tasks: readonly TaskItem[]): TaskPlantSelection {
  const sorted = tasks.filter(isTaskActive).sort(taskPlantCompare);
  return {
    visible: sorted.slice(0, TASK_PLANT_CAPACITY),
    overflow: sorted.slice(TASK_PLANT_CAPACITY),
  };
}

export interface TaskPlantOverlayProps {
  tasks: readonly TaskItem[];
  selectedTaskId?: string | null;
  privacyMode?: boolean;
  reducedMotion?: boolean;
  onOpen: () => void;
  onSelectTask: (task: TaskItem) => void;
  onDragStart?: () => void;
}

function statusSymbol(task: TaskItem): string {
  if (task.ownerId === null) return '?';
  if (task.status === 'IN_PROGRESS') return '▶';
  if (task.status === 'IN_REVIEW') return '◇';
  return '○';
}

function displayLines(title: string): [string, string] {
  const compact = title.replaceAll(/\s+/g, '');
  if (compact.length <= 3) return [compact, ''];
  return [compact.slice(0, 3), `${compact.slice(3, 6)}${compact.length > 6 ? '…' : ''}`];
}

type VisibleRelation = 'prerequisite' | 'dependent' | null;

function visibleRelation(task: TaskItem, selected: TaskItem | undefined): VisibleRelation {
  if (selected === undefined || task.id === selected.id) return null;
  if (
    selected.prerequisites.some((relation) => relation.taskId === task.id) ||
    task.dependents.some((relation) => relation.taskId === selected.id)
  ) {
    return 'prerequisite';
  }
  if (
    selected.dependents.some((relation) => relation.taskId === task.id) ||
    task.prerequisites.some((relation) => relation.taskId === selected.id)
  ) {
    return 'dependent';
  }
  return null;
}

function taskLabel(
  task: TaskItem,
  privacyMode: boolean,
  slot: BinaryTaskLeafSlot,
  relation: VisibleRelation,
): string {
  const parts = [
    privacyMode ? '隐私任务' : task.title,
    `重要度 ${task.importance}`,
    `第 ${slot.pair + 1} 对${slot.side === 'left' ? '左' : '右'}叶`,
    ACTION_LEVEL_LABELS[task.actionLevel],
    TASK_STATUS_LABELS[task.status],
  ];
  if (task.ownerId === null) parts.push('无人认领');
  if (task.manualBlock !== null || isDependencyBlocked(task)) parts.push('阻塞');
  if (isTaskOverdue(task)) parts.push('已经逾期');
  if (relation === 'prerequisite') parts.push('当前任务的前置任务');
  if (relation === 'dependent') parts.push('当前任务的后续任务');
  return `${parts.join('，')}，点击展开`;
}

export function TaskPlantOverlay({
  tasks,
  selectedTaskId = null,
  privacyMode = false,
  reducedMotion = false,
  onOpen,
  onSelectTask,
  onDragStart,
}: TaskPlantOverlayProps) {
  const { visible, overflow } = selectTaskPlantTasks(tasks);
  const selectedTask = visible.find((task) => task.id === selectedTaskId);
  const selectedIndex = visible.findIndex((task) => task.id === selectedTaskId);
  const relationPaths =
    selectedIndex < 0
      ? []
      : visible.flatMap((task, index) => {
          const relation = visibleRelation(task, selectedTask);
          if (relation === null) return [];
          const start = BINARY_TASK_LEAF_SLOTS[selectedIndex]!;
          const end = BINARY_TASK_LEAF_SLOTS[index]!;
          const startX = start.x + 19;
          const startY = start.y + 48;
          const endX = end.x + 19;
          const endY = end.y + 48;
          const middleY = (startY + endY) / 2;
          return [
            {
              taskId: task.id,
              relation,
              path: `M${startX} ${startY} C${startX} ${middleY} ${endX} ${middleY} ${endX} ${endY}`,
            },
          ];
        });

  return (
    <section
      className={`fy-task-plant${reducedMotion ? ' fy-task-plant--reduced-motion' : ''}`}
      aria-label="常驻二叉任务树"
    >
      <div className="fy-task-plant__base" aria-hidden="true">
        <svg viewBox="0 0 176 216" aria-hidden="true">
          <defs>
            <linearGradient id="fy-binary-trunk" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" stopColor="#753016" />
              <stop offset="0.45" stopColor="#ad4818" />
              <stop offset="0.7" stopColor="#c55d22" />
              <stop offset="1" stopColor="#713015" />
            </linearGradient>
            <linearGradient id="fy-binary-root" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#d54b69" />
              <stop offset="1" stopColor="#7c2953" />
            </linearGradient>
          </defs>
          <ellipse cx="88" cy="202" rx="38" ry="7" fill="#173e2d" opacity="0.14" />
          <g
            className="fy-task-plant__branches"
            fill="none"
            stroke="url(#fy-binary-trunk)"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M88 194 C88 165 87 132 87 102 C88 76 87 52 89 29" strokeWidth="11" />
            <path d="M88 165 C70 157 55 154 41 160" strokeWidth="7" />
            <path d="M88 165 C106 155 121 151 135 156" strokeWidth="7" />
            <path d="M63 155 C53 143 51 124 52 112" strokeWidth="4.5" />
            <path d="M113 153 C123 139 125 120 124 108" strokeWidth="4.5" />
            <path d="M87 126 C75 111 63 94 53 84" strokeWidth="5.5" />
            <path d="M87 126 C100 109 113 94 123 82" strokeWidth="5.5" />
            <path d="M76 108 C73 86 70 66 68 50" strokeWidth="3.8" />
            <path d="M102 107 C105 87 107 67 108 50" strokeWidth="3.8" />
          </g>
          <g className="fy-task-plant__binary-nodes">
            <circle cx="88" cy="165" r="4" />
            <circle cx="63" cy="155" r="3" />
            <circle cx="113" cy="153" r="3" />
            <circle cx="87" cy="126" r="3.5" />
            <circle cx="76" cy="108" r="2.6" />
            <circle cx="102" cy="107" r="2.6" />
          </g>
          <g className="fy-task-plant__compact-roots">
            <path d="M79 185 C65 184 59 194 65 204 C71 214 83 207 88 197 C92 207 105 214 112 204 C119 194 111 184 97 185Z" />
            <path d="M74 192 C78 188 83 188 87 191 M98 191 C103 188 108 190 110 195" />
          </g>
        </svg>
        {visible.length === 0 && <span className="fy-task-plant__empty">暂无活跃任务</span>}
      </div>

      {relationPaths.length > 0 && (
        <svg className="fy-task-plant__relations" viewBox="0 0 176 216" aria-hidden="true">
          {relationPaths.map((relation) => (
            <path
              key={relation.taskId}
              className={`fy-task-plant__relation-line fy-task-plant__relation-line--${relation.relation}`}
              d={relation.path}
              data-related-task-id={relation.taskId}
              data-relation={relation.relation}
            />
          ))}
        </svg>
      )}

      {visible.map((task, index) => {
        const slot = BINARY_TASK_LEAF_SLOTS[index]!;
        const blocked = task.manualBlock !== null || isDependencyBlocked(task);
        const overdue = isTaskOverdue(task);
        const privateTitle = `任务${index + 1}`;
        const [firstLine, secondLine] = displayLines(privacyMode ? privateTitle : task.title);
        const selected = task.id === selectedTaskId;
        const relation = visibleRelation(task, selectedTask);
        return (
          <button
            key={task.id}
            className={`fy-task-plant__leaf fy-task-plant__leaf--${task.status.toLowerCase().replaceAll('_', '-')} fy-task-plant__leaf--importance-${task.importance}${blocked ? ' fy-task-plant__leaf--blocked' : ''}${overdue ? ' fy-task-plant__leaf--overdue' : ''}${task.ownerId === null ? ' fy-task-plant__leaf--unassigned' : ''}${selected ? ' fy-task-plant__leaf--selected' : ''}${relation === null ? '' : ` fy-task-plant__leaf--related fy-task-plant__leaf--related-${relation}`}`}
            style={{ left: slot.x, top: slot.y, transform: `rotate(${slot.tilt}deg)` }}
            type="button"
            aria-label={taskLabel(task, privacyMode, slot, relation)}
            aria-pressed={selected}
            data-task-id={task.id}
            data-task-status={task.status}
            data-pair={slot.pair}
            data-side={slot.side}
            data-outward-rank={slot.outwardRank}
            data-relation={selected ? 'selected' : (relation ?? 'none')}
            onClick={(event) => {
              event.stopPropagation();
              onSelectTask(task);
            }}
          >
            <svg viewBox="0 0 72 96" aria-hidden="true">
              <path
                className="fy-task-plant__leaf-shape"
                d="M36 92 C24 76 15 58 19 41 C23 24 33 12 43 4 C46 21 55 37 52 53 C49 70 42 84 36 92Z"
              />
              <path
                className="fy-task-plant__leaf-vein"
                d="M36 88 C36 68 37 43 42 12 M37 61 L25 48 M38 52 L49 36 M36 72 L27 62 M38 66 L47 55"
              />
              <text className="fy-task-plant__leaf-rank" x="36" y="32">
                {index + 1}
              </text>
              <text className="fy-task-plant__leaf-title" x="36" y={secondLine === '' ? 56 : 49}>
                {firstLine}
              </text>
              {secondLine !== '' && (
                <text className="fy-task-plant__leaf-title" x="36" y="61">
                  {secondLine}
                </text>
              )}
              <text className="fy-task-plant__leaf-status" x="36" y="78">
                {statusSymbol(task)}
              </text>
            </svg>
            {blocked && (
              <span
                className="fy-task-plant__badge fy-task-plant__badge--blocked"
                aria-hidden="true"
              >
                !
              </span>
            )}
            {overdue && (
              <span
                className="fy-task-plant__badge fy-task-plant__badge--overdue"
                aria-hidden="true"
              >
                时
              </span>
            )}
            {relation !== null && (
              <span
                className={`fy-task-plant__relation-badge fy-task-plant__relation-badge--${relation}`}
                aria-hidden="true"
              >
                {relation === 'prerequisite' ? '前' : '后'}
              </span>
            )}
          </button>
        );
      })}

      <button
        className="fy-task-plant__drag-handle"
        data-tauri-drag-region
        type="button"
        aria-label="拖动悬浮窗"
        onPointerDown={(event) => {
          if (event.button > 0) return;
          event.preventDefault();
          event.stopPropagation();
          onDragStart?.();
        }}
      ></button>

      {overflow.length > 0 && (
        <button
          className="fy-task-plant__overflow"
          type="button"
          aria-label={`另有 ${overflow.length} 个活跃任务，打开任务树`}
          onClick={onOpen}
        >
          +{overflow.length}
        </button>
      )}
    </section>
  );
}
