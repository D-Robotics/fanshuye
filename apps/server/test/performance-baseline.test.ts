import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { migrate } from '../src/db/migrate';
import { createPool, inTransaction, type DatabaseClient, type DatabasePool } from '../src/db/pool';
import { PostgresDependencyRepository } from '../src/modules/dependencies/repository';
import { MetricsRegistry } from '../src/observability/metrics';

const enabled = process.env.PERFORMANCE_BASELINE === '1';
const databaseUrl = process.env.PERF_DATABASE_URL;
if (enabled && !databaseUrl) {
  throw new Error('PERF_DATABASE_URL is required when PERFORMANCE_BASELINE=1');
}
if (enabled && databaseUrl) assertSafeDatabaseTarget(databaseUrl);

const performanceSuite = describe.skipIf(!enabled);
const { Pool } = pg;
const TOTAL_TASKS = 1_000;
const ACTIVE_TASKS = 100;
const DEPENDENCY_EDGES = TOTAL_TASKS - 1;
const DEPENDENCY_DEPTH = 6;
const QUERY_MAX_NODES = 64;
const SUBGRAPH_MAX_NODES = 50;
const QUERY_TIMEOUT_MS = 500;
const QUERY_P95_THRESHOLD_MS = 250;
const QUERY_SAMPLES = 25;

