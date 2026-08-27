import { randomUUID } from 'node:crypto';
import {
  canTransition,
  type DependencyCommandPort,
  type DependencyQueryPort,
} from '@fanshuye/domain';
import type { DatabaseClient, DatabasePool } from '../../db/pool';
import { inTransaction } from '../../db/pool';
import { ApiError } from '../../lib/errors';
import { isSafeExternalUrl } from '../../lib/security';
import {
  appendEvent,
  findProcessedCommand,
  lockCommand,
  storeProcessedCommand,
} from '../audit/events';
import type { AuthContext } from '../common/auth-context';
import { requireActiveWorkspaceUser, requireMembership, type Membership } from '../common/access';
import type { EventEnvelope, EventHub } from '../sync/event-hub';
import {
  loadTaskSnapshot,
  mapTaskProjection,
  taskProjectionSql,
  type TaskProjectionRow,
  type TaskSnapshot,
} from './projection';
import type { CreateTaskInput, TaskCommand } from './schemas';

interface ListQuery {
  search?: string | undefined;
  status?: 'TODO' | 'IN_PROGRESS' | 'IN_REVIEW' | 'DONE' | 'CANCELED' | undefined;
  ownerId?: string | undefined;
  workstreamId?: string | undefined;
  active: boolean;
  limit: number;
  offset: number;
}

export class TaskService {
  public constructor(
    private readonly pool: DatabasePool,
    private readonly dependencyCommands: DependencyCommandPort<DatabaseClient>,
    private readonly dependencyQueries: DependencyQueryPort<DatabaseClient>,
    private readonly eventHub: EventHub,
  ) {}

  async list(
    auth: AuthContext,
    workspaceId: string,
    query: ListQuery,
  ): Promise<Record<string, unknown>> {
    await requireMembership(this.pool, workspaceId, auth.userId);
    const parameters: unknown[] = [workspaceId];
    const conditions = ['t.workspace_id = $1'];
    if (query.active) conditions.push('t.archived_at IS NULL');
    if (query.search) {
      parameters.push(`%${escapeLike(query.search.toLowerCase())}%`);
      conditions.push(`lower(t.title) LIKE $${parameters.length} ESCAPE '\\'`);
    }
    if (query.status) {
      parameters.push(query.status);
      conditions.push(`t.status = $${parameters.length}`);
    }
    if (query.ownerId) {
      parameters.push(query.ownerId);
      conditions.push(`t.owner_id = $${parameters.length}`);
    }
    if (query.workstreamId) {
      parameters.push(query.workstreamId);
      conditions.push(`t.workstream_id = $${parameters.length}`);
    }
    parameters.push(query.limit, query.offset);
    const result = await this.pool.query<TaskProjectionRow>(
      `${taskProjectionSql(conditions.join(' AND '))}
       ORDER BY
         CASE
           WHEN t.action_override IS NOT NULL AND t.action_override_expires_at > clock_timestamp()
             THEN CASE t.action_override WHEN 'NOW' THEN 0 WHEN 'NEXT' THEN 1 ELSE 2 END
           WHEN t.due_at <= clock_timestamp() + interval '24 hours' THEN 0
           WHEN t.due_at <= clock_timestamp() + interval '7 days' OR t.importance >= 4 THEN 1
           ELSE 2
         END,
         t.manual_order NULLS LAST,
         t.due_at NULLS LAST,
         t.importance DESC,
         t.id
       LIMIT $${parameters.length - 1} OFFSET $${parameters.length}`,
      parameters,
    );
    return {
      tasks: result.rows.map((row) => mapTaskProjection(row)),
      page: { limit: query.limit, offset: query.offset, returned: result.rowCount ?? 0 },
    };
  }

  async get(auth: AuthContext, workspaceId: string, taskId: string): Promise<TaskSnapshot> {
    await requireMembership(this.pool, workspaceId, auth.userId);
    return loadTaskSnapshot(this.pool, workspaceId, taskId);
  }

  async findSimilar(
    auth: AuthContext,
    workspaceId: string,
    title: string,
    limit: number,
  ): Promise<unknown[]> {
    await requireMembership(this.pool, workspaceId, auth.userId);
    const normalized = title.trim().toLowerCase();
    if (normalized.length < 2) return [];
    const result = await this.pool.query<{
      id: string;
      title: string;
      status: string;
      owner_id: string | null;
      owner_display_name: string | null;
      score: number;
    }>(
      `SELECT t.id, t.title, t.status, t.owner_id, u.display_name AS owner_display_name,
              CASE
                WHEN lower(t.title) = $2 THEN 100
                WHEN lower(t.title) LIKE $2 || '%' THEN 80
                WHEN lower(t.title) LIKE '%' || $2 || '%' THEN 60
                ELSE 0
              END AS score
         FROM tasks t
         LEFT JOIN users u ON u.id = t.owner_id
        WHERE t.workspace_id = $1 AND t.archived_at IS NULL
          AND lower(t.title) LIKE '%' || $2 || '%'
        ORDER BY score DESC, lower(t.title), t.id
        LIMIT $3`,
      [workspaceId, normalized, limit],
    );
    return result.rows.map((row) => ({
      id: row.id,
      title: row.title,
      status: row.status,
      owner: row.owner_id ? { id: row.owner_id, displayName: row.owner_display_name } : null,
      matchScore: row.score,
    }));
  }

