import { deriveActionLevel, mapImportanceToLeafSize } from '@fanshuye/domain';
import type { DatabaseClient, DatabasePool } from '../../db/pool';
import { ApiError } from '../../lib/errors';

type Queryable = Pick<DatabaseClient, 'query'> | Pick<DatabasePool, 'query'>;

export interface TaskSnapshot extends Record<string, unknown> {
  id: string;
  workspaceId: string;
  title: string;
  status: 'TODO' | 'IN_PROGRESS' | 'IN_REVIEW' | 'DONE' | 'CANCELED';
  version: number;
  owner: { id: string; displayName: string } | null;
  collaborators: Array<{ id: string; displayName: string }>;
  dependencyBlocked: boolean;
  manualBlocked: boolean;
  effectiveBlocked: boolean;
}

export async function loadTaskSnapshot(
  database: Queryable,
  workspaceId: string,
  taskId: string,
): Promise<TaskSnapshot> {
  const result = await database.query<TaskProjectionRow>(
    taskProjectionSql('t.workspace_id = $1 AND t.id = $2'),
    [workspaceId, taskId],
  );
  const row = result.rows[0];
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Task is not available in this workspace');
  return mapTaskProjection(row);
}

export function taskProjectionSql(predicate: string): string {
  return `
    SELECT t.*,
           owner.display_name AS owner_display_name,
           creator.display_name AS creator_display_name,
           w.timezone AS workspace_timezone,
           COALESCE((
             SELECT jsonb_agg(jsonb_build_object('id', u.id, 'displayName', u.display_name)
                              ORDER BY lower(u.display_name), u.id)
               FROM task_collaborators tc
               JOIN users u ON u.id = tc.user_id
              WHERE tc.workspace_id = t.workspace_id AND tc.task_id = t.id
           ), '[]'::jsonb) AS collaborators,
           COALESCE((
             SELECT jsonb_agg(jsonb_build_object(
                      'id', p.id, 'title', p.title, 'status', p.status,
                      'version', p.version, 'incomplete', p.status <> 'DONE'
                    ) ORDER BY lower(p.title), p.id)
               FROM task_dependencies d
               JOIN tasks p ON p.workspace_id = d.workspace_id AND p.id = d.prerequisite_task_id
              WHERE d.workspace_id = t.workspace_id AND d.dependent_task_id = t.id
           ), '[]'::jsonb) AS prerequisites,
           COALESCE((
             SELECT jsonb_agg(jsonb_build_object(
                      'id', dwn.id, 'title', dwn.title, 'status', dwn.status,
                      'version', dwn.version
                    ) ORDER BY lower(dwn.title), dwn.id)
               FROM task_dependencies d
               JOIN tasks dwn ON dwn.workspace_id = d.workspace_id AND dwn.id = d.dependent_task_id
              WHERE d.workspace_id = t.workspace_id AND d.prerequisite_task_id = t.id
           ), '[]'::jsonb) AS dependents,
           COALESCE((
             SELECT jsonb_agg(jsonb_build_object(
                      'id', r.id, 'referenceType', r.reference_type,
                      'displayName', r.display_name, 'url', r.url
                    ) ORDER BY r.created_at, r.id)
               FROM task_external_references r
              WHERE r.workspace_id = t.workspace_id AND r.task_id = t.id
           ), '[]'::jsonb) AS external_references,
           EXISTS(
             SELECT 1 FROM task_dependencies d
             JOIN tasks p ON p.workspace_id = d.workspace_id AND p.id = d.prerequisite_task_id
             WHERE d.workspace_id = t.workspace_id AND d.dependent_task_id = t.id
               AND p.status <> 'DONE'
           ) AS dependency_blocked,
           (
             SELECT CASE MIN(
               CASE
                 WHEN downstream.action_override IS NOT NULL
                   AND downstream.action_override_expires_at > clock_timestamp()
                   THEN CASE downstream.action_override WHEN 'NOW' THEN 0 WHEN 'NEXT' THEN 1 ELSE 2 END
                 WHEN downstream.due_at <= clock_timestamp() + interval '24 hours' THEN 0
                 WHEN downstream.due_at <= clock_timestamp() + interval '7 days'
                   OR downstream.importance >= 4 THEN 1
                 ELSE 2
               END
             ) WHEN 0 THEN 'NOW' WHEN 1 THEN 'NEXT' WHEN 2 THEN 'LATER' END
               FROM task_dependencies unlock_edge
               JOIN tasks downstream
                 ON downstream.workspace_id = unlock_edge.workspace_id
                AND downstream.id = unlock_edge.dependent_task_id
              WHERE unlock_edge.workspace_id = t.workspace_id
                AND unlock_edge.prerequisite_task_id = t.id
                AND t.status <> 'DONE'
                AND downstream.archived_at IS NULL
           ) AS highest_blocked_dependent_level
      FROM tasks t
      JOIN workspaces w ON w.id = t.workspace_id
      JOIN users creator ON creator.id = t.created_by
      LEFT JOIN users owner ON owner.id = t.owner_id
     WHERE ${predicate}`;
}

