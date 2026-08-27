import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import type { DatabasePool } from '../src/db/pool';
import { PostgresDependencyRepository } from '../src/modules/dependencies/repository';
import { EventHub, type RealtimeSocket } from '../src/modules/sync/event-hub';
import { MetricsRegistry } from '../src/observability/metrics';

const metricsToken = 'metrics-test-token-that-is-longer-than-32-characters';
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('bounded operational metrics', () => {
  it('renders every required signal without caller-provided or sensitive labels', async () => {
    const metrics = new MetricsRegistry();
    metrics.recordCommand('success', 12);
    metrics.recordCommand('failure', 24);
    metrics.recordConflict('VERSION_CONFLICT');
    metrics.recordConflict('CLAIM_CONFLICT');
    metrics.recordSyncSnapshotRequired();
    metrics.recordSnapshotRequest();
    metrics.setWebsocketConnections(3);
    await metrics.measureDependencyQuery('reachability', async () => true);
    await expect(
      metrics.measureDependencyQuery('impact_nodes', async () => {
        throw new Error('private workspace 321 and task 654');
      }),
    ).rejects.toThrow('private workspace');

    const output = metrics.renderPrometheus();
    expect(output).toContain('fanshuye_commands_total{outcome="success"} 1');
    expect(output).toContain('fanshuye_commands_total{outcome="failure"} 1');
    expect(output).toContain('fanshuye_command_duration_seconds_count{outcome="failure"} 1');
    expect(output).toContain('fanshuye_conflicts_total{code="VERSION_CONFLICT"} 1');
    expect(output).toContain('fanshuye_conflicts_total{code="CLAIM_CONFLICT"} 1');
    expect(output).toContain('fanshuye_sync_snapshot_required_total 1');
    expect(output).toContain('fanshuye_sync_snapshot_requests_total 1');
    expect(output).toContain('fanshuye_websocket_connections 3');
    expect(output).toContain(
      'fanshuye_dependency_query_duration_seconds_count{operation="reachability",outcome="success"} 1',
    );
    expect(output).toContain(
      'fanshuye_dependency_query_duration_seconds_count{operation="impact_nodes",outcome="failure"} 1',
    );
    expect(output).not.toContain('private workspace 321');
    expect(output).not.toContain('task 654');
  });

  it('tracks the authorized WebSocket gauge through subscribe and unsubscribe', () => {
    const metrics = new MetricsRegistry();
    const hub = new EventHub();
    hub.setConnectionObserver((count) => metrics.setWebsocketConnections(count));
    const socket = { readyState: 1, send: vi.fn(), close: vi.fn() } satisfies RealtimeSocket;
    const unsubscribe = hub.subscribe({
      workspaceId: 'workspace-secret',
      userId: 'user-secret',
      sessionId: 'session-secret',
      socket,
    });
    expect(metrics.renderPrometheus()).toContain('fanshuye_websocket_connections 1');
    expect(metrics.renderPrometheus()).not.toContain('workspace-secret');

    unsubscribe();
    unsubscribe();
    expect(metrics.renderPrometheus()).toContain('fanshuye_websocket_connections 0');
  });

  it('records dependency repository successes and failures with fixed operations', async () => {
    const metrics = new MetricsRegistry();
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockRejectedValueOnce(new Error('database detail that must not become a label'));
    const pool = { query } as unknown as DatabasePool;
    const repository = new PostgresDependencyRepository(
      pool,
      { DEPENDENCY_QUERY_TIMEOUT_MS: 1_500, DEPENDENCY_QUERY_MAX_NODES: 250 },
      metrics,
    );

    await expect(repository.getPrerequisiteDetails('workspace-a', 'task-a')).resolves.toEqual([]);
    await expect(repository.getDependentDetails('workspace-a', 'task-a')).rejects.toThrow(
      'database detail',
    );
    const output = metrics.renderPrometheus();
    expect(output).toContain(
      'fanshuye_dependency_query_duration_seconds_count{operation="prerequisites",outcome="success"} 1',
    );
    expect(output).toContain(
      'fanshuye_dependency_query_duration_seconds_count{operation="dependents",outcome="failure"} 1',
    );
    expect(output).not.toContain('database detail');
  });
});

describe('metrics endpoint', () => {
  it('requires its dedicated bearer token and counts failed write commands', async () => {
    const metrics = new MetricsRegistry();
    const app = await createTestApp(metrics, metricsToken);

    const unauthenticated = await app.inject({ method: 'GET', url: '/internal/metrics' });
    expect(unauthenticated.statusCode).toBe(401);
    const wrongToken = await app.inject({
      method: 'GET',
      url: '/internal/metrics',
      headers: { authorization: `Bearer ${'x'.repeat(metricsToken.length)}` },
    });
    expect(wrongToken.statusCode).toBe(401);

    const invalidCommand = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {},
    });
    expect(invalidCommand.statusCode).toBe(422);

    const response = await app.inject({
      method: 'GET',
      url: '/internal/metrics',
      headers: { authorization: `Bearer ${metricsToken}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toContain('fanshuye_commands_total{outcome="failure"} 1');
  });

  it('is not exposed when no metrics token is configured', async () => {
    const app = await createTestApp(new MetricsRegistry());
    const response = await app.inject({ method: 'GET', url: '/internal/metrics' });
    expect(response.statusCode).toBe(404);
  });
});

async function createTestApp(
  metrics: MetricsRegistry,
  token?: string,
): Promise<Awaited<ReturnType<typeof buildApp>>> {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/fanshuye_metrics_test',
    SESSION_SECRET: 'metrics-test-session-secret-at-least-32-characters',
    LOG_LEVEL: 'silent',
    ...(token ? { METRICS_TOKEN: token } : {}),
  });
  const pool = {
    query: vi.fn(),
    connect: vi.fn(),
    end: vi.fn(),
  } as unknown as DatabasePool;
  const app = await buildApp({ config, pool, metrics });
  apps.push(app);
  return app;
}