  async create(
    auth: AuthContext,
    workspaceId: string,
    input: CreateTaskInput,
  ): Promise<Record<string, unknown>> {
    const correlationId = randomUUID();
    const result = await inTransaction(this.pool, async (client) => {
      await requireMembership(client, workspaceId, auth.userId);
      await lockCommand(client, auth.userId, input.commandId);
      const replay = await findProcessedCommand(
        client,
        workspaceId,
        input.commandId,
        auth.userId,
        'CreateTask',
      );
      if (replay) return { response: replay.body, events: [] as EventEnvelope[] };
      if (input.ownerId) await requireActiveWorkspaceUser(client, workspaceId, input.ownerId);
      const collaboratorIds = [...new Set(input.collaboratorIds)].filter(
        (id) => id !== input.ownerId,
      );
      for (const collaboratorId of collaboratorIds) {
        await requireActiveWorkspaceUser(client, workspaceId, collaboratorId);
      }

      const placement = await client.query<{ tree_id: string; workstream_id: string }>(
        `SELECT tt.id AS tree_id, ws.id AS workstream_id
           FROM task_trees tt
           JOIN workstreams ws ON ws.tree_id = tt.id AND ws.workspace_id = tt.workspace_id
          WHERE tt.workspace_id = $1 AND ($2::uuid IS NULL OR ws.id = $2)
          ORDER BY CASE WHEN $2::uuid IS NOT NULL AND ws.id = $2 THEN 0 ELSE 1 END, ws.sort_order, ws.id
          LIMIT 1`,
        [workspaceId, input.workstreamId ?? null],
      );
      const location = placement.rows[0];
      if (!location)
        throw new ApiError(422, 'VALIDATION_ERROR', 'Workspace has no usable task workstream');

      const inserted = await client.query<{ id: string; version: number }>(
        `INSERT INTO tasks(
           workspace_id, tree_id, workstream_id, title, description, definition_of_done,
           owner_id, importance, due_at, created_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING id, version`,
        [
          workspaceId,
          location.tree_id,
          location.workstream_id,
          input.title,
          input.description,
          input.definitionOfDone,
          input.ownerId,
          input.importance,
          input.dueAt,
          auth.userId,
        ],
      );
      const task = inserted.rows[0];
      if (!task) throw new Error('Task creation did not return a row');
      for (const collaboratorId of collaboratorIds) {
        await client.query(
          `INSERT INTO task_collaborators(workspace_id, task_id, user_id, added_by)
           VALUES ($1,$2,$3,$4)`,
          [workspaceId, task.id, collaboratorId, auth.userId],
        );
      }
      const event = await appendEvent(client, {
        workspaceId,
        aggregateId: task.id,
        aggregateVersion: task.version,
        eventType: 'TaskCreated',
        actorId: auth.userId,
        commandId: input.commandId,
        correlationId,
        payload: {
          title: input.title,
        },
      });
      const snapshot = await loadTaskSnapshot(client, workspaceId, task.id);
      const body = { task: snapshot, cursor: event.workspaceSequence };
      await storeProcessedCommand(client, {
        workspaceId,
        commandId: input.commandId,
        actorId: auth.userId,
        commandType: 'CreateTask',
        status: 201,
        body,
      });
      return { response: body, events: [event] };
    });
    this.eventHub.publish(result.events);
    return result.response;
  }