performanceSuite('PostgreSQL dependency performance baseline', () => {
  const schema = `fanshuye_perf_${randomUUID().replaceAll('-', '')}`;
  let administrativePool: InstanceType<typeof Pool>;
  let pool: DatabasePool;
  let repository: PostgresDependencyRepository;
  let workspaceId: string;
  let firstTaskId: string;
  let serverVersion = '';

  beforeAll(async () => {
    administrativePool = new Pool({ connectionString: databaseUrl });
    serverVersion =
      (await administrativePool.query<{ server_version: string }>('SHOW server_version')).rows[0]
        ?.server_version ?? 'unknown';
    await administrativePool.query(`CREATE SCHEMA "${schema}"`);

    const scopedUrl = new URL(databaseUrl!);
    scopedUrl.searchParams.set('options', `-c search_path=${schema},public`);
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: scopedUrl.toString(),
      SESSION_SECRET: 'performance-baseline-secret-that-is-at-least-32-characters',
      LOG_LEVEL: 'silent',
      DEPENDENCY_QUERY_TIMEOUT_MS: String(QUERY_TIMEOUT_MS),
      DEPENDENCY_QUERY_MAX_NODES: String(QUERY_MAX_NODES),
    });
    pool = createPool(config);
    await migrate(pool);
    repository = new PostgresDependencyRepository(pool, config, new MetricsRegistry());

    const seed = await seedPerformanceGraph(pool);
    workspaceId = seed.workspaceId;
    firstTaskId = seed.firstTaskId;
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    if (!administrativePool) return;
    await administrativePool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    const cleanup = await administrativePool.query<{ removed: boolean }>(
      'SELECT to_regnamespace($1) IS NULL AS removed',
      [schema],
    );
    expect(cleanup.rows[0]?.removed).toBe(true);
    console.info(`PERF_POSTGRES_CLEANUP_JSON ${JSON.stringify({ schema, removed: true })}`);
    await administrativePool.end();
  }, 30_000);

  it('limits a 1,000-node layered impact traversal by nodes and statement timeout', async () => {
    const graphCounts = await pool.query<{ total: number; active: number; edges: number }>(
      `SELECT
         (SELECT count(*)::int FROM tasks WHERE workspace_id = $1) AS total,
         (SELECT count(*)::int FROM tasks WHERE workspace_id = $1 AND archived_at IS NULL) AS active,
         (SELECT count(*)::int FROM task_dependencies WHERE workspace_id = $1) AS edges`,
      [workspaceId],
    );
    expect(graphCounts.rows[0]).toEqual({
      total: TOTAL_TASKS,
      active: ACTIVE_TASKS,
      edges: DEPENDENCY_EDGES,
    });

    const configuredNodes = await repository.getImpactNodes(workspaceId, firstTaskId);
    expect(configuredNodes).toHaveLength(QUERY_MAX_NODES);
    expect(Math.max(...configuredNodes.map((node) => node.depth))).toBeGreaterThanOrEqual(3);

    for (let index = 0; index < 3; index += 1) {
      await repository.getImpactSubgraph(workspaceId, firstTaskId, SUBGRAPH_MAX_NODES);
    }
    const samples: number[] = [];
    let lastResult = await repository.getImpactSubgraph(
      workspaceId,
      firstTaskId,
      SUBGRAPH_MAX_NODES,
    );
    for (let sample = 0; sample < QUERY_SAMPLES; sample += 1) {
      const startedAt = performance.now();
      lastResult = await repository.getImpactSubgraph(workspaceId, firstTaskId, SUBGRAPH_MAX_NODES);
      samples.push(performance.now() - startedAt);
    }

    const metrics = summarize(samples);
    expect(lastResult.taskIds).toHaveLength(SUBGRAPH_MAX_NODES);
    expect(lastResult.truncated).toBe(true);
    expect(metrics.p95Ms).toBeLessThanOrEqual(QUERY_P95_THRESHOLD_MS);

    const timeoutProof = await proveStatementTimeout(pool, repository, workspaceId, firstTaskId);
    expect(timeoutProof.setting).toBe(`${QUERY_TIMEOUT_MS}ms`);
    expect(timeoutProof.errorCode).toBe('57014');
    expect(timeoutProof.elapsedMs).toBeLessThan(QUERY_TIMEOUT_MS * 3);

    console.info(
      `PERF_POSTGRES_JSON ${JSON.stringify({
        postgresVersion: serverVersion,
        totalTasks: graphCounts.rows[0]?.total,
        activeTasks: graphCounts.rows[0]?.active,
        dependencyEdges: graphCounts.rows[0]?.edges,
        dependencyDepth: DEPENDENCY_DEPTH,
        configuredMaxNodes: QUERY_MAX_NODES,
        returnedConfiguredNodes: configuredNodes.length,
        subgraphMaxNodes: SUBGRAPH_MAX_NODES,
        returnedSubgraphNodes: lastResult.taskIds.length,
        truncated: lastResult.truncated,
        samples: QUERY_SAMPLES,
        p50Ms: metrics.p50Ms,
        p95Ms: metrics.p95Ms,
        maxMs: metrics.maxMs,
        p95ThresholdMs: QUERY_P95_THRESHOLD_MS,
        statementTimeoutMs: QUERY_TIMEOUT_MS,
        timeoutErrorCode: timeoutProof.errorCode,
        timeoutObservedMs: timeoutProof.elapsedMs,
        isolatedSchema: schema,
        passed: true,
      })}`,
    );
  }, 30_000);
});

