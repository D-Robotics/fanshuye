import type { DatabaseClient, DatabasePool } from '../../db/pool';
import { ApiError } from '../../lib/errors';

export type WorkspaceRole = 'ADMIN' | 'MEMBER';

export interface Membership {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
}

type Queryable = Pick<DatabaseClient, 'query'> | Pick<DatabasePool, 'query'>;

export async function requireMembership(
  database: Queryable,
  workspaceId: string,
  userId: string,
): Promise<Membership> {
  const result = await database.query<{
    workspace_id: string;
    user_id: string;
    role: WorkspaceRole;
  }>(
    `SELECT workspace_id, user_id, role
       FROM workspace_memberships
      WHERE workspace_id = $1 AND user_id = $2 AND status = 'ACTIVE'`,
    [workspaceId, userId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new ApiError(403, 'FORBIDDEN', 'Workspace access is not available');
  }
  return { workspaceId: row.workspace_id, userId: row.user_id, role: row.role };
}

export async function requireAdmin(
  database: Queryable,
  workspaceId: string,
  userId: string,
): Promise<Membership> {
  const membership = await requireMembership(database, workspaceId, userId);
  if (membership.role !== 'ADMIN') {
    throw new ApiError(403, 'FORBIDDEN', 'Workspace administrator permission is required');
  }
  return membership;
}

export async function requireActiveWorkspaceUser(
  database: Queryable,
  workspaceId: string,
  userId: string,
): Promise<void> {
  const result = await database.query(
    `SELECT 1 FROM workspace_memberships
      WHERE workspace_id = $1 AND user_id = $2 AND status = 'ACTIVE'`,
    [workspaceId, userId],
  );
  if (!result.rowCount) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Selected user is not an active workspace member');
  }
}
