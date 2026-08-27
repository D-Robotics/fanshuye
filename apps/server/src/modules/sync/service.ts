import type { DatabasePool } from '../../db/pool';
import { inTransaction } from '../../db/pool';
import { ApiError } from '../../lib/errors';
import type { MetricsRegistry } from '../../observability/metrics';
import type { AuthContext } from '../common/auth-context';
import { requireMembership } from '../common/access';
import { mapTaskProjection, taskProjectionSql, type TaskProjectionRow } from '../tasks/projection';
import type { EventEnvelope } from './event-hub';

export class SyncService {
  public constructor(
    private readonly pool: DatabasePool,
    private readonly metrics: MetricsRegistry,
  ) {}

  async snapshot(auth: AuthContext, workspaceId: string): Promise<Record<string, unknown>> {
    return inTransaction(
      this.pool,
      async (client) => {
        await requireMembership(client, workspaceId, auth.userId);
        this.metrics.recordSnapshotRequest();
        const state = await client.query<{ last_sequence: string }>(
          `SELECT last_sequence FROM workspace_sync_state WHERE workspace_id = $1`,
          [workspaceId],
        );
        const workspace = await client.query<{
          id: string;
          name: string;
          timezone: string;
          tree_id: string;
          tree_name: string;
        }>(
          `SELECT w.id, w.name, w.timezone, tt.id AS tree_id, tt.name AS tree_name
             FROM workspaces w JOIN task_trees tt ON tt.workspace_id = w.id
            WHERE w.id = $1`,
          [workspaceId],
        );
        const workstreams = await client.query<{ id: string; name: string; sort_order: number }>(
          `SELECT id, name, sort_order FROM workstreams
            WHERE workspace_id = $1 ORDER BY sort_order, id`,
          [workspaceId],
        );
        const members = await client.query<{
          id: string;
          display_name: string;
          role: 'ADMIN' | 'MEMBER';
        }>(
          `SELECT u.id, u.display_name, wm.role
             FROM workspace_memberships wm JOIN users u ON u.id = wm.user_id
            WHERE wm.workspace_id = $1 AND wm.status = 'ACTIVE'
            ORDER BY lower(u.display_name), u.id`,
          [workspaceId],
        );
        const tasks = await client.query<TaskProjectionRow>(
          `${taskProjectionSql('t.workspace_id = $1 AND t.archived_at IS NULL')}
           ORDER BY t.id`,
          [workspaceId],
        );
        const dependencies = await client.query<{
          id: string;
          prerequisite_task_id: string;
          dependent_task_id: string;
          relation_type: 'BLOCKS';
        }>(
          `SELECT id, prerequisite_task_id, dependent_task_id, relation_type
             FROM task_dependencies WHERE workspace_id = $1
            ORDER BY prerequisite_task_id, dependent_task_id`,
          [workspaceId],
        );
        const row = workspace.rows[0];
        if (!row) throw new ApiError(404, 'NOT_FOUND', 'Workspace is not available');
        return {
          schemaVersion: 1,
          snapshotCursor: Number(state.rows[0]?.last_sequence ?? 0),
          capturedAt: new Date().toISOString(),
          workspace: {
            id: row.id,
            name: row.name,
            timezone: row.timezone,
            tree: { id: row.tree_id, name: row.tree_name },
          },
          workstreams: workstreams.rows.map((item) => ({
            id: item.id,
            name: item.name,
            sortOrder: item.sort_order,
          })),
          members: members.rows.map((item) => ({
            id: item.id,
            displayName: item.display_name,
            role: item.role,
          })),
          tasks: tasks.rows.map((task) => mapTaskProjection(task)),
          dependencies: dependencies.rows.map((edge) => ({
            id: edge.id,
            prerequisiteTaskId: edge.prerequisite_task_id,
            dependentTaskId: edge.dependent_task_id,
            relationType: edge.relation_type,
          })),
        };
      },
      { isolation: 'REPEATABLE READ' },
    );
  }

  async incremental(
    auth: AuthContext,
    workspaceId: string,
    afterCursor: number,
    limit: number,
  ): Promise<Record<string, unknown>> {
    return inTransaction(
      this.pool,
      async (client) => {
        await requireMembership(client, workspaceId, auth.userId);
        const state = await client.query<{ last_sequence: string; min_retained_sequence: string }>(
          `SELECT last_sequence, min_retained_sequence
             FROM workspace_sync_state WHERE workspace_id = $1`,
          [workspaceId],
        );
        const row = state.rows[0];
        if (!row) throw new ApiError(404, 'NOT_FOUND', 'Workspace is not available');
        const current = Number(row.last_sequence);
        const minimum = Number(row.min_retained_sequence);
        if (afterCursor < minimum || afterCursor > current) {
          this.metrics.recordSyncSnapshotRequired();
          throw new ApiError(
            410,
            'SNAPSHOT_REQUIRED',
            'Sync cursor cannot be resumed; fetch a new snapshot',
            {
              minimumCursor: minimum,
              currentCursor: current,
              snapshotUrl: `/v1/workspaces/${workspaceId}/sync/snapshot`,
            },
          );
        }
        const events = await client.query<EventRow>(
          `SELECT event_id, workspace_id, workspace_sequence, aggregate_type, aggregate_id,
                  aggregate_version, event_type, schema_version, actor_type, actor_id,
                  command_id, correlation_id, causation_id, payload, occurred_at
             FROM task_events
            WHERE workspace_id = $1 AND workspace_sequence > $2
            ORDER BY workspace_sequence
            LIMIT $3`,
          [workspaceId, afterCursor, limit],
        );
        const mapped = events.rows.map(mapEvent);
        const nextCursor = mapped.at(-1)?.workspaceSequence ?? afterCursor;
        return {
          schemaVersion: 1,
          events: mapped,
          nextCursor,
          currentCursor: current,
          hasMore: nextCursor < current,
        };
      },
      { isolation: 'REPEATABLE READ' },
    );
  }
}

interface EventRow {
  event_id: string;
  workspace_id: string;
  workspace_sequence: string;
  aggregate_type: string;
  aggregate_id: string;
  aggregate_version: number;
  event_type: string;
  schema_version: number;
  actor_type: EventEnvelope['actorType'];
  actor_id: string | null;
  command_id: string;
  correlation_id: string | null;
  causation_id: string | null;
  payload: Record<string, unknown>;
  occurred_at: Date;
}

export function mapEvent(row: EventRow): EventEnvelope {
  if (row.schema_version !== 1) {
    throw new Error(`Unsupported persisted event schema version: ${row.schema_version}`);
  }

  return {
    eventId: row.event_id,
    workspaceId: row.workspace_id,
    workspaceSequence: Number(row.workspace_sequence),
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    aggregateVersion: row.aggregate_version,
    eventType: row.event_type,
    schemaVersion: 1,
    actorType: row.actor_type,
    actorId: row.actor_id,
    occurredAt: row.occurred_at.toISOString(),
    commandId: row.command_id,
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    payload: row.payload,
  };
}
