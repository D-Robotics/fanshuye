import {
  ACTION_LEVEL_LABELS,
  TASK_STATUS_LABELS,
  isDependencyBlocked,
  isTaskOverdue,
  type TaskItem,
} from '../types';

export interface TaskQuickPreviewProps {
  task: TaskItem;
  privacyMode?: boolean;
  onClose: () => void;
  onEdit?: () => void;
  onOpenDetails?: () => void;
}

function compactDueDate(dueAt: string | null): string {
  if (dueAt === null) return '未设置';
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(dueAt));
}

export function TaskQuickPreview({
  task,
  privacyMode = false,
  onClose,
  onEdit,
  onOpenDetails,
}: TaskQuickPreviewProps) {
  const blocked = task.manualBlock !== null || isDependencyBlocked(task);
  const overdue = isTaskOverdue(task);

  return (
    <aside className="fy-task-quick-preview" aria-label="任务速览">
      <header className="fy-task-quick-preview__header">
        <div className="fy-task-quick-preview__chips">
          <span>{TASK_STATUS_LABELS[task.status]}</span>
          <span>{ACTION_LEVEL_LABELS[task.actionLevel]}</span>
          <span>重要度 {task.importance}</span>
        </div>
        <button type="button" onClick={onClose} aria-label="关闭任务速览">
          ×
        </button>
      </header>

      <h2>{privacyMode ? '任务内容已隐藏' : task.title}</h2>
      <p className="fy-task-quick-preview__reason">
        {privacyMode ? '已开启隐私模式' : task.actionReason || '暂无优先级说明'}
      </p>

      <dl className="fy-task-quick-preview__facts">
        <div>
          <dt>负责人</dt>
          <dd>{privacyMode ? '已隐藏' : (task.ownerName ?? '无人认领')}</dd>
        </div>
        <div>
          <dt>截止</dt>
          <dd>{privacyMode ? '已隐藏' : compactDueDate(task.dueAt)}</dd>
        </div>
      </dl>

      {(blocked || overdue) && (
        <p className="fy-task-quick-preview__warning" role="note">
          {blocked && overdue ? '任务阻塞且已逾期' : blocked ? '任务当前被阻塞' : '任务已经逾期'}
        </p>
      )}

      <footer>
        <span>前置 {task.prerequisites.length}</span>
        <span>后续 {task.dependents.length}</span>
        {onEdit === undefined && onOpenDetails === undefined ? (
          <small>关系已标在树上</small>
        ) : (
          <span className="fy-task-quick-preview__actions">
            {onEdit !== undefined && (
              <button type="button" onClick={onEdit}>
                编辑详情
              </button>
            )}
            {onOpenDetails !== undefined && (
              <button type="button" onClick={onOpenDetails}>
                完整详情
              </button>
            )}
          </span>
        )}
      </footer>
    </aside>
  );
}
