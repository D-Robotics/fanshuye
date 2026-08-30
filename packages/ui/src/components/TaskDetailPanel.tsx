import { useState } from 'react';
import {
  TASK_STATUS_LABELS,
  isDependencyBlocked,
  type TaskCommandName,
  type TaskCommandRequest,
  type TaskItem,
} from '../types';

export interface TaskDetailPanelProps {
  task: TaskItem;
  online: boolean;
  currentMemberId?: string;
  privacyMode?: boolean;
  conflictMessage?: string;
  commandPending?: boolean;
  onCommand?: (request: TaskCommandRequest) => void;
  onEdit?: (task: TaskItem) => void;
  onClose?: () => void;
}

interface ActionSpec {
  command: TaskCommandName;
  label: string;
  emphasis?: boolean;
}

function availableActions(task: TaskItem, currentMemberId?: string): ActionSpec[] {
  const actions: ActionSpec[] = [];
  if (task.status === 'TODO') {
    if (task.ownerId === null) {
      actions.push({ command: 'claim-and-start', label: '认领并开始', emphasis: true });
    } else if (currentMemberId === undefined || task.ownerId === currentMemberId) {
      actions.push({ command: 'start', label: '开始处理', emphasis: true });
    }
  }
  if (task.status === 'IN_PROGRESS') {
    actions.push(
      { command: 'request-review', label: '请求评审', emphasis: true },
      { command: 'complete', label: '直接完成' },
      { command: 'pause', label: '暂停' },
      { command: 'release', label: '释放任务' },
    );
  }
  if (task.status === 'IN_REVIEW') {
    actions.push(
      { command: 'complete', label: '确认完成', emphasis: true },
      { command: 'request-changes', label: '退回修改' },
    );
  }
  if (task.status === 'DONE' || task.status === 'CANCELED') {
    actions.push({ command: 'reopen', label: '重新打开' });
  } else {
    if (
      task.ownerId !== null &&
      (currentMemberId === undefined || task.ownerId !== currentMemberId)
    ) {
      if (currentMemberId === undefined || !task.collaboratorIds.includes(currentMemberId)) {
        actions.push({ command: 'join', label: '加入协作' });
      }
      actions.push({ command: 'request-transfer', label: '请求接手' });
    }
    actions.push(
      task.manualBlock === null
        ? { command: 'block', label: '标记阻塞' }
        : { command: 'unblock', label: '解除阻塞' },
    );
    actions.push({ command: 'cancel', label: '取消任务' });
  }
  return actions;
}

function safeExternalUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

interface TaskDetailActionsProps {
  task: TaskItem;
  online: boolean;
  currentMemberId?: string;
  commandPending: boolean;
  dependencyBlocked: boolean;
  onCommand?: (request: TaskCommandRequest) => void;
  onEdit?: (task: TaskItem) => void;
}

function TaskDetailActions({
  task,
  online,
  currentMemberId,
  commandPending,
  dependencyBlocked,
  onCommand,
  onEdit,
}: TaskDetailActionsProps) {
  const [showBlockForm, setShowBlockForm] = useState(false);
  const [blockType, setBlockType] = useState('technical');
  const [blockReason, setBlockReason] = useState('');
  const run = (name: TaskCommandName, payload?: Record<string, unknown>) => {
    onCommand?.({
      name,
      taskId: task.id,
      expectedVersion: task.version,
      ...(payload === undefined ? {} : { payload }),
    });
  };

  return (
    <footer className="fy-task-detail__footer">
      {showBlockForm && (
        <form
          className="fy-block-form"
          onSubmit={(event) => {
            event.preventDefault();
            const reason = blockReason.trim();
            if (reason.length === 0) return;
            run('block', { type: blockType, reason });
            setShowBlockForm(false);
            setBlockReason('');
          }}
        >
          <label>
            <span>阻塞类型</span>
            <select value={blockType} onChange={(event) => setBlockType(event.currentTarget.value)}>
              <option value="technical">技术问题</option>
              <option value="decision">等待决策</option>
              <option value="resource">资源不足</option>
              <option value="external">外部依赖</option>
              <option value="other">其他</option>
            </select>
          </label>
          <label>
            <span>阻塞原因 *</span>
            <input
              value={blockReason}
              maxLength={500}
              onChange={(event) => setBlockReason(event.currentTarget.value)}
            />
          </label>
          <button
            type="submit"
            className="fy-button fy-button--primary"
            disabled={blockReason.trim().length === 0}
          >
            确认阻塞
          </button>
        </form>
      )}
      {onEdit !== undefined && task.archivedAt === null && (
        <button
          type="button"
          className="fy-button fy-button--quiet"
          disabled={!online}
          onClick={() => onEdit(task)}
        >
          编辑详情
        </button>
      )}
      <div className="fy-task-detail__actions" role="group" aria-label="任务操作">
        {availableActions(task, currentMemberId).map((action) => (
          <button
            key={action.command}
            type="button"
            className={`fy-button${action.emphasis === true ? ' fy-button--primary' : ''}`}
            disabled={
              !online ||
              commandPending ||
              ((action.command === 'start' || action.command === 'claim-and-start') &&
                dependencyBlocked)
            }
            title={
              (action.command === 'start' || action.command === 'claim-and-start') &&
              dependencyBlocked
                ? '完成所有前置任务后才能开始'
                : undefined
            }
            onClick={() => {
              if (action.command === 'block') {
                setShowBlockForm(true);
              } else {
                run(action.command);
              }
            }}
          >
            {action.label}
          </button>
        ))}
      </div>
    </footer>
  );
}

