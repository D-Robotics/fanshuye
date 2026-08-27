import { useMemo, useState } from 'react';
import {
  ACTION_LEVEL_LABELS,
  TASK_STATUS_LABELS,
  isTaskActive,
  type TaskItem,
  type TaskStatus,
} from '../types';

export interface TaskListProps {
  tasks: readonly TaskItem[];
  currentMemberId: string;
  privacyMode?: boolean;
  initialTaskIds?: ReadonlySet<string>;
  onSelectTask?: (task: TaskItem) => void;
}

export function TaskList(props: TaskListProps) {
  const privacyMode = props.privacyMode ?? false;
  return (
    <TaskListView
      key={privacyMode ? 'privacy-mode' : 'standard-mode'}
      {...props}
      privacyMode={privacyMode}
    />
  );
}

function TaskListView({
  tasks,
  currentMemberId,
  privacyMode,
  initialTaskIds,
  onSelectTask,
}: TaskListProps & { privacyMode: boolean }) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<TaskStatus | 'ALL'>('ALL');
  const [workstream, setWorkstream] = useState('ALL');
  const [owner, setOwner] = useState('ALL');
  const [onlyMine, setOnlyMine] = useState(false);
  const [history, setHistory] = useState(false);

  const effectiveQuery = privacyMode ? '' : query;
  const effectiveOwner = privacyMode ? 'ALL' : owner;

  const workstreams = useMemo(
    () => [...new Map(tasks.map((task) => [task.workstreamId, task.workstreamName])).entries()],
    [tasks],
  );
  const owners = useMemo(
    () => [
      ...new Map(
        tasks
          .filter((task) => task.ownerId !== null)
          .map((task) => [task.ownerId!, task.ownerName!]),
      ).entries(),
    ],
    [tasks],
  );

  const filtered = useMemo(() => {
    const normalizedQuery = effectiveQuery.trim().toLocaleLowerCase('zh-CN');
    return tasks.filter((task) => {
      if (initialTaskIds !== undefined && !initialTaskIds.has(task.id)) return false;
      if (history === isTaskActive(task)) return false;
      if (status !== 'ALL' && task.status !== status) return false;
      if (workstream !== 'ALL' && task.workstreamId !== workstream) return false;
      if (effectiveOwner === 'UNASSIGNED' && task.ownerId !== null) return false;
      if (
        effectiveOwner !== 'ALL' &&
        effectiveOwner !== 'UNASSIGNED' &&
        task.ownerId !== effectiveOwner
      ) {
        return false;
      }
      if (
        onlyMine &&
        task.ownerId !== currentMemberId &&
        !task.collaboratorIds.includes(currentMemberId)
      ) {
        return false;
      }
      if (
        normalizedQuery.length > 0 &&
        !`${task.title} ${task.description} ${task.definitionOfDone}`
          .toLocaleLowerCase('zh-CN')
          .includes(normalizedQuery)
      ) {
        return false;
      }
      return true;
    });
  }, [
    currentMemberId,
    effectiveOwner,
    effectiveQuery,
    history,
    initialTaskIds,
    onlyMine,
    status,
    tasks,
    workstream,
  ]);

  return (
    <section className="fy-task-list" aria-label="任务列表">
      <header className="fy-task-list__header">
        <div>
          <span className="fy-eyebrow">结构化视图</span>
          <h2>{history ? '任务历史' : '全部活跃任务'}</h2>
        </div>
        <div className="fy-segmented" aria-label="任务范围">
          <button type="button" aria-pressed={!history} onClick={() => setHistory(false)}>
            活跃
          </button>
          <button type="button" aria-pressed={history} onClick={() => setHistory(true)}>
            历史
          </button>
        </div>
      </header>

      <div className="fy-task-list__filters">
        <label className="fy-search-field">
          <span className="fy-visually-hidden">搜索任务</span>
          <span aria-hidden="true">⌕</span>
          <input
            type="search"
            value={effectiveQuery}
            disabled={privacyMode}
            placeholder={privacyMode ? '隐私模式下搜索已停用' : '搜索标题、说明或完成定义'}
            onChange={(event) => {
              if (!privacyMode) setQuery(event.currentTarget.value);
            }}
          />
        </label>
        <label>
          <span>状态</span>
          <select
            value={status}
            onChange={(event) => setStatus(event.currentTarget.value as TaskStatus | 'ALL')}
          >
            <option value="ALL">全部</option>
            {Object.entries(TASK_STATUS_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>工作流</span>
          <select value={workstream} onChange={(event) => setWorkstream(event.currentTarget.value)}>
            <option value="ALL">全部</option>
            {workstreams.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {!privacyMode && (
          <label>
            <span>负责人</span>
            <select value={owner} onChange={(event) => setOwner(event.currentTarget.value)}>
              <option value="ALL">全部</option>
              <option value="UNASSIGNED">无人认领</option>
              {owners.map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="fy-check-field">
          <input
            type="checkbox"
            checked={onlyMine}
            onChange={(event) => setOnlyMine(event.currentTarget.checked)}
          />
          <span>只看我的任务</span>
        </label>
      </div>

      <div className="fy-task-list__summary" role="status">
        找到 {filtered.length} 个任务
      </div>
      {filtered.length === 0 ? (
        <div className="fy-empty-state">
          <strong>没有匹配的任务</strong>
          <p>可以清除筛选条件，或切换活跃与历史任务。</p>
        </div>
      ) : (
        <ul className="fy-task-list__rows">
          {filtered.map((task) => (
            <li key={task.id}>
              <button type="button" onClick={() => onSelectTask?.(task)}>
                <span
                  className={`fy-list-status fy-list-status--${task.status.toLowerCase().replaceAll('_', '-')}`}
                  aria-hidden="true"
                />
                <span className="fy-task-list__title">
                  <strong>{privacyMode ? '任务标题已隐藏' : task.title}</strong>
                  <small>
                    {task.workstreamName} · {ACTION_LEVEL_LABELS[task.actionLevel]}
                  </small>
                </span>
                <span className="fy-task-list__owner">
                  {privacyMode ? '人员信息已隐藏' : (task.ownerName ?? '无人认领')}
                </span>
                <span className="fy-task-list__state">{TASK_STATUS_LABELS[task.status]}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
