import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { loadConfig, type AppConfig } from '../src/config';
import { migrate } from '../src/db/migrate';
import { createPool, type DatabasePool } from '../src/db/pool';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = describe.skipIf(!databaseUrl);
const { Pool } = pg;
const metricsToken = 'postgres-integration-metrics-token-at-least-32-characters';

suite('PostgreSQL collaboration guarantees', () => {
  let administrativePool: InstanceType<typeof Pool>;
  let pool: DatabasePool;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let config: AppConfig;
  const schema = `fanshuye_test_${randomUUID().replaceAll('-', '')}`;

  beforeAll(async () => {
    if (!databaseUrl) return;
    administrativePool = new Pool({ connectionString: databaseUrl });
    await administrativePool.query(`CREATE SCHEMA "${schema}"`);
    const scopedUrl = new URL(databaseUrl);
    scopedUrl.searchParams.set('options', `-c search_path=${schema},public`);
    config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: scopedUrl.toString(),
      SESSION_SECRET: 'integration-test-secret-that-is-at-least-32-characters',
      LOG_LEVEL: 'silent',
      METRICS_TOKEN: metricsToken,
    });
    pool = createPool(config);
    await migrate(pool);
    app = await buildApp({ config, pool });
  });

  afterAll(async () => {
    if (!databaseUrl) return;
    await app?.close();
    await pool?.end();
    await administrativePool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await administrativePool.end();
  });

  it('rolls back workspace, membership, tree, workstream, event and idempotency rows together', async () => {
    const admin = await createUser('rollback.integration@fanshuye.test', 'Rollback Admin');
    const commandId = randomUUID();
    const before = await workspaceGraphCounts();

    await pool.query(`
      CREATE FUNCTION fail_default_workstream_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.name = '默认工作流' THEN
          RAISE EXCEPTION 'forced default workstream failure';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await pool.query(`
      CREATE TRIGGER fail_default_workstream_insert
      BEFORE INSERT ON workstreams
      FOR EACH ROW EXECUTE FUNCTION fail_default_workstream_insert()
    `);

    try {
      const failed = await app.inject({
        method: 'POST',
        url: '/v1/workspaces',
        headers: bearer(admin.accessToken),
        payload: {
          commandId,
          name: 'Must roll back completely',
          timezone: 'Asia/Shanghai',
        },
      });
      expect(failed.statusCode).toBe(500);
      expect(failed.json().error.code).toBe('INTERNAL_ERROR');
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS fail_default_workstream_insert ON workstreams`);
      await pool.query(`DROP FUNCTION IF EXISTS fail_default_workstream_insert()`);
    }

    expect(await workspaceGraphCounts()).toEqual(before);
    const leakedCommand = await pool.query(
      `SELECT 1 FROM processed_commands WHERE command_id = $1`,
      [commandId],
    );
    expect(leakedCommand.rowCount).toBe(0);
  });

  it('isolates workspaces, replays commands, detects cycles and admits exactly one claimant', async () => {
    const admin = await createUser('admin.integration@fanshuye.test', 'Admin');
    const member = await createUser('member.integration@fanshuye.test', 'Member');

    const workspaceResponse = await app.inject({
      method: 'POST',
      url: '/v1/workspaces',
      headers: bearer(admin.accessToken),
      payload: { commandId: randomUUID(), name: 'Integration team', timezone: 'Asia/Shanghai' },
    });
    expect(workspaceResponse.statusCode).toBe(201);
    const workspaceId = workspaceResponse.json().workspace.id as string;

    const inviteResponse = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/invitations`,
      headers: bearer(admin.accessToken),
      payload: {
        commandId: randomUUID(),
        email: 'member.integration@fanshuye.test',
        role: 'MEMBER',
      },
    });
    expect(inviteResponse.statusCode).toBe(201);
    const invitationToken = inviteResponse.json().invitation.token as string;
    const accepted = await app.inject({
      method: 'POST',
      url: '/v1/workspace-invitations/accept',
      headers: bearer(member.accessToken),
      payload: { commandId: randomUUID(), token: invitationToken },
    });
    expect(accepted.statusCode).toBe(200);

    const createCommandId = randomUUID();
    const taskPayload = { commandId: createCommandId, title: 'Atomically claimed task' };
    const created = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/tasks`,
      headers: bearer(admin.accessToken),
      payload: taskPayload,
    });
    const replayed = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/tasks`,
      headers: bearer(admin.accessToken),
      payload: taskPayload,
    });
    expect(created.statusCode).toBe(201);
    expect(replayed.statusCode).toBe(201);
    expect(replayed.json().task.id).toBe(created.json().task.id);
    const taskId = created.json().task.id as string;

    const claims = await Promise.all([
      app.inject({
        method: 'POST',
        url: `/v1/workspaces/${workspaceId}/tasks/${taskId}/commands`,
        headers: bearer(admin.accessToken),
        payload: { type: 'StartTask', commandId: randomUUID(), expectedVersion: 1 },
      }),
      app.inject({
        method: 'POST',
        url: `/v1/workspaces/${workspaceId}/tasks/${taskId}/commands`,
        headers: bearer(member.accessToken),
        payload: { type: 'StartTask', commandId: randomUUID(), expectedVersion: 1 },
      }),
    ]);
    expect(claims.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const authoritative = await app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/tasks/${taskId}`,
      headers: bearer(admin.accessToken),
    });
    expect(authoritative.json().task.status).toBe('IN_PROGRESS');
    expect(authoritative.json().task.owner).not.toBeNull();

    const stale = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/tasks/${taskId}/commands`,
      headers: bearer(admin.accessToken),
      payload: {
        type: 'SetImportance',
        commandId: randomUUID(),
        expectedVersion: 1,
        importance: 5,
      },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('VERSION_CONFLICT');
    expect(stale.json().error.details.task.version).toBe(2);

    const preownedTask = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/tasks`,
      headers: bearer(admin.accessToken),
      payload: {
        commandId: randomUUID(),
        title: 'Preowned claim conflict task',
        ownerId: admin.userId,
      },
    });
    expect(preownedTask.statusCode).toBe(201);
    const deterministicClaimConflict = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/tasks/${preownedTask.json().task.id as string}/commands`,
      headers: bearer(member.accessToken),
      payload: { type: 'StartTask', commandId: randomUUID(), expectedVersion: 1 },
    });
    expect(deterministicClaimConflict.statusCode).toBe(409);
    expect(deterministicClaimConflict.json().error.code).toBe('CLAIM_CONFLICT');

    const preownedTaskId = preownedTask.json().task.id as string;
    const forbiddenDirectTransfer = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/tasks/${preownedTaskId}/commands`,
      headers: bearer(member.accessToken),
      payload: {
        type: 'TransferOwner',
        commandId: randomUUID(),
        expectedVersion: 1,
        ownerId: member.userId,
      },
    });
    expect(forbiddenDirectTransfer.statusCode).toBe(403);

    const forbiddenAddOtherMember = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/tasks/${preownedTaskId}/commands`,
      headers: bearer(member.accessToken),
      payload: {
        type: 'AddCollaborator',
        commandId: randomUUID(),
        expectedVersion: 1,
        userId: admin.userId,
      },
    });
    expect(forbiddenAddOtherMember.statusCode).toBe(403);

    const requestOnlyTask = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/tasks`,
      headers: bearer(admin.accessToken),
      payload: {
        commandId: randomUUID(),
        title: 'Takeover request from a non-participant',
        ownerId: admin.userId,
      },
    });
    const requestedByNonParticipant = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/tasks/${requestOnlyTask.json().task.id as string}/commands`,
      headers: bearer(member.accessToken),
      payload: {
        type: 'RequestOwnerTransfer',
        commandId: randomUUID(),
        expectedVersion: 1,
      },
    });
    expect(requestedByNonParticipant.statusCode).toBe(200);
    expect(requestedByNonParticipant.json().task).toMatchObject({
      version: 2,
      owner: { id: admin.userId },
      collaborators: [],
    });

    const joinCommandId = randomUUID();
    const joinPayload = {
      type: 'AddCollaborator',
      commandId: joinCommandId,
      expectedVersion: 1,
      userId: member.userId,
    };
    const joined = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/tasks/${preownedTaskId}/commands`,
      headers: bearer(member.accessToken),
      payload: joinPayload,
    });
    const replayedJoin = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/tasks/${preownedTaskId}/commands`,
      headers: bearer(member.accessToken),
      payload: joinPayload,
    });
    expect(joined.statusCode).toBe(200);
    expect(replayedJoin.statusCode).toBe(200);
    expect(replayedJoin.json()).toEqual(joined.json());
    expect(joined.json().task).toMatchObject({
      version: 2,
      owner: { id: admin.userId },
    });
    expect(joined.json().task.collaborators).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: member.userId })]),
    );

    const requestTransferCommandId = randomUUID();
    const requestTransferPayload = {
      type: 'RequestOwnerTransfer',
      commandId: requestTransferCommandId,
      expectedVersion: 2,
    };
    const requestedTransfer = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/tasks/${preownedTaskId}/commands`,
      headers: bearer(member.accessToken),
      payload: requestTransferPayload,
    });
    const replayedTransferRequest = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/tasks/${preownedTaskId}/commands`,
      headers: bearer(member.accessToken),
      payload: requestTransferPayload,
    });
    expect(requestedTransfer.statusCode).toBe(200);
    expect(replayedTransferRequest.statusCode).toBe(200);
    expect(replayedTransferRequest.json()).toEqual(requestedTransfer.json());
    expect(requestedTransfer.json().task).toMatchObject({
      version: 3,
      owner: { id: admin.userId },
    });

    const collaborationEvents = await pool.query<{
      event_type: string;
      actor_id: string;
      aggregate_version: number;
      payload: Record<string, unknown>;
    }>(
      `SELECT event_type, actor_id, aggregate_version, payload
         FROM task_events
        WHERE workspace_id = $1 AND aggregate_id = $2
          AND event_type IN ('TaskCollaboratorAdded', 'TaskOwnerTransferRequested')
        ORDER BY workspace_sequence`,
      [workspaceId, preownedTaskId],
    );
    expect(collaborationEvents.rows).toEqual([
      expect.objectContaining({
        event_type: 'TaskCollaboratorAdded',
        actor_id: member.userId,
        aggregate_version: 2,
        payload: { collaboratorId: member.userId },
      }),
      expect.objectContaining({
        event_type: 'TaskOwnerTransferRequested',
        actor_id: member.userId,
        aggregate_version: 3,
        payload: { requesterId: member.userId, currentOwnerId: admin.userId },
      }),
    ]);

    const transferRequestDelta = await app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/sync/events?after=${(
        (joined.json().cursor as number) ?? 0
      ).toString()}`,
      headers: bearer(member.accessToken),
    });
    expect(transferRequestDelta.statusCode).toBe(200);
    expect(transferRequestDelta.json().events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: 'TaskOwnerTransferRequested',
          aggregateId: preownedTaskId,
          aggregateVersion: 3,
        }),
      ]),
    );

    const [directA, directB] = await Promise.all([
      createTask(workspaceId, admin.accessToken, 'Direct cycle A'),
      createTask(workspaceId, admin.accessToken, 'Direct cycle B'),
    ]);
    await addDependency(workspaceId, admin.accessToken, directB.id, directA.id, directB.version);
    const directCycle = await addDependencyRequest(
      workspaceId,
      admin.accessToken,
      directA.id,
      directB.id,
      directA.version,
    );
    expect(directCycle.statusCode).toBe(409);
    expect(directCycle.json().error.code).toBe('DEPENDENCY_CYCLE');

    const [taskA, taskB, taskC] = await Promise.all([
      createTask(workspaceId, admin.accessToken, 'Indirect cycle A'),
      createTask(workspaceId, admin.accessToken, 'Indirect cycle B'),
      createTask(workspaceId, admin.accessToken, 'Indirect cycle C'),
    ]);
    await addDependency(workspaceId, admin.accessToken, taskB.id, taskA.id, taskB.version);
    await addDependency(workspaceId, admin.accessToken, taskC.id, taskB.id, taskC.version);
    const indirectCycle = await addDependencyRequest(
      workspaceId,
      admin.accessToken,
      taskA.id,
      taskC.id,
      taskA.version,
    );
    expect(indirectCycle.statusCode).toBe(409);
    expect(indirectCycle.json().error.code).toBe('DEPENDENCY_CYCLE');

    const [concurrentA, concurrentB, concurrentC] = await Promise.all([
      createTask(workspaceId, admin.accessToken, 'Concurrent cycle A'),
      createTask(workspaceId, admin.accessToken, 'Concurrent cycle B'),
      createTask(workspaceId, admin.accessToken, 'Concurrent cycle C'),
    ]);
    await addDependency(
      workspaceId,
      admin.accessToken,
      concurrentB.id,
      concurrentA.id,
      concurrentB.version,
    );
    const concurrentEdges = await Promise.all([
      addDependencyRequest(
        workspaceId,
        admin.accessToken,
        concurrentC.id,
        concurrentB.id,
        concurrentC.version,
      ),
      addDependencyRequest(
        workspaceId,
        admin.accessToken,
        concurrentA.id,
        concurrentC.id,
        concurrentA.version,
      ),
    ]);
    expect(concurrentEdges.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const rejectedConcurrentEdge = concurrentEdges.find((response) => response.statusCode === 409);
    expect(rejectedConcurrentEdge?.json().error.code).toBe('DEPENDENCY_CYCLE');
    const committedConcurrentEdges = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM task_dependencies
        WHERE workspace_id = $1
          AND prerequisite_task_id = ANY($2::uuid[])
          AND dependent_task_id = ANY($2::uuid[])`,
      [workspaceId, [concurrentA.id, concurrentB.id, concurrentC.id]],
    );
    expect(committedConcurrentEdges.rows[0]?.count).toBe(2);

    const otherWorkspace = await app.inject({
      method: 'POST',
      url: '/v1/workspaces',
      headers: bearer(admin.accessToken),
      payload: { commandId: randomUUID(), name: 'Private workspace', timezone: 'UTC' },
    });
    const otherWorkspaceId = otherWorkspace.json().workspace.id as string;
    const privateTask = await createTask(otherWorkspaceId, admin.accessToken, 'Private task');
    const leaked = await app.inject({
      method: 'GET',
      url: `/v1/workspaces/${otherWorkspaceId}/tasks/${privateTask.id}`,
      headers: bearer(member.accessToken),
    });
    expect(leaked.statusCode).toBe(403);
    expect(leaked.body).not.toContain('Private task');

    const snapshot = await app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/sync/snapshot`,
      headers: bearer(member.accessToken),
    });
    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.json()).not.toHaveProperty('leafCoordinates');
    const delta = await app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/sync/events?after=0`,
      headers: bearer(member.accessToken),
    });
    expect(delta.statusCode).toBe(200);
    expect(delta.json().events.length).toBeGreaterThan(0);

    const metrics = await app.inject({
      method: 'GET',
      url: '/internal/metrics',
      headers: { authorization: `Bearer ${metricsToken}` },
    });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.body).toMatch(/fanshuye_conflicts_total\{code="CLAIM_CONFLICT"\} [1-9]/);
    expect(metrics.body).toMatch(/fanshuye_conflicts_total\{code="VERSION_CONFLICT"\} [1-9]/);
    expect(metrics.body).toMatch(
      /fanshuye_dependency_query_duration_seconds_count\{operation="reachability",outcome="success"\} [1-9]/,
    );
  });

  async function createUser(
    email: string,
    displayName: string,
  ): Promise<{ accessToken: string; userId: string }> {
    const registration = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email, displayName, password: 'IntegrationPassword2026!' },
    });
    expect(registration.statusCode).toBe(201);
    const verificationToken = registration.json().verificationToken as string;
    const verification = await app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      payload: { token: verificationToken },
    });
    expect(verification.statusCode).toBe(200);
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email, password: 'IntegrationPassword2026!' },
    });
    expect(login.statusCode).toBe(200);
    return {
      accessToken: login.json().accessToken as string,
      userId: registration.json().userId as string,
    };
  }

  async function createTask(
    workspaceId: string,
    accessToken: string,
    title: string,
  ): Promise<{ id: string; version: number }> {
    const response = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/tasks`,
      headers: bearer(accessToken),
      payload: { commandId: randomUUID(), title },
    });
    expect(response.statusCode).toBe(201);
    return {
      id: response.json().task.id as string,
      version: response.json().task.version as number,
    };
  }

  async function addDependency(
    workspaceId: string,
    accessToken: string,
    dependentTaskId: string,
    prerequisiteTaskId: string,
    expectedVersion: number,
  ): Promise<void> {
    const response = await addDependencyRequest(
      workspaceId,
      accessToken,
      dependentTaskId,
      prerequisiteTaskId,
      expectedVersion,
    );
    expect(response.statusCode).toBe(200);
  }

  async function addDependencyRequest(
    workspaceId: string,
    accessToken: string,
    dependentTaskId: string,
    prerequisiteTaskId: string,
    expectedVersion: number,
  ) {
    return app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/tasks/${dependentTaskId}/commands`,
      headers: bearer(accessToken),
      payload: {
        type: 'AddDependency',
        commandId: randomUUID(),
        expectedVersion,
        prerequisiteTaskId,
      },
    });
  }

  async function workspaceGraphCounts(): Promise<Record<string, number>> {
    const result = await pool.query<{
      workspaces: number;
      memberships: number;
      trees: number;
      workstreams: number;
      events: number;
      commands: number;
    }>(`
      SELECT
        (SELECT count(*)::int FROM workspaces) AS workspaces,
        (SELECT count(*)::int FROM workspace_memberships) AS memberships,
        (SELECT count(*)::int FROM task_trees) AS trees,
        (SELECT count(*)::int FROM workstreams) AS workstreams,
        (SELECT count(*)::int FROM task_events) AS events,
        (SELECT count(*)::int FROM processed_commands) AS commands
    `);
    const row = result.rows[0];
    if (!row) throw new Error('Workspace graph counts are unavailable');
    return row;
  }
});

function bearer(accessToken: string): { authorization: string } {
  return { authorization: `Bearer ${accessToken}` };
}
