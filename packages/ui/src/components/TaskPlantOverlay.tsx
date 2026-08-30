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
  { pair: 0, side: 'left', outwardRank: 0, x: 69, y: 0, tilt: -18 },
  { pair: 0, side: 'right', outwardRank: 0, x: 96, y: 2, tilt: 18 },
  { pair: 1, side: 'left', outwardRank: 1, x: 30, y: 48, tilt: -48 },
  { pair: 1, side: 'right', outwardRank: 1, x: 52, y: 59, tilt: -16 },
  { pair: 2, side: 'left', outwardRank: 2, x: 105, y: 56, tilt: 18 },
  { pair: 2, side: 'right', outwardRank: 2, x: 108, y: 77, tilt: 48 },
  { pair: 3, side: 'left', outwardRank: 3, x: 33, y: 101, tilt: -58 },
  { pair: 3, side: 'right', outwardRank: 3, x: 55, y: 88, tilt: -24 },
] as const;

const NATURAL_MAIN_STEM =
  'M91 190 C99 176 98 165 93 154 C88 143 86 132 89 118 C91 108 95 99 93 90 C90 78 86 70 91 61 C92 57 94 54 96 52';

const NATURAL_NEW_TASK_TWIG = 'M96 166 C105 164 114 168 123 174';

const NATURAL_TASK_BRANCHES = [
  {
    pair: 0,
    stem: 'M96 52 C95 52 94 52 93 51',
    left: 'M96 52 C93 48 90 47 88 48',
    right: 'M96 52 C102 47 109 47 115 50',
  },
  {
    pair: 1,
    stem: 'M90 111 C83 107 76 103 68 102',
    left: 'M68 102 C61 99 54 97 49 96',
    right: 'M68 102 C69 104 70 106 71 107',
  },
  {
    pair: 2,
    stem: 'M89 132 C98 125 107 118 116 116',
    left: 'M116 116 C119 111 122 106 124 104',
    right: 'M116 116 C121 119 125 123 127 125',
  },
  {
    pair: 3,
    stem: 'M93 154 C82 149 73 145 64 143',
    left: 'M64 143 C59 144 55 147 52 149',
    right: 'M64 143 C68 140 71 138 74 136',
  },
] as const;

export type TaskPlantRelationshipScorer = (left: TaskItem, candidate: TaskItem) => number;

export interface TaskPlantBranch {
  pair: 0 | 1 | 2 | 3;
  left: TaskItem;
  right: TaskItem | null;
  relationshipScore: number;
}

export interface TaskPlantSelection {
  branches: TaskPlantBranch[];
  visible: TaskItem[];
  overflow: TaskItem[];
}

export function taskPlantCompare(left: TaskItem, right: TaskItem): number {
  const importanceDifference = right.importance - left.importance;
  return importanceDifference === 0 ? stableTaskCompare(left, right) : importanceDifference;
}

function hasDirectTaskRelation(left: TaskItem, right: TaskItem): boolean {
  return (
    left.prerequisites.some((relation) => relation.taskId === right.id) ||
    left.dependents.some((relation) => relation.taskId === right.id) ||
    right.prerequisites.some((relation) => relation.taskId === left.id) ||
    right.dependents.some((relation) => relation.taskId === left.id)
  );
}

export function defaultTaskPlantRelationshipScore(left: TaskItem, candidate: TaskItem): number {
  if (hasDirectTaskRelation(left, candidate)) return 100;
  if (left.workstreamId === candidate.workstreamId) return 10;
  return 0;
}

export function selectTaskPlantTasks(
  tasks: readonly TaskItem[],
  relationshipScorer: TaskPlantRelationshipScorer = defaultTaskPlantRelationshipScore,
): TaskPlantSelection {
  const remaining = tasks.filter(isTaskActive).sort(taskPlantCompare);
  const branches: TaskPlantBranch[] = [];

  while (branches.length < 4 && remaining.length > 0) {
    const left = remaining.shift()!;
    let rightIndex = -1;
    let relationshipScore = 0;

    remaining.forEach((candidate, index) => {
      const score = relationshipScorer(left, candidate);
      if (score > relationshipScore) {
        rightIndex = index;
        relationshipScore = score;
      }
    });

    const right = rightIndex < 0 ? null : remaining.splice(rightIndex, 1)[0]!;
    branches.push({
      pair: branches.length as TaskPlantBranch['pair'],
      left,
      right,
      relationshipScore,
    });
  }

  return {
    branches,
    visible: branches.flatMap((branch) =>
      branch.right === null ? [branch.left] : [branch.left, branch.right],
    ),
    overflow: remaining,
  };
}

