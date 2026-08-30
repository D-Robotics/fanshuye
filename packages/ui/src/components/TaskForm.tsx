import { useMemo, useState, type FormEvent } from 'react';
import {
  TASK_STATUS_LABELS,
  isTaskActive,
  type MemberSummary,
  type TaskDraft,
  type TaskItem,
} from '../types';

export interface TaskFormProps {
  task?: TaskItem;
  tasks: readonly TaskItem[];
  members: readonly MemberSummary[];
  online: boolean;
  submissionError?: string;
  onSubmit: (draft: TaskDraft) => void;
  onCancel: () => void;
  validateDependency?: (candidateTaskId: string) => string | null;
}

function normalized(value: string): string {
  return value.toLocaleLowerCase('zh-CN').replaceAll(/[\s\p{P}\p{S}]/gu, '');
}

function titleSimilarity(left: string, right: string): number {
  const a = normalized(left);
  const b = normalized(right);
  if (a.length < 2 || b.length < 2) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.8;
  const aPairs = new Set(
    Array.from({ length: a.length - 1 }, (_, index) => a.slice(index, index + 2)),
  );
  const bPairs = new Set(
    Array.from({ length: b.length - 1 }, (_, index) => b.slice(index, index + 2)),
  );
  const shared = [...aPairs].filter((pair) => bPairs.has(pair)).length;
  return shared / Math.max(aPairs.size, bPairs.size);
}

export function findPotentialDuplicateTasks(
  title: string,
  tasks: readonly TaskItem[],
  excludingTaskId?: string,
): TaskItem[] {
  return tasks
    .filter((candidate) => candidate.id !== excludingTaskId && isTaskActive(candidate))
    .map((candidate) => ({ candidate, score: titleSimilarity(title, candidate.title) }))
    .filter(({ score }) => score >= 0.48)
    .sort(
      (left, right) =>
        right.score - left.score || left.candidate.id.localeCompare(right.candidate.id),
    )
    .slice(0, 3)
    .map(({ candidate }) => candidate);
}

