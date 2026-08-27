import { TaskTree, isDependencyBlocked, type TaskItem } from '@fanshuye/ui';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  USABILITY_STUDY_DATASET_ID,
  USABILITY_STUDY_MAXIMUM_VISIBLE,
  USABILITY_STUDY_TIME_LIMIT_MS,
  createUsabilityStudyTasks,
  validateUsabilityStudyDataset,
} from './usability-study-data';

type TrialId = 'highest-action' | 'unassigned' | 'blocked' | 'owner-hover';
type TrialOutcome = 'pass' | 'incorrect' | 'timeout';
type StudyPhase = 'ready' | 'running' | 'finished';

interface TrialDefinition {
  id: TrialId;
  title: string;
  prompt: string;
}

interface TrialResult {
  trialId: TrialId;
  outcome: TrialOutcome;
  elapsedMs: number;
  targetTaskId: string | null;
  ownerAnswer: string | null;
}

export const USABILITY_STUDY_TRIALS: readonly TrialDefinition[] = [
  {
    id: 'highest-action',
    title: '最高行动等级',
    prompt: '点击一片属于最高行动等级的叶子。第一次点击即为答案。',
  },
  {
    id: 'unassigned',
    title: '无人认领任务',
    prompt: '点击一片无人认领的叶子。第一次点击即为答案。',
  },
  {
    id: 'blocked',
    title: '阻塞任务',
    prompt: '点击一片当前被阻塞的叶子。第一次点击即为答案。',
  },
  {
    id: 'owner-hover',
    title: 'Hover 查看负责人',
    prompt: 'Hover 任意有负责人的叶子，从卡片读取姓名，输入后提交。',
  },
];

export interface UsabilityStudyHarnessProps {
  now?: () => number;
}