  async execute(
    auth: AuthContext,
    workspaceId: string,
    taskId: string,
    command: TaskCommand,
  ): Promise<Record<string, unknown>> {
    if (command.type === 'StartTask') {
      return this.startTask(auth, workspaceId, taskId, command);
    }
    if (command.type === 'AddDependency' || command.type === 'RemoveDependency') {
      return this.changeDependency(auth, workspaceId, taskId, command);
    }

    const correlationId = randomUUID();
    const result = await inTransaction(this.pool, async (client) => {
      const membership = await requireMembership(client, workspaceId, auth.userId);
      await lockCommand(client, auth.userId, command.commandId);
      const replay = await findProcessedCommand(
        client,
        workspaceId,
        command.commandId,
        auth.userId,
        command.type,
      );
      if (replay) return { response: replay.body, events: [] as EventEnvelope[] };
      const affectedDependentIds =
        command.type === 'CompleteTask' || command.type === 'ReopenTask'
          ? await this.dependencyQueries.getDependents(workspaceId, taskId, client)
          : [];
      const task = await lockTask(client, workspaceId, taskId);
      await assertExpectedVersion(
        client,
        workspaceId,
        taskId,
        task.version,
        command.expectedVersion,
      );
      await this.requireTaskEditPermission(
        client,
        membership,
        task,
        auth.userId,
        command.type,
        command.type === 'AddCollaborator' ? command.userId : undefined,
      );
      const mutation = await this.applyMutation(client, membership, task, auth.userId, command);

      if (!mutation.changed) {
        const snapshot = await loadTaskSnapshot(client, workspaceId, taskId);
        const body = {
          task: snapshot,
          cursor: await currentCursor(client, workspaceId),
          replayedNoOp: true,
        };
        await storeProcessedCommand(client, {
          workspaceId,
          commandId: command.commandId,
          actorId: auth.userId,
          commandType: command.type,
          status: 200,
          body,
        });
        return { response: body, events: [] as EventEnvelope[] };
      }

      const versionResult = await client.query<{ version: number }>(
        `UPDATE tasks SET version = version + 1 WHERE workspace_id = $1 AND id = $2 RETURNING version`,
        [workspaceId, taskId],
      );
      const version = versionResult.rows[0]?.version;
      if (!version) throw new Error('Task version update did not return a version');
      const snapshot = await loadTaskSnapshot(client, workspaceId, taskId);
      const events: EventEnvelope[] = [
        await appendEvent(client, {
          workspaceId,
          aggregateId: taskId,
          aggregateVersion: version,
          eventType: mutation.eventType,
          actorId: auth.userId,
          commandId: command.commandId,
          correlationId,
          payload: mutation.payload,
        }),
      ];

      if (command.type === 'CompleteTask') {
        const dependentIds = affectedDependentIds;
        const dependentVersions = dependentIds.length
          ? await client.query<{ id: string; version: number }>(
              `SELECT id, version FROM tasks
                WHERE workspace_id = $1 AND id = ANY($2::uuid[])`,
              [workspaceId, dependentIds],
            )
          : { rows: [] as Array<{ id: string; version: number }> };
        const versionByDependentId = new Map(
          dependentVersions.rows.map((dependent) => [dependent.id, dependent.version]),
        );
        for (const dependentId of dependentIds) {
          const prerequisiteIds = await this.dependencyQueries.getPrerequisites(
            workspaceId,
            dependentId,
            client,
          );
          const incomplete = prerequisiteIds.length
            ? await client.query(
                `SELECT 1 FROM tasks
                  WHERE workspace_id = $1 AND id = ANY($2::uuid[]) AND status <> 'DONE'
                  LIMIT 1`,
                [workspaceId, prerequisiteIds],
              )
            : { rowCount: 0 };
          const dependentVersion = versionByDependentId.get(dependentId);
          if (incomplete.rowCount || dependentVersion === undefined) continue;
          events.push(
            await appendEvent(client, {
              workspaceId,
              aggregateId: dependentId,
              aggregateVersion: dependentVersion,
              eventType: 'TaskExecutabilityChanged',
              actorType: 'system',
              actorId: null,
              commandId: command.commandId,
              correlationId,
              causationId: events[0]?.eventId ?? null,
              payload: { executable: true, incompletePrerequisiteTaskIds: [] },
            }),
          );
        }
      }

      const body = { task: snapshot, cursor: events.at(-1)?.workspaceSequence ?? 0 };
      await storeProcessedCommand(client, {
        workspaceId,
        commandId: command.commandId,
        actorId: auth.userId,
        commandType: command.type,
        status: 200,
        body,
      });
      return { response: body, events };
    });
    this.eventHub.publish(result.events);
    return result.response;
  }

  async timeline(auth: AuthContext, workspaceId: string, taskId: string): Promise<unknown[]> {
    await requireMembership(this.pool, workspaceId, auth.userId);
    await loadTaskSnapshot(this.pool, workspaceId, taskId);
    const result = await this.pool.query<{
      event_id: string;
      workspace_sequence: string;
      aggregate_version: number;
      event_type: string;
      actor_type: string;
      actor_id: string | null;
      actor_display_name: string | null;
      occurred_at: Date;
      payload: Record<string, unknown>;
    }>(
      `SELECT e.event_id, e.workspace_sequence, e.aggregate_version, e.event_type,
              e.actor_type, e.actor_id, u.display_name AS actor_display_name,
              e.occurred_at, e.payload
         FROM task_events e
         LEFT JOIN users u ON u.id = e.actor_id
        WHERE e.workspace_id = $1 AND e.aggregate_id = $2
        ORDER BY e.workspace_sequence DESC
        LIMIT 500`,
      [workspaceId, taskId],
    );
    return result.rows.map((row) => ({
      eventId: row.event_id,
      cursor: Number(row.workspace_sequence),
      taskVersion: row.aggregate_version,
      eventType: row.event_type,
      actor: row.actor_id
        ? { type: row.actor_type, id: row.actor_id, displayName: row.actor_display_name }
        : { type: row.actor_type, id: null, displayName: 'System' },
      occurredAt: row.occurred_at.toISOString(),
      payload: row.payload,
    }));
  }

