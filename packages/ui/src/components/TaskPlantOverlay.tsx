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
  { pair: 0, side: 'left', outwardRank: 0, x: 0, y: 118, tilt: -18 },
  { pair: 0, side: 'right', outwardRank: 0, x: 118, y: 114, tilt: 18 },
  { pair: 1, side: 'left', outwardRank: 1, x: 4, y: 66, tilt: -12 },
  { pair: 1, side: 'right', outwardRank: 1, x: 114, y: 62, tilt: 14 },
  { pair: 2, side: 'left', outwardRank: 2, x: 37, y: 3, tilt: -5 },
  { pair: 2, side: 'right', outwardRank: 2, x: 82, y: 2, tilt: 7 },
  { pair: 3, side: 'left', outwardRank: 3, x: 27, y: 36, tilt: -22 },
  { pair: 3, side: 'right', outwardRank: 3, x: 95, y: 34, tilt: 20 },
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

function taskLabel(task: TaskItem, privacyMode: boolean, slot: BinaryTaskLeafSlot): string {
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
  return `${parts.join('，')}，点击展开`;
}

export function TaskPlantOverlay({
  tasks,
  privacyMode = false,
  reducedMotion = false,
  onOpen,
  onSelectTask,
  onDragStart,
}: TaskPlantOverlayProps) {
  const { visible, overflow } = selectTaskPlantTasks(tasks);

  return (
    <section
      className={`fy-task-plant${reducedMotion ? ' fy-task-plant--reduced-motion' : ''}`}
      aria-label="常驻二叉任务树"
    >
      <button
        className="fy-task-plant__base"
        type="button"
        onClick={onOpen}
        aria-label="打开番薯叶任务树总览"
      >
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
            <path d="M88 165 C69 157 49 149 28 150" strokeWidth="7" />
            <path d="M88 165 C108 154 128 147 148 146" strokeWidth="7" />
            <path d="M63 155 C47 139 37 121 33 108" strokeWidth="4.5" />
            <path d="M113 153 C129 136 139 118 143 104" strokeWidth="4.5" />
            <path d="M87 126 C76 111 65 95 56 80" strokeWidth="5.5" />
            <path d="M87 126 C100 109 113 94 124 78" strokeWidth="5.5" />
            <path d="M76 108 C71 86 68 65 66 48" strokeWidth="3.8" />
            <path d="M102 107 C105 87 109 65 111 47" strokeWidth="3.8" />
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
        {visible.length === 0 && <span className="fy-task-plant__empty">点击创建第一片任务叶</span>}
      </button>

      {visible.map((task, index) => {
        const slot = BINARY_TASK_LEAF_SLOTS[index]!;
        const blocked = task.manualBlock !== null || isDependencyBlocked(task);
        const overdue = isTaskOverdue(task);
        const privateTitle = `任务${index + 1}`;
        const [firstLine, secondLine] = displayLines(privacyMode ? privateTitle : task.title);
        return (
          <button
            key={task.id}
            className={`fy-task-plant__leaf fy-task-plant__leaf--${task.status.toLowerCase().replaceAll('_', '-')} fy-task-plant__leaf--importance-${task.importance}${blocked ? ' fy-task-plant__leaf--blocked' : ''}${overdue ? ' fy-task-plant__leaf--overdue' : ''}${task.ownerId === null ? ' fy-task-plant__leaf--unassigned' : ''}`}
            style={{ left: slot.x, top: slot.y, transform: `rotate(${slot.tilt}deg)` }}
            type="button"
            aria-label={taskLabel(task, privacyMode, slot)}
            data-task-id={task.id}
            data-task-status={task.status}
            data-pair={slot.pair}
            data-side={slot.side}
            data-outward-rank={slot.outwardRank}
            onClick={(event) => {
              event.stopPropagation();
              onSelectTask(task);
            }}
          >
            <svg viewBox="0 0 100 82" aria-hidden="true">
              <path
                className="fy-task-plant__leaf-shape"
                d="M50 79 C42 63 7 60 5 29 C3 7 28 0 49 22 C69 0 96 7 95 30 C94 59 60 65 50 79Z"
              />
              <path
                className="fy-task-plant__leaf-vein"
                d="M50 72 L49 25 M49 44 L27 24 M49 52 L73 29 M48 59 L27 48 M51 62 L73 49"
              />
              <text className="fy-task-plant__leaf-rank" x="50" y="18">
                {index + 1}
              </text>
              <text className="fy-task-plant__leaf-title" x="50" y={secondLine === '' ? 43 : 35}>
                {firstLine}
              </text>
              {secondLine !== '' && (
                <text className="fy-task-plant__leaf-title" x="50" y="48">
                  {secondLine}
                </text>
              )}
              <text className="fy-task-plant__leaf-status" x="50" y="65">
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
      >
        <span aria-hidden="true">⠿</span>
      </button>

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
      <span className="fy-task-plant__hint" aria-hidden="true">
        按住主干移动
      </span>
    </section>
  );
}