async function seedPerformanceGraph(
  pool: DatabasePool,
): Promise<{ workspaceId: string; firstTaskId: string }> {
  return inTransaction(pool, async (client) => {
    const actorId = randomUUID();
    const workspaceId = randomUUID();
    const treeId = randomUUID();
    const workstreamId = randomUUID();
    await client.query(
      `INSERT INTO users(id, email, display_name, email_verified_at)
         VALUES ($1, $2, 'Performance Owner', clock_timestamp())`,
      [actorId, `performance-${actorId}@fanshuye.test`],
    );
    await client.query(
      `INSERT INTO workspaces(id, name, timezone, created_by)
         VALUES ($1, 'Performance Baseline', 'Asia/Shanghai', $2)`,
      [workspaceId, actorId],
    );
    await client.query(
      `INSERT INTO workspace_memberships(workspace_id, user_id, role)
         VALUES ($1, $2, 'ADMIN')`,
      [workspaceId, actorId],
    );
    await client.query('INSERT INTO workspace_sync_state(workspace_id) VALUES ($1)', [workspaceId]);
    await client.query(
      `INSERT INTO task_trees(id, workspace_id, name)
         VALUES ($1, $2, 'Performance Tree')`,
      [treeId, workspaceId],
    );
    await client.query(
      `INSERT INTO workstreams(id, workspace_id, tree_id, name)
         VALUES ($1, $2, $3, 'Performance Workstream')`,
      [workstreamId, workspaceId, treeId],
    );

    const inserted = await client.query<{ id: string; title: string }>(
      `INSERT INTO tasks(
         id, workspace_id, tree_id, workstream_id, title, owner_id, status, importance,
         due_at, archived_at, created_by
       )
       SELECT
         gen_random_uuid(), $1, $2, $3,
         'Performance task ' || lpad(sequence::text, 4, '0'),
         CASE WHEN sequence <= $4 AND sequence % 4 <> 0 THEN $5::uuid ELSE NULL END,
         CASE
           WHEN sequence > $4 THEN 'DONE'
           WHEN sequence % 3 = 0 THEN 'IN_REVIEW'
           WHEN sequence % 3 = 1 THEN 'TODO'
           ELSE 'IN_PROGRESS'
         END,
         ((sequence - 1) % 5) + 1,
         CASE WHEN sequence <= $4 THEN clock_timestamp() + (sequence || ' hours')::interval END,
         CASE WHEN sequence > $4 THEN clock_timestamp() END,
         $5
       FROM generate_series(1, $6) AS sequence
       RETURNING id, title`,
      [workspaceId, treeId, workstreamId, ACTIVE_TASKS, actorId, TOTAL_TASKS],
    );
    const taskIds = inserted.rows
      .sort((left, right) => left.title.localeCompare(right.title))
      .map((row) => row.id);
    const firstTaskId = taskIds[0];
    if (!firstTaskId || taskIds.length !== TOTAL_TASKS) {
      throw new Error(`Expected ${TOTAL_TASKS} seeded tasks, received ${taskIds.length}`);
    }

    const dependentTaskIds = taskIds.slice(1);
    const prerequisiteTaskIds = dependentTaskIds.map((_, dependentOffset) => {
      const dependentIndex = dependentOffset + 1;
      return taskIds[Math.floor((dependentIndex - 1) / 3)]!;
    });
    await client.query(
      `INSERT INTO task_dependencies(
         workspace_id, prerequisite_task_id, dependent_task_id, created_by
       )
       SELECT $1, edge.prerequisite_task_id, edge.dependent_task_id, $4
         FROM unnest($2::uuid[], $3::uuid[])
           AS edge(prerequisite_task_id, dependent_task_id)`,
      [workspaceId, prerequisiteTaskIds, dependentTaskIds, actorId],
    );
    return { workspaceId, firstTaskId };
  });
}

async function proveStatementTimeout(
  pool: DatabasePool,
  repository: PostgresDependencyRepository,
  workspaceId: string,
  taskId: string,
): Promise<{ setting: string; errorCode: string | undefined; elapsedMs: number }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await repository.getImpactSubgraph(workspaceId, taskId, 10, client);
    const setting = (
      await client.query<{ setting: string }>(
        "SELECT current_setting('statement_timeout') AS setting",
      )
    ).rows[0]?.setting;
    if (!setting) throw new Error('statement_timeout setting was unavailable');

    const startedAt = performance.now();
    let errorCode: string | undefined;
    try {
      await client.query('SELECT pg_sleep(2)');
    } catch (error) {
      errorCode = postgresErrorCode(error);
    }
    const elapsedMs = round(performance.now() - startedAt);
    await client.query('ROLLBACK');
    return { setting, errorCode, elapsedMs };
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  } finally {
    client.release();
  }
}

async function rollbackQuietly(client: DatabaseClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // The connection will be released and discarded if PostgreSQL cannot recover it.
  }
}

function postgresErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
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

function assertSafeDatabaseTarget(url: string): void {
  const hostname = new URL(url).hostname;
  const local = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
  if (!local.has(hostname) && process.env.PERF_ALLOW_REMOTE_DATABASE !== '1') {
    throw new Error(
      'Refusing a remote performance database; set PERF_ALLOW_REMOTE_DATABASE=1 only for an isolated test PostgreSQL instance',
    );
  }
}
