import { performance } from 'node:perf_hooks';
import { buildTaskTreeLayout } from './layout';
import { isTaskActive, type ActionLevel, type TaskItem, type TaskStatus } from './types';

const runPerformanceBaseline = process.env.PERFORMANCE_BASELINE === '1';
const performanceSuite = describe.skipIf(!runPerformanceBaseline);

const TOTAL_TASKS = 1_000;
const ACTIVE_TASKS = 100;
const MAXIMUM_VISIBLE_LEAVES = 15;
const FRAME_BUDGET_MS = 16.67;
const LAYOUT_P95_THRESHOLD_MS = 8;
const SAMPLE_COUNT = 60;
const ITERATIONS_PER_SAMPLE = 50;

performanceSuite('1,000-task overlay tree performance baseline', () => {
  it('aggregates 100 active tasks and lays out only visible leaves within the frame budget', () => {
    const tasks = createTasks();
    const activeTasks = tasks.filter(isTaskActive);
    expect(tasks).toHaveLength(TOTAL_TASKS);
    expect(activeTasks).toHaveLength(ACTIVE_TASKS);

    for (let index = 0; index < 200; index += 1) {
      buildTaskTreeLayout(tasks, MAXIMUM_VISIBLE_LEAVES);
    }

    const samples: number[] = [];
    let lastLayout = buildTaskTreeLayout(tasks, MAXIMUM_VISIBLE_LEAVES);
    for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
      const startedAt = performance.now();
      for (let iteration = 0; iteration < ITERATIONS_PER_SAMPLE; iteration += 1) {
        lastLayout = buildTaskTreeLayout(tasks, MAXIMUM_VISIBLE_LEAVES);
      }
      samples.push((performance.now() - startedAt) / ITERATIONS_PER_SAMPLE);
    }

    const metrics = summarize(samples);
    expect(lastLayout.leaves).toHaveLength(MAXIMUM_VISIBLE_LEAVES);
    expect(lastLayout.overflow).toHaveLength(ACTIVE_TASKS - MAXIMUM_VISIBLE_LEAVES);
    expect(metrics.p95Ms).toBeLessThanOrEqual(LAYOUT_P95_THRESHOLD_MS);
    expect(metrics.maxMs).toBeLessThan(FRAME_BUDGET_MS);

    console.info(
      `PERF_UI_JSON ${JSON.stringify({
        totalTasks: tasks.length,
        activeTasks: activeTasks.length,
        visibleLeaves: lastLayout.leaves.length,
        overflowTasks: lastLayout.overflow.length,
        samples: SAMPLE_COUNT,
        iterationsPerSample: ITERATIONS_PER_SAMPLE,
        p50Ms: metrics.p50Ms,
        p95Ms: metrics.p95Ms,
        maxMs: metrics.maxMs,
        p95ThresholdMs: LAYOUT_P95_THRESHOLD_MS,
        frameBudgetMs: FRAME_BUDGET_MS,
        passed: true,
      })}`,
    );
  });
});

function createTasks(): TaskItem[] {
  return Array.from({ length: TOTAL_TASKS }, (_, index) => {
    const active = index < ACTIVE_TASKS;
    const status: TaskStatus = active
      ? (['TODO', 'IN_PROGRESS', 'IN_REVIEW'] as const)[index % 3]!
      : 'DONE';
    const actionLevel: ActionLevel =
      index < 34 ? 'NOW' : index < 67 ? 'NEXT' : index < ACTIVE_TASKS ? 'LATER' : 'LATER';
    const prerequisiteIndex =
      index > 0 && index < ACTIVE_TASKS && index % 7 === 0 ? index - 1 : null;
    return {
      id: `perf-task-${index.toString().padStart(4, '0')}`,
      title: `Performance task ${index.toString().padStart(4, '0')}`,
      description: '',
      definitionOfDone: '',
      status,
      actionLevel,
      actionReason: actionLevel === 'NOW' ? 'Near-term delivery risk' : 'Stable baseline order',
      importance: ((index % 5) + 1) as TaskItem['importance'],
      workstreamId: 'perf-workstream',
      workstreamName: 'Performance baseline',
      ownerId: active && index % 4 !== 0 ? 'perf-owner' : null,
      ownerName: active && index % 4 !== 0 ? 'Performance Owner' : null,
      collaboratorIds: [],
      collaboratorNames: [],
      dueAt: active ? new Date(Date.UTC(2026, 7, 27 + (index % 14))).toISOString() : null,
      manualBlock:
        active && index % 19 === 0
          ? { type: 'technical', reason: 'Synthetic baseline blocker' }
          : null,
      prerequisites:
        prerequisiteIndex === null
          ? []
          : [
              {
                taskId: `perf-task-${prerequisiteIndex.toString().padStart(4, '0')}`,
                title: `Performance task ${prerequisiteIndex.toString().padStart(4, '0')}`,
                status: 'TODO',
              },
            ],
      incompletePrerequisites:
        prerequisiteIndex === null
          ? []
          : [
              {
                taskId: `perf-task-${prerequisiteIndex.toString().padStart(4, '0')}`,
                title: `Performance task ${prerequisiteIndex.toString().padStart(4, '0')}`,
                status: 'TODO',
              },
            ],
      dependents: [],
      externalReferences: [],
      timeline: [],
      version: 1,
      stableOrder: index,
      updatedAt: '2026-08-26T00:00:00.000Z',
      archivedAt: active ? null : '2026-08-26T00:00:00.000Z',
    };
  });
}

function summarize(samples: readonly number[]): { p50Ms: number; p95Ms: number; maxMs: number } {
  const ordered = [...samples].sort((left, right) => left - right);
  return {
    p50Ms: round(percentile(ordered, 0.5)),
    p95Ms: round(percentile(ordered, 0.95)),
    maxMs: round(ordered.at(-1) ?? 0),
  };
}

function percentile(ordered: readonly number[], quantile: number): number {
  if (ordered.length === 0) return 0;
  const index = Math.min(ordered.length - 1, Math.ceil(ordered.length * quantile) - 1);
  return ordered[index] ?? 0;
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
