import { useId, useMemo, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { buildTaskTreeLayout, type LeafPosition } from '../layout';
import {
  ACTION_LEVEL_LABELS,
  TASK_STATUS_LABELS,
  isDependencyBlocked,
  isTaskOverdue,
  type TaskItem,
} from '../types';

export interface TaskTreeProps {
  tasks: readonly TaskItem[];
  selectedTaskId?: string;
  maximumVisible?: number;
  privacyMode?: boolean;
  reducedMotion?: boolean;
  onlyMyTaskIds?: ReadonlySet<string>;
  onSelectTask?: (task: TaskItem) => void;
  onClusterClick?: (tasks: TaskItem[]) => void;
  onHoverTask?: (task: TaskItem | null) => void;
}

const leafDimensions = {
  small: { width: 28, height: 17 },
  medium: { width: 38, height: 23 },
  large: { width: 49, height: 29 },
} as const;

function statusSymbol(task: TaskItem): string {
  if (task.ownerId === null) return '?';
  if (task.status === 'IN_PROGRESS') return '▶';
  if (task.status === 'IN_REVIEW') return '◇';
  return '·';
}

function leafAriaLabel(task: TaskItem, privacyMode: boolean): string {
  const labels = [
    privacyMode ? '隐私任务' : task.title,
    ACTION_LEVEL_LABELS[task.actionLevel],
    TASK_STATUS_LABELS[task.status],
    `重要度 ${task.importance}`,
  ];
  if (task.ownerId === null) labels.push('无人认领');
  if (task.manualBlock !== null) labels.push('人工阻塞');
  if (isDependencyBlocked(task)) labels.push('依赖阻塞');
  if (isTaskOverdue(task)) labels.push('已经逾期');
  return labels.join('，');
}

interface LeafProps {
  position: LeafPosition;
  privacyMode: boolean;
  selected: boolean;
  dimmed: boolean;
  onActivate: (task: TaskItem) => void;
  onHover: (position: LeafPosition | null) => void;
}

function TaskLeaf({ position, privacyMode, selected, dimmed, onActivate, onHover }: LeafProps) {
  const { task, x, y, rotation, size } = position;
  const dimensions = leafDimensions[size];
  const dependencyBlocked = isDependencyBlocked(task);
  const overdue = isTaskOverdue(task);
  const blocked = task.manualBlock !== null || dependencyBlocked;
  const classNames = [
    'fy-task-leaf',
    `fy-task-leaf--${task.status.toLowerCase().replaceAll('_', '-')}`,
    `fy-task-leaf--${size}`,
    task.ownerId === null ? 'fy-task-leaf--unassigned' : '',
    task.manualBlock !== null ? 'fy-task-leaf--manual-blocked' : '',
    dependencyBlocked ? 'fy-task-leaf--dependency-blocked' : '',
    overdue ? 'fy-task-leaf--overdue' : '',
    selected ? 'fy-task-leaf--selected' : '',
    dimmed ? 'fy-task-leaf--dimmed' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const activate = () => onActivate(task);
  const handleKeyDown = (event: KeyboardEvent<SVGGElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      activate();
    }
    if (event.key === 'Escape') onHover(null);
  };

  return (
    <g
      className={classNames}
      role="button"
      tabIndex={0}
      aria-label={leafAriaLabel(task, privacyMode)}
      aria-pressed={selected}
      data-task-id={task.id}
      data-leaf-size={size}
      data-task-status={task.status}
      data-x={x}
      data-y={y}
      transform={`translate(${x} ${y}) rotate(${rotation})`}
      onClick={activate}
      onKeyDown={handleKeyDown}
      onMouseEnter={() => onHover(position)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(position)}
      onBlur={() => onHover(null)}
    >
      <title>{leafAriaLabel(task, privacyMode)}</title>
      <path
        className="fy-task-leaf__body"
        d={`M ${-dimensions.width / 2} 0 C ${-dimensions.width / 3} ${-dimensions.height}, ${dimensions.width / 3} ${-dimensions.height}, ${
          dimensions.width / 2
        } 0 C ${dimensions.width / 3} ${dimensions.height}, ${
          -dimensions.width / 3
        } ${dimensions.height}, ${-dimensions.width / 2} 0 Z`}
      />
      <path
        className="fy-task-leaf__vein"
        d={`M ${-dimensions.width / 2 + 4} 0 H ${dimensions.width / 2 - 4}`}
      />
      <path
        className="fy-task-leaf__vein fy-task-leaf__vein--secondary"
        d={`M ${-dimensions.width * 0.2} 0 L ${-dimensions.width * 0.04} ${-dimensions.height * 0.45} M ${dimensions.width * 0.04} 0 L ${dimensions.width * 0.2} ${dimensions.height * 0.42}`}
      />
      <text className="fy-task-leaf__status" x="0" y="4" aria-hidden="true">
        {statusSymbol(task)}
      </text>
      {blocked && (
        <g className="fy-task-leaf__badge fy-task-leaf__badge--blocked" aria-hidden="true">
          <circle cx={dimensions.width / 2 - 2} cy={-dimensions.height / 2} r="7" />
          <text x={dimensions.width / 2 - 2} y={-dimensions.height / 2 + 3}>
            {dependencyBlocked ? '↥' : '!'}
          </text>
        </g>
      )}
      {overdue && (
        <g className="fy-task-leaf__badge fy-task-leaf__badge--overdue" aria-hidden="true">
          <rect
            x={-dimensions.width / 2 - 5}
            y={-dimensions.height / 2 - 7}
            width="13"
            height="13"
            rx="3"
          />
          <text x={-dimensions.width / 2 + 1.5} y={-dimensions.height / 2 + 3}>
            !
          </text>
        </g>
      )}
    </g>
  );
}

interface TaskHoverCardProps {
  position: LeafPosition;
  privacyMode: boolean;
}

function TaskHoverCard({ position, privacyMode }: TaskHoverCardProps) {
  const task = position.task;
  const placeBelow = position.y < 205;
  const formattedDue =
    task.dueAt === null
      ? '未设置'
      : new Intl.DateTimeFormat('zh-CN', {
          month: 'numeric',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        }).format(new Date(task.dueAt));
  const style = {
    '--fy-card-x': `${Math.min(80, Math.max(20, (position.x / 760) * 100))}%`,
    '--fy-card-y': `${Math.min(78, Math.max(14, (position.y / 610) * 100))}%`,
  } as React.CSSProperties;

  return (
    <aside
      className={`fy-task-hover-card${placeBelow ? ' fy-task-hover-card--below' : ''}`}
      role="tooltip"
      style={style}
    >
      <span className="fy-task-hover-card__level">
        {ACTION_LEVEL_LABELS[task.actionLevel]} · 重要度 {task.importance}
      </span>
      <strong>{privacyMode ? '任务标题已隐藏' : task.title}</strong>
      {privacyMode ? (
        <p>隐私模式已隐藏人员和内容信息</p>
      ) : (
        <dl>
          <div>
            <dt>负责人</dt>
            <dd>{task.ownerName ?? '无人认领'}</dd>
          </div>
          <div>
            <dt>协作人</dt>
            <dd>{task.collaboratorNames.join('、') || '无'}</dd>
          </div>
          <div>
            <dt>状态</dt>
            <dd>{TASK_STATUS_LABELS[task.status]}</dd>
          </div>
          <div>
            <dt>截止</dt>
            <dd>{formattedDue}</dd>
          </div>
        </dl>
      )}
      <p className="fy-task-hover-card__reason">{task.actionReason}</p>
    </aside>
  );
}

export function TaskTree({
  tasks,
  selectedTaskId,
  maximumVisible = 15,
  privacyMode = false,
  reducedMotion = false,
  onlyMyTaskIds,
  onSelectTask,
  onClusterClick,
  onHoverTask,
}: TaskTreeProps) {
  const markerId = `fy-arrow-${useId().replaceAll(':', '')}`;
  const [hovered, setHovered] = useState<LeafPosition | null>(null);
  const layout = useMemo(() => buildTaskTreeLayout(tasks, maximumVisible), [maximumVisible, tasks]);
  const positionById = useMemo(
    () => new Map(layout.leaves.map((leaf) => [leaf.task.id, leaf])),
    [layout.leaves],
  );
  const selected =
    selectedTaskId === undefined
      ? undefined
      : layout.leaves.find((leaf) => leaf.task.id === selectedTaskId);
  const levelCounts = useMemo(() => {
    const activeTasks = [...layout.leaves.map((leaf) => leaf.task), ...layout.overflow];
    return {
      NOW: activeTasks.filter((task) => task.actionLevel === 'NOW').length,
      NEXT: activeTasks.filter((task) => task.actionLevel === 'NEXT').length,
      LATER: activeTasks.filter((task) => task.actionLevel === 'LATER').length,
    };
  }, [layout]);

  const dependencyLines = useMemo(() => {
    if (selected === undefined) return [];
    const lines: Array<{ from: LeafPosition; to: LeafPosition; id: string }> = [];
    for (const relation of selected.task.prerequisites) {
      const prerequisite = positionById.get(relation.taskId);
      if (prerequisite !== undefined) {
        lines.push({ from: prerequisite, to: selected, id: `pre-${relation.taskId}` });
      }
    }
    for (const relation of selected.task.dependents) {
      const dependent = positionById.get(relation.taskId);
      if (dependent !== undefined) {
        lines.push({ from: selected, to: dependent, id: `dep-${relation.taskId}` });
      }
    }
    return lines;
  }, [positionById, selected]);

  const activate = (task: TaskItem) => onSelectTask?.(task);
  const hover = (position: LeafPosition | null) => {
    setHovered(position);
    onHoverTask?.(position?.task ?? null);
  };
  const activateCluster = (event: MouseEvent<SVGGElement> | KeyboardEvent<SVGGElement>) => {
    event.stopPropagation();
    onClusterClick?.(layout.overflow);
  };

  return (
    <section
      className={`fy-task-tree${reducedMotion ? ' fy-reduced-motion' : ''}`}
      aria-label="团队任务树"
    >
      <svg viewBox="0 0 760 610" role="tree" aria-label="番薯叶活跃任务树">
        <defs>
          <linearGradient id={`${markerId}-trunk`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="var(--fy-trunk-light)" />
            <stop offset="1" stopColor="var(--fy-trunk-dark)" />
          </linearGradient>
          <marker
            id={markerId}
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="5"
            markerHeight="5"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" />
          </marker>
        </defs>

        <g className="fy-task-tree__zones" aria-hidden="true">
          <rect
            className="fy-task-tree__zone fy-task-tree__zone--now"
            x="24"
            y="28"
            width="712"
            height="194"
            rx="28"
          />
          <rect
            className="fy-task-tree__zone fy-task-tree__zone--next"
            x="24"
            y="230"
            width="712"
            height="166"
            rx="28"
          />
          <rect
            className="fy-task-tree__zone fy-task-tree__zone--later"
            x="24"
            y="404"
            width="712"
            height="166"
            rx="28"
          />
          <g className="fy-task-tree__zone-label fy-task-tree__zone-label--now">
            <circle cx="51" cy="58" r="5" />
            <text x="65" y="62">
              立即处理
            </text>
            <text className="fy-task-tree__zone-count" x="129" y="62">
              {levelCounts.NOW} 项
            </text>
          </g>
          <g className="fy-task-tree__zone-label fy-task-tree__zone-label--next">
            <circle cx="51" cy="260" r="5" />
            <text x="65" y="264">
              接下来
            </text>
            <text className="fy-task-tree__zone-count" x="116" y="264">
              {levelCounts.NEXT} 项
            </text>
          </g>
          <g className="fy-task-tree__zone-label fy-task-tree__zone-label--later">
            <circle cx="51" cy="434" r="5" />
            <text x="65" y="438">
              稍后
            </text>
            <text className="fy-task-tree__zone-count" x="103" y="438">
              {levelCounts.LATER} 项
            </text>
          </g>
        </g>

        <g className="fy-task-tree__plant" aria-hidden="true">
          <ellipse className="fy-task-tree__soil" cx="386" cy="574" rx="112" ry="18" />
          <path className="fy-task-tree__trunk-shadow" d="M 393 574 C 368 430 393 270 377 74" />
          <path
            className="fy-task-tree__trunk"
            stroke={`url(#${markerId}-trunk)`}
            d="M 386 574 C 362 430 391 270 377 74"
          />
          {layout.leaves.map((leaf) => (
            <path
              key={`branch-${leaf.task.id}`}
              className="fy-task-tree__branch"
              d={`M 382 ${leaf.y + 16} Q ${(382 + leaf.x) / 2} ${leaf.y - 10} ${leaf.x} ${leaf.y}`}
            />
          ))}
          <path className="fy-task-tree__root" d="M 386 565 Q 340 584 306 574" />
          <path className="fy-task-tree__root" d="M 388 565 Q 426 590 466 573" />
          <path className="fy-task-tree__root" d="M 386 566 Q 374 593 360 600" />
          <path
            className="fy-task-tree__sprout"
            d="M 378 86 C 355 79 349 59 352 47 C 371 51 382 65 378 86 Z"
          />
          <path
            className="fy-task-tree__sprout"
            d="M 378 76 C 386 53 405 45 418 49 C 414 68 399 80 378 76 Z"
          />
        </g>

        <g className="fy-task-tree__dependencies" aria-label="当前任务的直接依赖">
          {dependencyLines.map((line) => (
            <line
              key={line.id}
              x1={line.from.x}
              y1={line.from.y}
              x2={line.to.x}
              y2={line.to.y}
              markerEnd={`url(#${markerId})`}
            />
          ))}
        </g>

        <g role="group" aria-label="活跃任务叶片">
          {layout.leaves.map((position) => (
            <TaskLeaf
              key={position.task.id}
              position={position}
              privacyMode={privacyMode}
              selected={position.task.id === selectedTaskId}
              dimmed={onlyMyTaskIds !== undefined && !onlyMyTaskIds.has(position.task.id)}
              onActivate={activate}
              onHover={hover}
            />
          ))}
        </g>

        {layout.overflow.length > 0 && (
          <g
            className="fy-task-cluster"
            role="button"
            tabIndex={0}
            aria-label={`另有 ${layout.overflow.length} 个活跃任务，打开列表`}
            transform="translate(582 570)"
            onClick={activateCluster}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') activateCluster(event);
            }}
          >
            <path d="M -39 0 C -27 -29 27 -29 39 0 C 27 29 -27 29 -39 0 Z" />
            <text x="0" y="6">
              +{layout.overflow.length}
            </text>
          </g>
        )}
      </svg>
      {hovered !== null && <TaskHoverCard position={hovered} privacyMode={privacyMode} />}
      {layout.leaves.length === 0 && (
        <div className="fy-task-tree__empty">
          <span aria-hidden="true">⌁</span>
          <strong>树上暂时没有活跃任务</strong>
          <p>新任务创建后，会从枝干上长出一片叶子。</p>
        </div>
      )}
    </section>
  );
}
