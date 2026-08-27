export type CommandOutcome = 'success' | 'failure';
export type ConflictCode = 'VERSION_CONFLICT' | 'CLAIM_CONFLICT';
export type DependencyQueryOperation =
  'prerequisites' | 'dependents' | 'reachability' | 'impact_subgraph' | 'impact_nodes';

type DependencyQueryOutcome = 'success' | 'failure';

const DURATION_BUCKETS_SECONDS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

interface HistogramState {
  buckets: number[];
  count: number;
  sum: number;
}

/**
 * Process-local, bounded-cardinality operational metrics.
 *
 * This deliberately accepts only fixed enums. Workspace, user, task, command,
 * URL and error-message values must never become metric labels.
 */
export class MetricsRegistry {
  readonly #commands: Record<CommandOutcome, number> = { success: 0, failure: 0 };
  readonly #commandDurations: Record<CommandOutcome, HistogramState> = {
    success: newHistogram(),
    failure: newHistogram(),
  };
  readonly #conflicts: Record<ConflictCode, number> = {
    VERSION_CONFLICT: 0,
    CLAIM_CONFLICT: 0,
  };
  readonly #dependencyDurations = new Map<string, HistogramState>();
  #syncSnapshotRequired = 0;
  #snapshotRequests = 0;
  #websocketConnections = 0;

  recordCommand(outcome: CommandOutcome, elapsedMilliseconds: number): void {
    this.#commands[outcome] += 1;
    observe(this.#commandDurations[outcome], toSeconds(elapsedMilliseconds));
  }

  recordConflict(code: ConflictCode): void {
    this.#conflicts[code] += 1;
  }

  recordSyncSnapshotRequired(): void {
    this.#syncSnapshotRequired += 1;
  }

  recordSnapshotRequest(): void {
    this.#snapshotRequests += 1;
  }

  setWebsocketConnections(value: number): void {
    this.#websocketConnections = Math.max(0, Math.trunc(value));
  }

  async measureDependencyQuery<T>(
    operation: DependencyQueryOperation,
    work: () => Promise<T>,
  ): Promise<T> {
    const startedAt = performance.now();
    try {
      const result = await work();
      this.#observeDependency(operation, 'success', performance.now() - startedAt);
      return result;
    } catch (error) {
      this.#observeDependency(operation, 'failure', performance.now() - startedAt);
      throw error;
    }
  }

  renderPrometheus(): string {
    const lines: string[] = [];
    lines.push(
      '# HELP fanshuye_commands_total Completed HTTP write commands.',
      '# TYPE fanshuye_commands_total counter',
    );
    for (const outcome of commandOutcomes) {
      lines.push(`fanshuye_commands_total{outcome="${outcome}"} ${this.#commands[outcome]}`);
    }

    lines.push(
      '# HELP fanshuye_command_duration_seconds HTTP write command latency.',
      '# TYPE fanshuye_command_duration_seconds histogram',
    );
    for (const outcome of commandOutcomes) {
      appendHistogram(lines, 'fanshuye_command_duration_seconds', this.#commandDurations[outcome], {
        outcome,
      });
    }

    lines.push(
      '# HELP fanshuye_conflicts_total Optimistic-version and atomic-claim conflicts.',
      '# TYPE fanshuye_conflicts_total counter',
    );
    for (const code of conflictCodes) {
      lines.push(`fanshuye_conflicts_total{code="${code}"} ${this.#conflicts[code]}`);
    }

    lines.push(
      '# HELP fanshuye_sync_snapshot_required_total Incremental sync cursors rejected as unavailable.',
      '# TYPE fanshuye_sync_snapshot_required_total counter',
      `fanshuye_sync_snapshot_required_total ${this.#syncSnapshotRequired}`,
      '# HELP fanshuye_sync_snapshot_requests_total Authorized full snapshot rebuild requests.',
      '# TYPE fanshuye_sync_snapshot_requests_total counter',
      `fanshuye_sync_snapshot_requests_total ${this.#snapshotRequests}`,
      '# HELP fanshuye_websocket_connections Current authorized WebSocket connections.',
      '# TYPE fanshuye_websocket_connections gauge',
      `fanshuye_websocket_connections ${this.#websocketConnections}`,
      '# HELP fanshuye_dependency_query_duration_seconds Dependency graph query latency.',
      '# TYPE fanshuye_dependency_query_duration_seconds histogram',
    );
    for (const operation of dependencyOperations) {
      for (const outcome of dependencyOutcomes) {
        const state =
          this.#dependencyDurations.get(dependencyKey(operation, outcome)) ?? newHistogram();
        appendHistogram(lines, 'fanshuye_dependency_query_duration_seconds', state, {
          operation,
          outcome,
        });
      }
    }
    return `${lines.join('\n')}\n`;
  }

  #observeDependency(
    operation: DependencyQueryOperation,
    outcome: DependencyQueryOutcome,
    elapsedMilliseconds: number,
  ): void {
    const key = dependencyKey(operation, outcome);
    let state = this.#dependencyDurations.get(key);
    if (!state) {
      state = newHistogram();
      this.#dependencyDurations.set(key, state);
    }
    observe(state, toSeconds(elapsedMilliseconds));
  }
}

const commandOutcomes: readonly CommandOutcome[] = ['success', 'failure'];
const conflictCodes: readonly ConflictCode[] = ['VERSION_CONFLICT', 'CLAIM_CONFLICT'];
const dependencyOperations: readonly DependencyQueryOperation[] = [
  'prerequisites',
  'dependents',
  'reachability',
  'impact_subgraph',
  'impact_nodes',
];
const dependencyOutcomes: readonly DependencyQueryOutcome[] = ['success', 'failure'];

function newHistogram(): HistogramState {
  return { buckets: DURATION_BUCKETS_SECONDS.map(() => 0), count: 0, sum: 0 };
}

function observe(state: HistogramState, seconds: number): void {
  const safeSeconds = Number.isFinite(seconds) && seconds >= 0 ? seconds : 0;
  state.count += 1;
  state.sum += safeSeconds;
  for (let index = 0; index < DURATION_BUCKETS_SECONDS.length; index += 1) {
    if (safeSeconds <= (DURATION_BUCKETS_SECONDS[index] ?? Number.POSITIVE_INFINITY)) {
      state.buckets[index] = (state.buckets[index] ?? 0) + 1;
    }
  }
}

function appendHistogram(
  lines: string[],
  name: string,
  state: HistogramState,
  labels: Readonly<Record<string, string>>,
): void {
  for (let index = 0; index < DURATION_BUCKETS_SECONDS.length; index += 1) {
    lines.push(
      `${name}_bucket${formatLabels({ ...labels, le: String(DURATION_BUCKETS_SECONDS[index]) })} ${state.buckets[index] ?? 0}`,
    );
  }
  lines.push(`${name}_bucket${formatLabels({ ...labels, le: '+Inf' })} ${state.count}`);
  lines.push(`${name}_sum${formatLabels(labels)} ${state.sum}`);
  lines.push(`${name}_count${formatLabels(labels)} ${state.count}`);
}

function formatLabels(labels: Readonly<Record<string, string>>): string {
  const entries = Object.entries(labels);
  if (!entries.length) return '';
  return `{${entries.map(([key, value]) => `${key}="${value}"`).join(',')}}`;
}

function dependencyKey(
  operation: DependencyQueryOperation,
  outcome: DependencyQueryOutcome,
): string {
  return `${operation}:${outcome}`;
}

function toSeconds(milliseconds: number): number {
  return milliseconds / 1_000;
}