export function UsabilityStudyHarness({
  now = () => performance.now(),
}: UsabilityStudyHarnessProps) {
  const tasks = useMemo(() => createUsabilityStudyTasks(), []);
  const prerequisiteProblems = useMemo(() => validateUsabilityStudyDataset(tasks), [tasks]);
  const [participantCode, setParticipantCode] = useState('');
  const [phase, setPhase] = useState<StudyPhase>('ready');
  const [trialIndex, setTrialIndex] = useState(0);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [results, setResults] = useState<TrialResult[]>([]);
  const [hoveredOwnedTask, setHoveredOwnedTask] = useState<TaskItem | null>(null);
  const [ownerAnswer, setOwnerAnswer] = useState('');
  const [sessionStartedAt, setSessionStartedAt] = useState<string | null>(null);
  const [sessionCompletedAt, setSessionCompletedAt] = useState<string | null>(null);
  const trial = USABILITY_STUDY_TRIALS[trialIndex]!;

  const recordResult = useCallback(
    (requestedOutcome: TrialOutcome, task: TaskItem | null, answer: string | null = null) => {
      if (phase !== 'running' || startedAt === null) return;
      const measured = Math.max(0, now() - startedAt);
      const outcome = measured > USABILITY_STUDY_TIME_LIMIT_MS ? 'timeout' : requestedOutcome;
      const result: TrialResult = {
        trialId: trial.id,
        outcome,
        elapsedMs: Math.min(measured, USABILITY_STUDY_TIME_LIMIT_MS),
        targetTaskId: task?.id ?? null,
        ownerAnswer: answer,
      };
      setResults((current) => [...current, result]);
      setElapsedMs(result.elapsedMs);
      setStartedAt(null);
      setHoveredOwnedTask(null);
      setOwnerAnswer('');
      if (trialIndex === USABILITY_STUDY_TRIALS.length - 1) {
        setPhase('finished');
        setSessionCompletedAt(new Date().toISOString());
      } else {
        setTrialIndex((current) => current + 1);
        setPhase('ready');
      }
    },
    [now, phase, startedAt, trial.id, trialIndex],
  );

  useEffect(() => {
    if (phase !== 'running' || startedAt === null) return;
    const timer = window.setInterval(() => {
      const measured = Math.max(0, now() - startedAt);
      setElapsedMs(Math.min(measured, USABILITY_STUDY_TIME_LIMIT_MS));
      if (measured >= USABILITY_STUDY_TIME_LIMIT_MS) recordResult('timeout', null);
    }, 50);
    return () => window.clearInterval(timer);
  }, [now, phase, recordResult, startedAt]);

  const beginTrial = () => {
    if (participantCode.trim().length === 0 || prerequisiteProblems.length > 0) return;
    if (results.length === 0 && sessionStartedAt === null) {
      setSessionStartedAt(new Date().toISOString());
    }
    setElapsedMs(0);
    setHoveredOwnedTask(null);
    setOwnerAnswer('');
    setStartedAt(now());
    setPhase('running');
  };

  const selectTask = (task: TaskItem) => {
    if (phase !== 'running' || trial.id === 'owner-hover') return;
    const correct =
      trial.id === 'highest-action'
        ? task.actionLevel === 'NOW'
        : trial.id === 'unassigned'
          ? task.ownerId === null
          : task.manualBlock !== null || isDependencyBlocked(task);
    recordResult(correct ? 'pass' : 'incorrect', task);
  };

  const submitOwnerAnswer = () => {
    if (phase !== 'running' || trial.id !== 'owner-hover') return;
    const normalizedAnswer = ownerAnswer.trim();
    const correct =
      hoveredOwnedTask?.ownerName !== null &&
      hoveredOwnedTask?.ownerName !== undefined &&
      normalizedAnswer === hoveredOwnedTask.ownerName;
    recordResult(correct ? 'pass' : 'incorrect', hoveredOwnedTask, normalizedAnswer);
  };

  const reset = () => {
    setPhase('ready');
    setTrialIndex(0);
    setStartedAt(null);
    setElapsedMs(0);
    setResults([]);
    setHoveredOwnedTask(null);
    setOwnerAnswer('');
    setSessionStartedAt(null);
    setSessionCompletedAt(null);
  };

  const strictPass =
    results.length === USABILITY_STUDY_TRIALS.length &&
    results.every(
      (result) => result.outcome === 'pass' && result.elapsedMs <= USABILITY_STUDY_TIME_LIMIT_MS,
    );
  const resultDocument = JSON.stringify(
    {
      schemaVersion: 1,
      datasetId: USABILITY_STUDY_DATASET_ID,
      participantCode: participantCode.trim(),
      participantRoleRequired: 'developer',
      timeLimitMs: USABILITY_STUDY_TIME_LIMIT_MS,
      totalTasks: tasks.length,
      sessionStartedAt,
      sessionCompletedAt,
      strictPass,
      results,
      evidenceStatus: 'OBSERVER_ATTESTATION_REQUIRED',
    },
    null,
    2,
  );

  return (
    <main className="fy-usability-study">
      <header className="fy-usability-study__header">
        <div>
          <span>可用性测试模式 · {USABILITY_STUDY_DATASET_ID}</span>
          <h1>30 任务开发者速览测试</h1>
          <p>每项独立计时 5 秒；第一下点击计入结果。自动化仅验证测试装置。</p>
        </div>
        <dl>
          <div>
            <dt>任务总数</dt>
            <dd>{tasks.length}</dd>
          </div>
          <div>
            <dt>直显叶片</dt>
            <dd>{USABILITY_STUDY_MAXIMUM_VISIBLE}</dd>
          </div>
          <div>
            <dt>机器前置检查</dt>
            <dd>{prerequisiteProblems.length === 0 ? '通过' : '失败'}</dd>
          </div>
        </dl>
      </header>

      <section className="fy-usability-study__controls" aria-label="计时测试控制台">
        <label>
          参与者代码
          <input
            value={participantCode}
            disabled={results.length > 0 || phase === 'running'}
            onChange={(event) => setParticipantCode(event.currentTarget.value)}
            placeholder="例如 DEV-01"
          />
        </label>
        {phase !== 'finished' ? (
          <div className="fy-usability-study__prompt">
            <span>
              第 {trialIndex + 1} / {USABILITY_STUDY_TRIALS.length} 项
            </span>
            <strong>{trial.title}</strong>
            <p>{trial.prompt}</p>
          </div>
        ) : (
          <div className="fy-usability-study__prompt">
            <span>原始观察完成</span>
            <strong>
              {results.filter((result) => result.outcome === 'pass').length} /{' '}
              {USABILITY_STUDY_TRIALS.length} 项在 5 秒内完成
            </strong>
            <p>仍需观察者核验参与者为开发者并签署记录，机器测试不能替代该步骤。</p>
          </div>
        )}
        <div className="fy-usability-study__timer" aria-live="polite">
          {phase === 'running'
            ? `${Math.max(0, (USABILITY_STUDY_TIME_LIMIT_MS - elapsedMs) / 1_000).toFixed(2)} 秒`
            : '5.00 秒'}
        </div>
        {phase === 'ready' && (
          <button
            type="button"
            disabled={participantCode.trim().length === 0 || prerequisiteProblems.length > 0}
            onClick={beginTrial}
          >
            开始计时：{trial.title}
          </button>
        )}
        {phase === 'finished' && (
          <button type="button" onClick={reset}>
            重置测试
          </button>
        )}
        {phase === 'running' && trial.id === 'owner-hover' && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              submitOwnerAnswer();
            }}
          >
            <label>
              卡片中的负责人
              <input
                autoFocus
                value={ownerAnswer}
                onChange={(event) => setOwnerAnswer(event.currentTarget.value)}
              />
            </label>
            <button type="submit">提交负责人</button>
          </form>
        )}
      </section>

      {prerequisiteProblems.length > 0 && (
        <section className="fy-usability-study__problems" role="alert">
          <strong>数据集前置检查失败，禁止开始真人计时：</strong>
          <ul>
            {prerequisiteProblems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </section>
      )}

      <section className="fy-usability-study__tree" aria-label="30 任务测试画布">
        {phase === 'running' ? (
          <TaskTree
            tasks={tasks}
            maximumVisible={USABILITY_STUDY_MAXIMUM_VISIBLE}
            reducedMotion
            onSelectTask={selectTask}
            onHoverTask={(task) => {
              if (
                trial.id === 'owner-hover' &&
                task?.ownerName !== null &&
                task?.ownerName !== undefined
              ) {
                setHoveredOwnedTask(task);
              }
            }}
          />
        ) : (
          <div className="fy-usability-study__mask" role="note">
            <strong>测试画布已遮挡</strong>
            <span>点击“开始计时”后才会显示任务树，避免提前浏览。</span>
          </div>
        )}
      </section>

      {results.length > 0 && (
        <section className="fy-usability-study__results" aria-label="原始计时结果">
          <table>
            <thead>
              <tr>
                <th>测试项</th>
                <th>结果</th>
                <th>耗时</th>
                <th>任务</th>
              </tr>
            </thead>
            <tbody>
              {results.map((result) => (
                <tr key={result.trialId}>
                  <td>
                    {USABILITY_STUDY_TRIALS.find((item) => item.id === result.trialId)?.title}
                  </td>
                  <td>{result.outcome}</td>
                  <td>{result.elapsedMs.toFixed(0)} ms</td>
                  <td>{result.targetTaskId ?? '无'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {phase === 'finished' && (
            <label>
              原始结果 JSON（复制到观察记录）
              <textarea readOnly rows={14} value={resultDocument} />
            </label>
          )}
        </section>
      )}
    </main>
  );
}