export interface TaskPlantOverlayProps {
  tasks: readonly TaskItem[];
  selectedTaskId?: string | null;
  privacyMode?: boolean;
  reducedMotion?: boolean;
  onSelectTask: (task: TaskItem) => void;
  onCreateTask: () => void;
  createTaskDisabled?: boolean;
  draggable?: boolean;
  showTaskLabels?: boolean;
  onDragStart?: () => void;
  relationshipScorer?: TaskPlantRelationshipScorer;
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
  onSelectTask,
  onCreateTask,
  createTaskDisabled = false,
  draggable = true,
  showTaskLabels = false,
  onDragStart,
  relationshipScorer,
}: TaskPlantOverlayProps) {
  const { branches, visible } = selectTaskPlantTasks(tasks, relationshipScorer);
  const placedTasks = branches.flatMap((branch) => {
    const leftSlot = BINARY_TASK_LEAF_SLOTS.find(
      (slot) => slot.pair === branch.pair && slot.side === 'left',
    )!;
    const rightSlot = BINARY_TASK_LEAF_SLOTS.find(
      (slot) => slot.pair === branch.pair && slot.side === 'right',
    )!;
    return branch.right === null
      ? [{ task: branch.left, slot: leftSlot }]
      : [
          { task: branch.left, slot: leftSlot },
          { task: branch.right, slot: rightSlot },
        ];
  });
  const selectedTask = visible.find((task) => task.id === selectedTaskId);
  const selectedPlacement = placedTasks.find(({ task }) => task.id === selectedTaskId);
  const relationPaths =
    selectedPlacement === undefined
      ? []
      : placedTasks.flatMap(({ task, slot }) => {
          const relation = visibleRelation(task, selectedTask);
          if (relation === null) return [];
          const start = selectedPlacement.slot;
          const end = slot;
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
      className={`fy-task-plant${showTaskLabels ? ' fy-task-plant--labeled' : ''}${reducedMotion ? ' fy-task-plant--reduced-motion' : ''}`}
      aria-label="常驻二叉任务树"
    >
      <div className="fy-task-plant__base" aria-hidden="true">
        <svg viewBox="0 0 176 216" aria-hidden="true">
          <defs>
            <linearGradient id="fy-binary-trunk" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" stopColor="#684536" />
              <stop offset="0.48" stopColor="#8b5a3e" />
              <stop offset="0.76" stopColor="#996647" />
              <stop offset="1" stopColor="#624133" />
            </linearGradient>
            <linearGradient id="fy-binary-root" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#bd6178" />
              <stop offset="1" stopColor="#84425f" />
            </linearGradient>
          </defs>
          <ellipse cx="62" cy="208" rx="38" ry="7" fill="#173e2d" opacity="0.14" />
          <g
            className="fy-task-plant__branches"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <g className="fy-task-plant__branch-outline" stroke="#612812">
              <path d={NATURAL_MAIN_STEM} strokeWidth="7.2" />
              {branches.map((branch) => {
                const geometry = NATURAL_TASK_BRANCHES[branch.pair];
                return (
                  <g key={branch.pair}>
                    <path d={geometry.stem} strokeWidth="4.4" strokeLinecap="butt" />
                    <path d={geometry.left} strokeWidth="3" />
                    {branch.right !== null && <path d={geometry.right} strokeWidth="3" />}
                  </g>
                );
              })}
              <path d={NATURAL_NEW_TASK_TWIG} strokeWidth="3" data-new-task-twig="outline" />
            </g>
            <g className="fy-task-plant__branch-fill" stroke="url(#fy-binary-trunk)">
              <path data-natural-stem="fluid-s-curve" d={NATURAL_MAIN_STEM} strokeWidth="5.8" />
              {branches.map((branch) => {
                const geometry = NATURAL_TASK_BRANCHES[branch.pair];
                return (
                  <g key={branch.pair} data-natural-branch={branch.pair}>
                    <path
                      d={geometry.stem}
                      strokeWidth="3.6"
                      strokeLinecap="butt"
                      data-branch-segment="stem"
                    />
                    <path d={geometry.left} strokeWidth="2.2" data-child-side="left" />
                    {branch.right !== null && (
                      <path d={geometry.right} strokeWidth="2.2" data-child-side="right" />
                    )}
                  </g>
                );
              })}
              <path d={NATURAL_NEW_TASK_TWIG} strokeWidth="2.2" data-new-task-twig="fill" />
            </g>
          </g>
          <g className="fy-task-plant__compact-roots">
            <path
              className="fy-task-plant__root-fibers"
              d="M91 183 C88 188 86 191 83 194 M95 184 C98 187 100 189 102 192"
            />
            <path
              className="fy-task-plant__tuber"
              data-root-shape="natural-tuber"
              d="M32 209 C29 198 36 185 49 178 C62 171 78 174 87 183 C95 191 92 202 82 209 C70 216 52 216 40 213 C35 212 32 211 32 209Z"
            />
            <path className="fy-task-plant__tuber-highlight" d="M40 201 C45 190 54 183 63 181" />
            <path
              className="fy-task-plant__tuber-texture"
              d="M65 210 C72 207 77 203 80 198 M47 181 C51 186 52 191 52 196"
            />
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

      <button
        className="fy-task-plant__new-bud"
        type="button"
        aria-label="新增任务，让任务树长出新叶"
        data-new-task-bud
        disabled={createTaskDisabled}
        onClick={(event) => {
          event.stopPropagation();
          onCreateTask();
        }}
      >
        <svg viewBox="0 0 60 84" aria-hidden="true">
          <path
            className="fy-task-plant__new-bud-shape"
            d="M29 79 C19 66 12 51 16 37 C20 23 29 13 39 6 C40 21 47 34 44 47 C41 61 35 72 29 79Z"
          />
          <path
            className="fy-task-plant__new-bud-vein"
            d="M29 75 C29 59 31 38 38 12 M30 52 L21 43 M32 42 L41 31 M29 62 L23 56"
          />
          <text className="fy-task-plant__new-bud-plus" x="31" y="51" transform="rotate(-32 31 51)">
            +
          </text>
        </svg>
      </button>

      {placedTasks.map(({ task, slot }, index) => {
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

      {draggable && (
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
      )}
    </section>
  );
}