  async addExternalReference(
    auth: AuthContext,
    workspaceId: string,
    taskId: string,
    input: {
      commandId: string;
      expectedVersion: number;
      referenceType: string;
      displayName: string;
      url: string;
    },
  ): Promise<Record<string, unknown>> {
    if (!isSafeExternalUrl(input.url)) {
      throw new ApiError(
        422,
        'VALIDATION_ERROR',
        'External reference must use an http or https URL',
      );
    }
    const correlationId = randomUUID();
    const result = await inTransaction(this.pool, async (client) => {
      const membership = await requireMembership(client, workspaceId, auth.userId);
      await lockCommand(client, auth.userId, input.commandId);
      const replay = await findProcessedCommand(
        client,
        workspaceId,
        input.commandId,
        auth.userId,
        'AddExternalReference',
      );
      if (replay) return { response: replay.body, events: [] as EventEnvelope[] };
      const task = await lockTask(client, workspaceId, taskId);
      await assertExpectedVersion(client, workspaceId, taskId, task.version, input.expectedVersion);
      await this.requireTaskEditPermission(
        client,
        membership,
        task,
        auth.userId,
        'AddExternalReference',
      );
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO task_external_references(
           workspace_id, task_id, reference_type, display_name, url, created_by
         ) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (task_id, url) DO NOTHING RETURNING id`,
        [workspaceId, taskId, input.referenceType, input.displayName, input.url, auth.userId],
      );
      if (!inserted.rowCount) {
        const snapshot = await loadTaskSnapshot(client, workspaceId, taskId);
        const body = {
          task: snapshot,
          cursor: await currentCursor(client, workspaceId),
          replayedNoOp: true,
        };
        await storeProcessedCommand(client, {
          workspaceId,
          commandId: input.commandId,
          actorId: auth.userId,
          commandType: 'AddExternalReference',
          status: 200,
          body,
        });
        return { response: body, events: [] as EventEnvelope[] };
      }
      const versionResult = await client.query<{ version: number }>(
        `UPDATE tasks SET version = version + 1 WHERE workspace_id = $1 AND id = $2 RETURNING version`,
        [workspaceId, taskId],
      );
      const version = versionResult.rows[0]?.version ?? task.version + 1;
      const event = await appendEvent(client, {
        workspaceId,
        aggregateId: taskId,
        aggregateVersion: version,
        eventType: 'TaskDetailsUpdated',
        actorId: auth.userId,
        commandId: input.commandId,
        correlationId,
        payload: {
          changes: {
            externalReference: {
              operation: 'added',
              referenceId: inserted.rows[0]?.id,
              referenceType: input.referenceType,
              displayName: input.displayName,
              url: input.url,
            },
          },
        },
      });
      const snapshot = await loadTaskSnapshot(client, workspaceId, taskId);
      const body = { task: snapshot, cursor: event.workspaceSequence };
      await storeProcessedCommand(client, {
        workspaceId,
        commandId: input.commandId,
        actorId: auth.userId,
        commandType: 'AddExternalReference',
        status: 201,
        body,
      });
      return { response: body, events: [event] };
    });
    this.eventHub.publish(result.events);
    return result.response;
  }

  async removeExternalReference(
    auth: AuthContext,
    workspaceId: string,
    taskId: string,
    referenceId: string,
    commandId: string,
    expectedVersion: number,
  ): Promise<Record<string, unknown>> {
    const correlationId = randomUUID();
    const result = await inTransaction(this.pool, async (client) => {
      const membership = await requireMembership(client, workspaceId, auth.userId);
      await lockCommand(client, auth.userId, commandId);
      const replay = await findProcessedCommand(
        client,
        workspaceId,
        commandId,
        auth.userId,
        'RemoveExternalReference',
      );
      if (replay) return { response: replay.body, events: [] as EventEnvelope[] };
      const task = await lockTask(client, workspaceId, taskId);
      await assertExpectedVersion(client, workspaceId, taskId, task.version, expectedVersion);
      await this.requireTaskEditPermission(
        client,
        membership,
        task,
        auth.userId,
        'RemoveExternalReference',
      );
      const deleted = await client.query<{
        url: string;
        reference_type: string;
        display_name: string;
      }>(
        `DELETE FROM task_external_references
          WHERE workspace_id = $1 AND task_id = $2 AND id = $3
          RETURNING url, reference_type, display_name`,
        [workspaceId, taskId, referenceId],
      );
      if (!deleted.rowCount)
        throw new ApiError(404, 'NOT_FOUND', 'External reference is not available');
      const versionResult = await client.query<{ version: number }>(
        `UPDATE tasks SET version = version + 1 WHERE workspace_id = $1 AND id = $2 RETURNING version`,
        [workspaceId, taskId],
      );
      const event = await appendEvent(client, {
        workspaceId,
        aggregateId: taskId,
        aggregateVersion: versionResult.rows[0]?.version ?? task.version + 1,
        eventType: 'TaskDetailsUpdated',
        actorId: auth.userId,
        commandId,
        correlationId,
        payload: {
          changes: {
            externalReference: { operation: 'removed', referenceId, ...deleted.rows[0] },
          },
        },
      });
      const snapshot = await loadTaskSnapshot(client, workspaceId, taskId);
      const body = { task: snapshot, cursor: event.workspaceSequence };
      await storeProcessedCommand(client, {
        workspaceId,
        commandId,
        actorId: auth.userId,
        commandType: 'RemoveExternalReference',
        status: 200,
        body,
      });
      return { response: body, events: [event] };
    });
    this.eventHub.publish(result.events);
    return result.response;
  }

  private async startTask(
    auth: AuthContext,
    workspaceId: string,
    taskId: string,
    command: Extract<TaskCommand, { type: 'StartTask' }>,
  ): Promise<Record<string, unknown>> {
    const correlationId = randomUUID();
    const result = await inTransaction(this.pool, async (client) => {
      await requireMembership(client, workspaceId, auth.userId);
      await lockCommand(client, auth.userId, command.commandId);
      const replay = await findProcessedCommand(
        client,
        workspaceId,
        command.commandId,
        auth.userId,
        command.type,
      );
      if (replay) return { response: replay.body, events: [] as EventEnvelope[] };
      const current = await client.query<TaskLockRow>(
        `SELECT id, workspace_id, owner_id, status, manual_block_type, version, created_by
           FROM tasks WHERE workspace_id = $1 AND id = $2`,
        [workspaceId, taskId],
      );
      const task = current.rows[0];
      if (!task) throw new ApiError(404, 'NOT_FOUND', 'Task is not available in this workspace');
      if (task.version !== command.expectedVersion) {
        await throwVersionConflict(client, workspaceId, taskId, command.expectedVersion);
      }
      if (task.manual_block_type) {
        throw new ApiError(409, 'TASK_BLOCKED', 'Task is manually blocked', {
          task: await loadTaskSnapshot(client, workspaceId, taskId),
        });
      }
      const prerequisiteIds = await this.dependencyQueries.getPrerequisites(
        workspaceId,
        taskId,
        client,
      );
      const blockers = prerequisiteIds.length
        ? await client.query<{ id: string; title: string; status: string }>(
            `SELECT id, title, status FROM tasks
              WHERE workspace_id = $1 AND id = ANY($2::uuid[]) AND status <> 'DONE'
              ORDER BY lower(title), id`,
            [workspaceId, prerequisiteIds],
          )
        : { rows: [] as Array<{ id: string; title: string; status: string }>, rowCount: 0 };
      if (blockers.rowCount) {
        throw new ApiError(409, 'TASK_BLOCKED', 'Task has incomplete prerequisites', {
          incompletePrerequisites: blockers.rows,
        });
      }
      if (task.status !== 'TODO') {
        throw new ApiError(409, 'INVALID_TRANSITION', 'Only a TODO task can be started', {
          currentStatus: task.status,
        });
      }
      if (task.owner_id && task.owner_id !== auth.userId) {
        throw new ApiError(409, 'CLAIM_CONFLICT', 'Task is already owned by another member', {
          task: await loadTaskSnapshot(client, workspaceId, taskId),
        });
      }

      const updated = await client.query<{ version: number }>(
        `UPDATE tasks
            SET owner_id = COALESCE(owner_id, $3), status = 'IN_PROGRESS', version = version + 1
          WHERE workspace_id = $1 AND id = $2 AND version = $4 AND status = 'TODO'
            AND (owner_id IS NULL OR owner_id = $3)
          RETURNING version`,
        [workspaceId, taskId, auth.userId, command.expectedVersion],
      );
      const version = updated.rows[0]?.version;
      if (!version) {
        const latest = await loadTaskSnapshot(client, workspaceId, taskId);
        if (latest.owner && latest.owner.id !== auth.userId) {
          throw new ApiError(409, 'CLAIM_CONFLICT', 'Another member claimed the task first', {
            task: latest,
          });
        }
        throw new ApiError(409, 'VERSION_CONFLICT', 'Task changed before it could be started', {
          task: latest,
        });
      }
      const event = await appendEvent(client, {
        workspaceId,
        aggregateId: taskId,
        aggregateVersion: version,
        eventType: 'TaskStarted',
        actorId: auth.userId,
        commandId: command.commandId,
        correlationId,
        payload: {
          previousStatus: task.status,
          currentStatus: 'IN_PROGRESS',
          previousOwnerId: task.owner_id,
          currentOwnerId: auth.userId,
        },
      });
      const snapshot = await loadTaskSnapshot(client, workspaceId, taskId);
      const body = { task: snapshot, cursor: event.workspaceSequence };
      await storeProcessedCommand(client, {
        workspaceId,
        commandId: command.commandId,
        actorId: auth.userId,
        commandType: command.type,
        status: 200,
        body,
      });
      return { response: body, events: [event] };
    });
    this.eventHub.publish(result.events);
    return result.response;
  }

  private async changeDependency(
    auth: AuthContext,
    workspaceId: string,
    taskId: string,
    command: Extract<TaskCommand, { type: 'AddDependency' | 'RemoveDependency' }>,
  ): Promise<Record<string, unknown>> {
    const correlationId = randomUUID();
    const result = await inTransaction(this.pool, async (client) => {
      const membership = await requireMembership(client, workspaceId, auth.userId);
      await lockCommand(client, auth.userId, command.commandId);
      const replay = await findProcessedCommand(
        client,
        workspaceId,
        command.commandId,
        auth.userId,
        command.type,
      );
      if (replay) return { response: replay.body, events: [] as EventEnvelope[] };
      if (command.prerequisiteTaskId === taskId) {
        throw new ApiError(422, 'DEPENDENCY_CONFLICT', 'A task cannot block itself');
      }
      await this.dependencyCommands.prepareMutation(
        workspaceId,
        [taskId, command.prerequisiteTaskId],
        client,
      );
      const tasks = await client.query<TaskLockRow>(
        `SELECT id, workspace_id, owner_id, status, manual_block_type, version, created_by
           FROM tasks
          WHERE workspace_id = $1 AND id = ANY($2::uuid[])
          ORDER BY id
          FOR UPDATE`,
        [workspaceId, [taskId, command.prerequisiteTaskId]],
      );
      if (tasks.rowCount !== 2)
        throw new ApiError(404, 'NOT_FOUND', 'One or both tasks are not available');
      const dependent = tasks.rows.find((task) => task.id === taskId);
      if (!dependent) throw new ApiError(404, 'NOT_FOUND', 'Task is not available');
      await assertExpectedVersion(
        client,
        workspaceId,
        taskId,
        dependent.version,
        command.expectedVersion,
      );
      await this.requireTaskEditPermission(
        client,
        membership,
        dependent,
        auth.userId,
        command.type,
      );

      let changed: boolean;
      if (command.type === 'AddDependency') {
        const change = await this.dependencyCommands.addBlockingDependency(
          {
            workspaceId,
            prerequisiteTaskId: command.prerequisiteTaskId,
            dependentTaskId: taskId,
            actorId: auth.userId,
          },
          client,
        );
        changed = change.created;
      } else {
        changed = await this.dependencyCommands.removeDependency(
          {
            workspaceId,
            prerequisiteTaskId: command.prerequisiteTaskId,
            dependentTaskId: taskId,
          },
          client,
        );
      }
      if (!changed) {
        const snapshot = await loadTaskSnapshot(client, workspaceId, taskId);
        const body = {
          task: snapshot,
          cursor: await currentCursor(client, workspaceId),
          replayedNoOp: true,
        };
        await storeProcessedCommand(client, {
          workspaceId,
          commandId: command.commandId,
          actorId: auth.userId,
          commandType: command.type,
          status: 200,
          body,
        });
        return { response: body, events: [] as EventEnvelope[] };
      }

      const versionResult = await client.query<{ version: number }>(
        `UPDATE tasks SET version = version + 1 WHERE workspace_id = $1 AND id = $2 RETURNING version`,
        [workspaceId, taskId],
      );
      const version = versionResult.rows[0]?.version ?? dependent.version + 1;
      const event = await appendEvent(client, {
        workspaceId,
        aggregateId: taskId,
        aggregateVersion: version,
        eventType: command.type === 'AddDependency' ? 'DependencyAdded' : 'DependencyRemoved',
        actorId: auth.userId,
        commandId: command.commandId,
        correlationId,
        payload: {
          prerequisiteTaskId: command.prerequisiteTaskId,
          dependentTaskId: taskId,
          dependencyType: 'BLOCKS',
        },
      });
      const snapshot = await loadTaskSnapshot(client, workspaceId, taskId);
      const body = { task: snapshot, cursor: event.workspaceSequence };
      await storeProcessedCommand(client, {
        workspaceId,
        commandId: command.commandId,
        actorId: auth.userId,
        commandType: command.type,
        status: 200,
        body,
      });
      return { response: body, events: [event] };
    });
    this.eventHub.publish(result.events);
    return result.response;
  }

  private async requireTaskEditPermission(
    client: DatabaseClient,
    membership: Membership,
    task: TaskLockRow,
    actorId: string,
    commandType: string,
    targetUserId?: string,
  ): Promise<void> {
    if (membership.role === 'ADMIN') return;
    // An active workspace member may ask the current owner to hand over a task,
    // but the request itself never grants ownership. Likewise, members may add
    // only themselves as collaborators; adding somebody else remains an owner
    // or administrator action.
    if (commandType === 'RequestOwnerTransfer') return;
    if (commandType === 'AddCollaborator' && targetUserId === actorId) return;
    const ownerOnlyCommands = new Set([
      'PauseTask',
      'ReleaseTask',
      'TransferOwner',
      'AddCollaborator',
      'RemoveCollaborator',
      'RequestReview',
      'CompleteTask',
    ]);
    if (ownerOnlyCommands.has(commandType) && task.owner_id !== actorId) {
      throw new ApiError(
        403,
        'FORBIDDEN',
        'Only the current owner or an administrator may perform this task action',
      );
    }
    const collaborator = await client.query(
      `SELECT 1 FROM task_collaborators WHERE workspace_id = $1 AND task_id = $2 AND user_id = $3`,
      [task.workspace_id, task.id, actorId],
    );
    if (task.owner_id !== actorId && task.created_by !== actorId && !collaborator.rowCount) {
      throw new ApiError(
        403,
        'FORBIDDEN',
        'Only task participants or an administrator may change this task',
      );
    }
  }

  private async applyMutation(
    client: DatabaseClient,
    membership: Membership,
    task: TaskLockRow,
    actorId: string,
    command: Exclude<TaskCommand, { type: 'StartTask' | 'AddDependency' | 'RemoveDependency' }>,
  ): Promise<{ changed: boolean; eventType: string; payload: Record<string, unknown> }> {
    switch (command.type) {
      case 'UpdateTaskDetails': {
        const assignments: string[] = [];
        const changes: Record<string, unknown> = {};
        const values: unknown[] = [task.workspace_id, task.id];
        const add = (column: string, field: string, before: unknown, value: unknown): void => {
          values.push(value);
          assignments.push(`${column} = $${values.length}`);
          changes[field] = { before, after: value };
        };
        if (command.title !== undefined) add('title', 'title', task.title, command.title);
        if (command.description !== undefined)
          add('description', 'description', task.description, command.description);
        if (command.definitionOfDone !== undefined) {
          add(
            'definition_of_done',
            'definitionOfDone',
            task.definition_of_done,
            command.definitionOfDone,
          );
        }
        if (command.dueAt !== undefined)
          add('due_at', 'dueAt', task.due_at?.toISOString() ?? null, command.dueAt);
        if (!assignments.length)
          throw new ApiError(422, 'VALIDATION_ERROR', 'At least one task detail must change');
        await client.query(
          `UPDATE tasks SET ${assignments.join(', ')} WHERE workspace_id = $1 AND id = $2`,
          values,
        );
        return { changed: true, eventType: 'TaskDetailsUpdated', payload: { changes } };
      }
      case 'PauseTask':
        assertTransition(task, 'TODO', 'pause');
        await updateTask(client, task, "status = 'TODO'");
        return {
          changed: true,
          eventType: 'TaskPaused',
          payload: statusPayload(task, 'TODO', task.owner_id),
        };
      case 'ReleaseTask':
        assertStatus(task, ['TODO', 'IN_PROGRESS'], 'release');
        if (!task.owner_id) return { changed: false, eventType: 'TaskReleased', payload: {} };
        await updateTask(client, task, "status = 'TODO', owner_id = NULL");
        return {
          changed: true,
          eventType: 'TaskReleased',
          payload: statusPayload(task, 'TODO', null),
        };
      case 'TransferOwner':
        await requireActiveWorkspaceUser(client, task.workspace_id, command.ownerId);
        if (task.owner_id === command.ownerId)
          return { changed: false, eventType: 'TaskOwnerTransferred', payload: {} };
        await updateTask(client, task, 'owner_id = $3', [command.ownerId]);
        await client.query(
          `DELETE FROM task_collaborators WHERE workspace_id = $1 AND task_id = $2 AND user_id = $3`,
          [task.workspace_id, task.id, command.ownerId],
        );
        return {
          changed: true,
          eventType: 'TaskOwnerTransferred',
          payload: { previousOwnerId: task.owner_id, currentOwnerId: command.ownerId },
        };
      case 'RequestOwnerTransfer':
        assertNonTerminal(task, 'request ownership of');
        if (task.owner_id === null) {
          throw new ApiError(
            409,
            'CLAIM_CONFLICT',
            'This task has no owner and can be claimed directly',
            { currentOwnerId: null, currentStatus: task.status },
          );
        }
        if (task.owner_id === actorId) {
          throw new ApiError(
            422,
            'VALIDATION_ERROR',
            'The current owner cannot request ownership from themselves',
          );
        }
        return {
          changed: true,
          eventType: 'TaskOwnerTransferRequested',
          payload: { requesterId: actorId, currentOwnerId: task.owner_id },
        };
      case 'AddCollaborator': {
        assertNonTerminal(task, 'join');
        if (task.owner_id === null) {
          throw new ApiError(
            409,
            'CLAIM_CONFLICT',
            'This task has no owner and should be claimed instead of joined',
            { currentOwnerId: null, currentStatus: task.status },
          );
        }
        await requireActiveWorkspaceUser(client, task.workspace_id, command.userId);
        if (command.userId === task.owner_id) {
          throw new ApiError(
            422,
            'VALIDATION_ERROR',
            'The task owner is already responsible and cannot also be a collaborator',
          );
        }
        const inserted = await client.query(
          `INSERT INTO task_collaborators(workspace_id, task_id, user_id, added_by)
           VALUES ($1,$2,$3,$4) ON CONFLICT (task_id, user_id) DO NOTHING`,
          [task.workspace_id, task.id, command.userId, actorId],
        );
        return {
          changed: Boolean(inserted.rowCount),
          eventType: 'TaskCollaboratorAdded',
          payload: { collaboratorId: command.userId },
        };
      }
      case 'RemoveCollaborator': {
        const deleted = await client.query(
          `DELETE FROM task_collaborators WHERE workspace_id = $1 AND task_id = $2 AND user_id = $3`,
          [task.workspace_id, task.id, command.userId],
        );
        return {
          changed: Boolean(deleted.rowCount),
          eventType: 'TaskCollaboratorRemoved',
          payload: { collaboratorId: command.userId },
        };
      }
      case 'BlockTask':
        assertNonTerminal(task, 'block');
        await updateTask(client, task, 'manual_block_type = $3, manual_block_reason = $4', [
          command.blockType,
          command.reason,
        ]);
        return {
          changed: true,
          eventType: 'TaskBlocked',
          payload: { blockType: command.blockType, reason: command.reason },
        };
      case 'UnblockTask':
        assertNonTerminal(task, 'unblock');
        if (!task.manual_block_type)
          return { changed: false, eventType: 'TaskUnblocked', payload: {} };
        await updateTask(client, task, 'manual_block_type = NULL, manual_block_reason = NULL');
        return {
          changed: true,
          eventType: 'TaskUnblocked',
          payload: { previousBlockType: task.manual_block_type },
        };
      case 'RequestReview':
        assertTransition(task, 'IN_REVIEW', 'request review for');
        await updateTask(client, task, "status = 'IN_REVIEW'");
        return {
          changed: true,
          eventType: 'TaskReviewRequested',
          payload: statusPayload(task, 'IN_REVIEW', task.owner_id),
        };
      case 'RequestChanges':
        assertTransition(task, 'IN_PROGRESS', 'request changes for');
        await updateTask(client, task, "status = 'IN_PROGRESS'");
        return {
          changed: true,
          eventType: 'TaskChangesRequested',
          payload: statusPayload(task, 'IN_PROGRESS', task.owner_id),
        };
      case 'CompleteTask':
        assertTransition(task, 'DONE', 'complete');
        await updateTask(
          client,
          task,
          "status = 'DONE', archived_at = clock_timestamp(), manual_block_type = NULL, manual_block_reason = NULL",
        );
        return {
          changed: true,
          eventType: 'TaskCompleted',
          payload: statusPayload(task, 'DONE', task.owner_id),
        };
      case 'CancelTask':
        assertTransition(task, 'CANCELED', 'cancel');
        await updateTask(
          client,
          task,
          "status = 'CANCELED', archived_at = clock_timestamp(), manual_block_type = NULL, manual_block_reason = NULL",
        );
        return {
          changed: true,
          eventType: 'TaskCanceled',
          payload: statusPayload(task, 'CANCELED', task.owner_id),
        };
      case 'ReopenTask':
        assertTransition(task, 'TODO', 'reopen');
        await updateTask(
          client,
          task,
          "status = 'TODO', archived_at = NULL, manual_block_type = NULL, manual_block_reason = NULL",
        );
        return {
          changed: true,
          eventType: 'TaskReopened',
          payload: statusPayload(task, 'TODO', task.owner_id),
        };
      case 'SetImportance':
        if (task.importance === command.importance)
          return { changed: false, eventType: 'TaskImportanceChanged', payload: {} };
        await updateTask(client, task, 'importance = $3', [command.importance]);
        return {
          changed: true,
          eventType: 'TaskImportanceChanged',
          payload: { previousImportance: task.importance, currentImportance: command.importance },
        };
      case 'SetActionOverride': {
        if (new Date(command.expiresAt).getTime() <= Date.now()) {
          throw new ApiError(
            422,
            'VALIDATION_ERROR',
            'Action override expiry must be in the future',
          );
        }
        await updateTask(
          client,
          task,
          'action_override = $3, action_override_reason = $4, action_override_expires_at = $5',
          [command.level, command.reason, command.expiresAt],
        );
        return {
          changed: true,
          eventType: 'TaskActionOverrideSet',
          payload: { level: command.level, reason: command.reason, expiresAt: command.expiresAt },
        };
      }
      case 'ClearActionOverride':
        if (!task.action_override)
          return { changed: false, eventType: 'TaskActionOverrideCleared', payload: {} };
        await updateTask(
          client,
          task,
          'action_override = NULL, action_override_reason = NULL, action_override_expires_at = NULL',
        );
        return {
          changed: true,
          eventType: 'TaskActionOverrideCleared',
          payload: { expired: false },
        };
    }
  }
}

interface TaskLockRow {
  id: string;
  workspace_id: string;
  owner_id: string | null;
  status: 'TODO' | 'IN_PROGRESS' | 'IN_REVIEW' | 'DONE' | 'CANCELED';
  manual_block_type: string | null;
  manual_block_reason: string | null;
  title: string;
  description: string;
  definition_of_done: string;
  due_at: Date | null;
  importance: number;
  version: number;
  created_by: string;
  action_override: 'NOW' | 'NEXT' | 'LATER' | null;
}

async function lockTask(
  client: DatabaseClient,
  workspaceId: string,
  taskId: string,
): Promise<TaskLockRow> {
  const result = await client.query<TaskLockRow>(
    `SELECT id, workspace_id, owner_id, status, manual_block_type, manual_block_reason,
            title, description, definition_of_done, due_at,
            importance, version, created_by, action_override
       FROM tasks WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
    [workspaceId, taskId],
  );
  const task = result.rows[0];
  if (!task) throw new ApiError(404, 'NOT_FOUND', 'Task is not available in this workspace');
  return task;
}

async function assertExpectedVersion(
  client: DatabaseClient,
  workspaceId: string,
  taskId: string,
  currentVersion: number,
  expectedVersion: number,
): Promise<void> {
  if (currentVersion !== expectedVersion) {
    await throwVersionConflict(client, workspaceId, taskId, expectedVersion);
  }
}

async function throwVersionConflict(
  client: DatabaseClient,
  workspaceId: string,
  taskId: string,
  expectedVersion: number,
): Promise<never> {
  const task = await loadTaskSnapshot(client, workspaceId, taskId);
  throw new ApiError(409, 'VERSION_CONFLICT', 'Task version is out of date', {
    expectedVersion,
    currentVersion: task.version,
    task,
  });
}

function assertStatus(task: TaskLockRow, allowed: TaskLockRow['status'][], action: string): void {
  if (!allowed.includes(task.status)) {
    throw new ApiError(409, 'INVALID_TRANSITION', `Cannot ${action} a task in ${task.status}`, {
      currentStatus: task.status,
      allowedStatuses: allowed,
    });
  }
}

function assertNonTerminal(task: TaskLockRow, action: string): void {
  if (task.status === 'DONE' || task.status === 'CANCELED') {
    throw new ApiError(409, 'INVALID_TRANSITION', `Cannot ${action} a terminal task`, {
      currentStatus: task.status,
    });
  }
}

function assertTransition(task: TaskLockRow, target: TaskLockRow['status'], action: string): void {
  if (!canTransition(task.status, target)) {
    throw new ApiError(409, 'INVALID_TRANSITION', `Cannot ${action} a task in ${task.status}`, {
      currentStatus: task.status,
      requestedStatus: target,
    });
  }
}

async function updateTask(
  client: DatabaseClient,
  task: TaskLockRow,
  assignments: string,
  values: unknown[] = [],
): Promise<void> {
  await client.query(`UPDATE tasks SET ${assignments} WHERE workspace_id = $1 AND id = $2`, [
    task.workspace_id,
    task.id,
    ...values,
  ]);
}

function statusPayload(
  task: TaskLockRow,
  currentStatus: TaskLockRow['status'],
  currentOwnerId: string | null,
): Record<string, unknown> {
  return {
    previousStatus: task.status,
    currentStatus,
    previousOwnerId: task.owner_id,
    currentOwnerId,
  };
}

async function currentCursor(client: DatabaseClient, workspaceId: string): Promise<number> {
  const result = await client.query<{ last_sequence: string }>(
    `SELECT last_sequence FROM workspace_sync_state WHERE workspace_id = $1`,
    [workspaceId],
  );
  return Number(result.rows[0]?.last_sequence ?? 0);
}

function escapeLike(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}