export interface TaskProjectionRow {
  id: string;
  workspace_id: string;
  tree_id: string;
  workstream_id: string;
  title: string;
  description: string;
  definition_of_done: string;
  owner_id: string | null;
  owner_display_name: string | null;
  creator_display_name: string;
  status: TaskSnapshot['status'];
  manual_block_type: string | null;
  manual_block_reason: string | null;
  importance: number;
  due_at: Date | null;
  action_override: 'NOW' | 'NEXT' | 'LATER' | null;
  action_override_reason: string | null;
  action_override_expires_at: Date | null;
  manual_order: string | null;
  version: number;
  archived_at: Date | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  workspace_timezone: string;
  collaborators: Array<{ id: string; displayName: string }>;
  prerequisites: Array<{
    id: string;
    title: string;
    status: string;
    version: number;
    incomplete: boolean;
  }>;
  dependents: Array<{ id: string; title: string; status: string; version: number }>;
  external_references: Array<{
    id: string;
    referenceType: string;
    displayName: string;
    url: string;
  }>;
  dependency_blocked: boolean;
  highest_blocked_dependent_level: 'NOW' | 'NEXT' | 'LATER' | null;
}

export function mapTaskProjection(row: TaskProjectionRow, now = new Date()): TaskSnapshot {
  const manualBlocked = row.manual_block_type !== null;
  const overdue =
    row.due_at !== null && row.due_at.getTime() < now.getTime() && row.archived_at === null;
  const action = deriveProjectedActionLevel(row, now);
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    treeId: row.tree_id,
    workstreamId: row.workstream_id,
    title: row.title,
    description: row.description,
    definitionOfDone: row.definition_of_done,
    owner: row.owner_id
      ? { id: row.owner_id, displayName: row.owner_display_name ?? 'Unknown member' }
      : null,
    collaborators: row.collaborators,
    status: row.status,
    manualBlock: manualBlocked
      ? { type: row.manual_block_type, reason: row.manual_block_reason }
      : null,
    manualBlocked,
    dependencyBlocked: row.dependency_blocked,
    effectiveBlocked: manualBlocked || row.dependency_blocked,
    incompletePrerequisites: row.prerequisites.filter((task) => task.incomplete),
    prerequisites: row.prerequisites,
    dependents: row.dependents,
    importance: row.importance,
    leafSize: mapImportanceToLeafSize(row.importance as 1 | 2 | 3 | 4 | 5),
    dueAt: row.due_at?.toISOString() ?? null,
    overdue,
    actionLevel: action.level,
    actionReasons: action.reasons,
    actionOverride:
      row.action_override && row.action_override_expires_at
        ? {
            level: row.action_override,
            reason: row.action_override_reason,
            expiresAt: row.action_override_expires_at.toISOString(),
            active: row.action_override_expires_at.getTime() > now.getTime(),
          }
        : null,
    manualOrder: row.manual_order,
    version: row.version,
    archivedAt: row.archived_at?.toISOString() ?? null,
    createdBy: { id: row.created_by, displayName: row.creator_display_name },
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    externalReferences: row.external_references,
    workspaceTimezone: row.workspace_timezone,
  };
}

function deriveProjectedActionLevel(
  row: Pick<
    TaskProjectionRow,
    | 'due_at'
    | 'importance'
    | 'action_override'
    | 'action_override_reason'
    | 'action_override_expires_at'
    | 'dependency_blocked'
    | 'manual_block_type'
    | 'prerequisites'
    | 'workspace_timezone'
    | 'highest_blocked_dependent_level'
  >,
  now: Date,
): { level: 'NOW' | 'NEXT' | 'LATER'; reasons: string[] } {
  const incompletePrerequisiteTaskIds = row.prerequisites
    .filter((task) => task.incomplete)
    .map((task) => task.id);
  const manualOverride =
    row.action_override && row.action_override_reason && row.action_override_expires_at
      ? {
          level: row.action_override,
          reason: row.action_override_reason,
          expiresAt: row.action_override_expires_at.toISOString(),
        }
      : null;
  const derived = deriveActionLevel({
    importance: row.importance as 1 | 2 | 3 | 4 | 5,
    deadlineAt: row.due_at?.toISOString() ?? null,
    executable: !row.dependency_blocked && row.manual_block_type === null,
    timeZone: row.workspace_timezone,
    now,
    manualOverride,
    highestBlockedDependentLevel: row.highest_blocked_dependent_level,
    manuallyBlocked: row.manual_block_type !== null,
    incompletePrerequisiteTaskIds,
  });
  return { level: derived.level, reasons: derived.reasons.map((reason) => reason.code) };
}
