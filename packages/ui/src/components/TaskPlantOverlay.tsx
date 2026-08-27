import { selectVisibleTasks } from '../layout';
import {
  ACTION_LEVEL_LABELS,
  TASK_STATUS_LABELS,
  isDependencyBlocked,
  isTaskOverdue,
  type TaskItem,
} from '../types';

export const TASK_PLANT_CAPACITY = 5;

export interface TaskPlantSelection {
  visible: TaskItem[];
  overflow: TaskItem[];
}

export function selectTaskPlantTasks(tasks: readonly TaskItem[]): TaskPlantSelection {
  return selectVisibleTasks(tasks, TASK_PLANT_CAPACITY);
}

export interface TaskPlantOverlayProps {
  tasks: readonly TaskItem[];
  privacyMode?: boolean;
  reducedMotion?: boolean;
  onOpen: () => void;
  onSelectTask: (task: TaskItem) => void;
}

const slots = [
  { x: 65, y: 5, tilt: -2, tone: 'bright' },
  { x: 9, y: 49, tilt: -13, tone: 'deep' },
  { x: 120, y: 48, tilt: 13, tone: 'mid' },
  { x: 23, y: 100, tilt: -7, tone: 'mid' },
  { x: 111, y: 102, tilt: 8, tone: 'deep' },
] as const;

function statusSymbol(task: TaskItem): string {
  if (task.ownerId === null) return '?';
  if (task.status === 'IN_PROGRESS') return '▶';
  if (task.status === 'IN_REVIEW') return '◇';
  return '○';
}

function displayLines(title: string): [string, string] {
  const compact = title.replaceAll(/\s+/g, '');
  if (compact.length <= 5) return [compact, ''];
  return [compact.slice(0, 5), `${compact.slice(5, 9)}${compact.length > 9 ? '…' : ''}`];
}

function taskLabel(task: TaskItem, privacyMode: boolean): string {
  const parts = [
    privacyMode ? '隐私任务' : task.title,
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
}: TaskPlantOverlayProps) {
  const { visible, overflow } = selectTaskPlantTasks(tasks);

  return (
    <section
      className={`fy-task-plant${reducedMotion ? ' fy-task-plant--reduced-motion' : ''}`}
      aria-label="常驻任务番薯植株"
    >
      <button
        className="fy-task-plant__base"
        type="button"
        onClick={onOpen}
        aria-label="打开番薯叶任务树总览"
      >
        <svg viewBox="0 0 224 272" aria-hidden="true">
          <defs>
            <linearGradient id="fy-plant-stem" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#87bd54" />
              <stop offset="1" stopColor="#28653e" />
            </linearGradient>
            <linearGradient id="fy-tuber-main" x1="0.2" y1="0" x2="0.8" y2="1">
              <stop offset="0" stopColor="#ce365c" />
              <stop offset="0.52" stopColor="#9e2855" />
              <stop offset="1" stopColor="#66234a" />
            </linearGradient>
            <linearGradient id="fy-tuber-light" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#ef5570" />
              <stop offset="1" stopColor="#9e2855" />
            </linearGradient>
            <filter id="fy-plant-shadow" x="-30%" y="-30%" width="160%" height="180%">
              <feDropShadow
                dx="0"
                dy="8"
                stdDeviation="6"
                floodColor="#173e2d"
                floodOpacity="0.24"
              />
            </filter>
          </defs>
          <ellipse cx="113" cy="251" rx="69" ry="12" fill="#173e2d" opacity="0.16" />
          <g
            className="fy-task-plant__stems"
            fill="none"
            stroke="url(#fy-plant-stem)"
            strokeLinecap="round"
          >
            <path d="M105 212 C103 161 99 100 111 39" strokeWidth="8" />
            <path d="M99 213 C88 169 65 116 48 79" strokeWidth="6" />
            <path d="M112 215 C124 163 152 113 177 78" strokeWidth="7" />
            <path d="M104 214 C83 188 72 158 63 137" strokeWidth="5" />
            <path d="M113 214 C137 187 151 158 161 137" strokeWidth="5" />
          </g>
          <g className="fy-task-plant__back-leaves" opacity="0.9">
            <path d="M108 63 C89 46 92 23 109 11 C126 25 129 48 108 63Z" />
            <path d="M42 101 C24 97 14 83 17 66 C36 65 52 77 42 101Z" />
            <path d="M181 103 C203 98 211 82 207 65 C187 65 171 80 181 103Z" />
          </g>
          <g filter="url(#fy-plant-shadow)">
            <path
              className="fy-task-plant__root fy-task-plant__root--left"
              d="M88 205 C64 201 47 216 48 237 C49 254 70 264 83 249 C94 237 99 214 88 205Z"
            />
            <path
              className="fy-task-plant__root fy-task-plant__root--main"
              d="M108 198 C83 203 79 231 91 252 C102 272 127 264 137 245 C148 223 135 199 108 198Z"
            />
            <path
              className="fy-task-plant__root fy-task-plant__root--right"
              d="M138 207 C158 201 178 213 179 233 C180 250 164 262 150 250 C138 239 128 214 138 207Z"
            />
            <path
              className="fy-task-plant__root-shine"
              d="M103 211 C96 222 96 235 102 244 M145 217 C156 214 166 221 169 231 M60 218 C67 211 76 211 82 216"
            />
          </g>
        </svg>
        {visible.length === 0 && (
          <span className="fy-task-plant__empty">
            还没有任务叶
            <br />
            点击打开创建
          </span>
        )}
      </button>

      {visible.map((task, index) => {
        const slot = slots[index]!;
        const blocked = task.manualBlock !== null || isDependencyBlocked(task);
        const overdue = isTaskOverdue(task);
        const privateTitle = `任务 ${index + 1}`;
        const [firstLine, secondLine] = displayLines(privacyMode ? privateTitle : task.title);
        return (
          <button
            key={task.id}
            className={`fy-task-plant__leaf fy-task-plant__leaf--${slot.tone} fy-task-plant__leaf--${task.status.toLowerCase().replaceAll('_', '-')} fy-task-plant__leaf--importance-${task.importance}${blocked ? ' fy-task-plant__leaf--blocked' : ''}${overdue ? ' fy-task-plant__leaf--overdue' : ''}${task.ownerId === null ? ' fy-task-plant__leaf--unassigned' : ''}`}
            style={{ left: slot.x, top: slot.y, transform: `rotate(${slot.tilt}deg)` }}
            type="button"
            aria-label={taskLabel(task, privacyMode)}
            data-task-id={task.id}
            data-task-status={task.status}
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
              <text className="fy-task-plant__leaf-title" x="50" y={secondLine === '' ? 43 : 36}>
                {firstLine}
              </text>
              {secondLine !== '' && (
                <text className="fy-task-plant__leaf-title" x="50" y="50">
                  {secondLine}
                </text>
              )}
              <text className="fy-task-plant__leaf-status" x="50" y="66">
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
            {task.ownerId === null && (
              <span className="fy-task-plant__badge fy-task-plant__badge--owner" aria-hidden="true">
                待领
              </span>
            )}
          </button>
        );
      })}

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
        点击叶子直达任务
      </span>
    </section>
  );
}