export function TaskForm({
  task,
  tasks,
  members,
  online,
  submissionError,
  onSubmit,
  onCancel,
  validateDependency,
}: TaskFormProps) {
  const [title, setTitle] = useState(task?.title ?? '');
  const [description, setDescription] = useState(task?.description ?? '');
  const [definitionOfDone, setDefinitionOfDone] = useState(task?.definitionOfDone ?? '');
  const [importance, setImportance] = useState<TaskItem['importance']>(task?.importance ?? 3);
  const [dueAt, setDueAt] = useState(task?.dueAt?.slice(0, 16) ?? '');
  const [ownerId, setOwnerId] = useState(task?.ownerId ?? '');
  const [collaboratorIds, setCollaboratorIds] = useState<string[]>(task?.collaboratorIds ?? []);
  const [prerequisiteTaskIds, setPrerequisiteTaskIds] = useState<string[]>(
    task?.prerequisites.map((relation) => relation.taskId) ?? [],
  );
  const [workstreamId, setWorkstreamId] = useState(task?.workstreamId ?? 'default');
  const [advancedOpen, setAdvancedOpen] = useState(
    task !== undefined &&
      (task.description.length > 0 ||
        task.definitionOfDone.length > 0 ||
        task.collaboratorIds.length > 0 ||
        task.prerequisites.length > 0),
  );
  const [error, setError] = useState<string | null>(null);

  const duplicates = useMemo(
    () => findPotentialDuplicateTasks(title, tasks, task?.id),
    [task?.id, tasks, title],
  );
  const dependencyCandidates = tasks.filter(
    (candidate) => candidate.id !== task?.id && isTaskActive(candidate),
  );
  const workstreams = [
    ...new Map(
      tasks.map((candidate) => [candidate.workstreamId, candidate.workstreamName]),
    ).entries(),
  ];
  if (!workstreams.some(([id]) => id === 'default')) workstreams.unshift(['default', '默认工作流']);

  const toggleCollaborator = (id: string) => {
    setCollaboratorIds((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    );
  };
  const togglePrerequisite = (id: string) => {
    const validationError = validateDependency?.(id) ?? null;
    if (!prerequisiteTaskIds.includes(id) && validationError !== null) {
      setError(validationError);
      return;
    }
    setError(null);
    setPrerequisiteTaskIds((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    );
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const cleanTitle = title.trim();
    if (cleanTitle.length === 0) {
      setError('任务标题不能为空。');
      return;
    }
    if (!online) {
      setError('当前为离线只读状态，联网后才能保存。');
      return;
    }
    onSubmit({
      title: cleanTitle,
      description: description.trim(),
      definitionOfDone: definitionOfDone.trim(),
      importance,
      dueAt: dueAt.length === 0 ? null : new Date(dueAt).toISOString(),
      ownerId: ownerId.length === 0 ? null : ownerId,
      collaboratorIds,
      prerequisiteTaskIds,
      workstreamId,
    });
  };

  return (
    <form
      className="fy-task-form"
      onSubmit={submit}
      aria-label={task === undefined ? '创建任务' : '编辑任务'}
    >
      <header>
        <div>
          <span className="fy-eyebrow">
            {task === undefined ? '长出一片新叶子' : '更新任务事实'}
          </span>
          <h2>{task === undefined ? '创建任务' : '编辑任务'}</h2>
        </div>
        <button type="button" className="fy-icon-button" onClick={onCancel} aria-label="关闭表单">
          ×
        </button>
      </header>

      {!online && <div className="fy-inline-alert">离线只读：所有保存入口已禁用。</div>}
      {(error ?? submissionError) !== undefined && (error ?? submissionError) !== null && (
        <div className="fy-inline-alert fy-inline-alert--danger" role="alert">
          {error ?? submissionError}
        </div>
      )}

      <label className="fy-field fy-field--wide">
        <span>标题 *</span>
        <input
          value={title}
          maxLength={160}
          autoFocus
          onChange={(event) => setTitle(event.currentTarget.value)}
        />
      </label>

      {duplicates.length > 0 && (
        <section className="fy-duplicate-notice" aria-label="潜在重复任务">
          <strong>这些活跃任务可能相似</strong>
          <p>确认不是同一项工作后，仍然可以继续创建。</p>
          <ul>
            {duplicates.map((duplicate) => (
              <li key={duplicate.id}>
                <span>{duplicate.title}</span>
                <small>
                  {TASK_STATUS_LABELS[duplicate.status]} · {duplicate.ownerName ?? '无人认领'}
                </small>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="fy-task-form__grid">
        <label className="fy-field">
          <span>重要度</span>
          <select
            value={importance}
            onChange={(event) =>
              setImportance(Number(event.currentTarget.value) as TaskItem['importance'])
            }
          >
            {[1, 2, 3, 4, 5].map((value) => (
              <option key={value} value={value}>
                {value} / 5{value <= 2 ? ' · 小叶' : value === 3 ? ' · 中叶' : ' · 大叶'}
              </option>
            ))}
          </select>
        </label>
        <label className="fy-field">
          <span>截止时间</span>
          <input
            type="datetime-local"
            value={dueAt}
            onChange={(event) => setDueAt(event.currentTarget.value)}
          />
        </label>
        <label className="fy-field">
          <span>负责人</span>
          <select value={ownerId} onChange={(event) => setOwnerId(event.currentTarget.value)}>
            <option value="">无人认领</option>
            {members.map((member) => (
              <option key={member.id} value={member.id}>
                {member.displayName}
              </option>
            ))}
          </select>
        </label>
        <label className="fy-field">
          <span>工作流</span>
          <select
            value={workstreamId}
            onChange={(event) => setWorkstreamId(event.currentTarget.value)}
          >
            {workstreams.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <details
        className="fy-task-form__advanced"
        open={advancedOpen}
        onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
      >
        <summary>更多信息</summary>
        <div className="fy-task-form__advanced-content">
          <label className="fy-field fy-field--wide">
            <span>说明</span>
            <textarea
              rows={3}
              maxLength={4000}
              value={description}
              onChange={(event) => setDescription(event.currentTarget.value)}
            />
          </label>
          <label className="fy-field fy-field--wide">
            <span>完成定义</span>
            <textarea
              rows={2}
              maxLength={2000}
              value={definitionOfDone}
              onChange={(event) => setDefinitionOfDone(event.currentTarget.value)}
            />
          </label>

          <fieldset className="fy-choice-grid">
            <legend>协作人</legend>
            {members.map((member) => (
              <label key={member.id}>
                <input
                  type="checkbox"
                  checked={collaboratorIds.includes(member.id)}
                  onChange={() => toggleCollaborator(member.id)}
                />
                <span>{member.displayName}</span>
              </label>
            ))}
          </fieldset>

          <fieldset className="fy-choice-grid">
            <legend>直接前置任务</legend>
            {dependencyCandidates.length === 0 ? (
              <p>暂无可选择的活跃任务。</p>
            ) : (
              dependencyCandidates.map((candidate) => (
                <label key={candidate.id}>
                  <input
                    type="checkbox"
                    checked={prerequisiteTaskIds.includes(candidate.id)}
                    onChange={() => togglePrerequisite(candidate.id)}
                  />
                  <span>{candidate.title}</span>
                </label>
              ))
            )}
          </fieldset>
        </div>
      </details>

      <footer>
        <button type="button" className="fy-button fy-button--quiet" onClick={onCancel}>
          取消
        </button>
        <button type="submit" className="fy-button fy-button--primary" disabled={!online}>
          {task === undefined ? '创建任务' : '保存修改'}
        </button>
      </footer>
    </form>
  );
}