export function TaskDetailPanel({
  task,
  online,
  currentMemberId,
  privacyMode = false,
  conflictMessage,
  commandPending = false,
  onCommand,
  onEdit,
  onClose,
}: TaskDetailPanelProps) {
  const dependencyBlocked = isDependencyBlocked(task);

  return (
    <aside className="fy-task-detail" aria-label="任务详情">
      <header className="fy-task-detail__header">
        <div>
          <span className="fy-eyebrow">
            {task.workstreamName} · {TASK_STATUS_LABELS[task.status]}
          </span>
          <h2>{privacyMode ? '任务标题已隐藏' : task.title}</h2>
        </div>
        {onClose !== undefined && (
          <button
            className="fy-icon-button"
            type="button"
            onClick={onClose}
            aria-label="关闭任务详情"
          >
            ×
          </button>
        )}
      </header>

      {!online && (
        <div className="fy-inline-alert" role="note">
          当前为离线只读状态。联网并同步后才能修改任务。
        </div>
      )}
      {conflictMessage !== undefined && (
        <div className="fy-inline-alert fy-inline-alert--danger" role="alert">
          <strong>任务已经被其他成员更新</strong>
          <span>{conflictMessage}</span>
        </div>
      )}

      {!privacyMode && (
        <>
          <dl className="fy-task-detail__facts">
            <div>
              <dt>负责人</dt>
              <dd>{task.ownerName ?? '无人认领'}</dd>
            </div>
            <div>
              <dt>协作人</dt>
              <dd>{task.collaboratorNames.join('、') || '无'}</dd>
            </div>
            <div>
              <dt>重要度</dt>
              <dd>{task.importance} / 5</dd>
            </div>
            <div>
              <dt>截止时间</dt>
              <dd>
                {task.dueAt === null
                  ? '未设置'
                  : new Intl.DateTimeFormat('zh-CN', {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    }).format(new Date(task.dueAt))}
              </dd>
            </div>
          </dl>

          <section className="fy-task-detail__section">
            <h3>为什么现在在这里</h3>
            <p>{task.actionReason}</p>
          </section>

          <section className="fy-task-detail__section">
            <h3>任务说明</h3>
            <p className="fy-preserve-lines">{task.description || '暂未填写说明。'}</p>
          </section>

          <section className="fy-task-detail__section">
            <h3>完成定义</h3>
            <p className="fy-preserve-lines">{task.definitionOfDone || '暂未填写完成定义。'}</p>
          </section>

          {(task.manualBlock !== null || dependencyBlocked) && (
            <section className="fy-task-detail__section fy-task-detail__section--blocked">
              <h3>阻塞</h3>
              {task.manualBlock !== null && (
                <p>
                  人工阻塞：{task.manualBlock.type} · {task.manualBlock.reason}
                </p>
              )}
              {dependencyBlocked && (
                <p>
                  未完成前置：{task.incompletePrerequisites.map((item) => item.title).join('、')}
                </p>
              )}
            </section>
          )}

          <section className="fy-task-detail__section">
            <h3>直接依赖</h3>
            <div className="fy-dependency-columns">
              <div>
                <strong>前置任务</strong>
                {task.prerequisites.length === 0 ? (
                  <p>没有直接前置任务</p>
                ) : (
                  <ul>
                    {task.prerequisites.map((relation) => (
                      <li key={relation.taskId}>
                        {relation.title} · {TASK_STATUS_LABELS[relation.status]}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <strong>后续任务</strong>
                {task.dependents.length === 0 ? (
                  <p>没有直接后续任务</p>
                ) : (
                  <ul>
                    {task.dependents.map((relation) => (
                      <li key={relation.taskId}>{relation.title}</li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </section>

          {task.externalReferences.length > 0 && (
            <section className="fy-task-detail__section">
              <h3>外部引用</h3>
              <ul className="fy-reference-list">
                {task.externalReferences.map((reference) => {
                  const href = safeExternalUrl(reference.url);
                  return (
                    <li key={reference.id}>
                      {href === null ? (
                        <span>{reference.label}（链接不可用）</span>
                      ) : (
                        <a href={href} target="_blank" rel="noreferrer noopener">
                          {reference.label}
                        </a>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          <section className="fy-task-detail__section">
            <h3>任务动态</h3>
            {task.timeline.length === 0 ? (
              <p>暂无动态。</p>
            ) : (
              <ol className="fy-timeline">
                {task.timeline.map((event) => (
                  <li key={event.id}>
                    <span className="fy-timeline__dot" aria-hidden="true" />
                    <div>
                      <strong>{event.text}</strong>
                      <small>
                        {event.actorName} ·{' '}
                        {new Intl.DateTimeFormat('zh-CN', {
                          month: 'numeric',
                          day: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                        }).format(new Date(event.occurredAt))}
                      </small>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </>
      )}

      {!privacyMode && (
        <TaskDetailActions
          task={task}
          online={online}
          commandPending={commandPending}
          dependencyBlocked={dependencyBlocked}
          {...(currentMemberId === undefined ? {} : { currentMemberId })}
          {...(onCommand === undefined ? {} : { onCommand })}
          {...(onEdit === undefined ? {} : { onEdit })}
        />
      )}
    </aside>
  );
}
