import { randomUUID } from 'node:crypto';
import type { DatabasePool } from '../../db/pool';
import { inTransaction } from '../../db/pool';
import { ApiError } from '../../lib/errors';
import { hashToken, randomToken } from '../../lib/security';
import {
  appendEvent,
  findActorProcessedCommand,
  findProcessedCommand,
  lockCommand,
  storeProcessedCommand,
} from '../audit/events';
import type { AuthContext } from '../common/auth-context';
import { requireAdmin, requireMembership } from '../common/access';
import type { EventEnvelope, EventHub } from '../sync/event-hub';

export class WorkspaceService {
  public constructor(
    private readonly pool: DatabasePool,
    private readonly eventHub: EventHub,
  ) {}

  async list(auth: AuthContext): Promise<unknown[]> {
    const result = await this.pool.query(
      `SELECT w.id, w.name, w.timezone, wm.role, t.id AS tree_id, t.name AS tree_name
         FROM workspace_memberships wm
         JOIN workspaces w ON w.id = wm.workspace_id
         JOIN task_trees t ON t.workspace_id = w.id
        WHERE wm.user_id = $1 AND wm.status = 'ACTIVE'
        ORDER BY lower(w.name), w.id`,
      [auth.userId],
    );
    return result.rows.map((row) => mapWorkspaceRow(row as WorkspaceRow));
  }

  async create(
    auth: AuthContext,
    input: { commandId: string; name: string; timezone: string },
  ): Promise<Record<string, unknown>> {
    const correlationId = randomUUID();
    const { response, events } = await inTransaction(this.pool, async (client) => {
      await lockCommand(client, auth.userId, input.commandId);
      const replay = await findActorProcessedCommand(
        client,
        auth.userId,
        input.commandId,
        'CreateWorkspace',
      );
      if (replay) return { response: replay.body, events: [] as EventEnvelope[] };
      const workspace = await client.query<{ id: string }>(
        `INSERT INTO workspaces(name, timezone, created_by) VALUES ($1,$2,$3) RETURNING id`,
        [input.name.trim(), input.timezone, auth.userId],
      );
      const workspaceId = workspace.rows[0]?.id;
      if (!workspaceId) throw new Error('Workspace creation did not return an id');
      await client.query(
        `INSERT INTO workspace_memberships(workspace_id, user_id, role) VALUES ($1,$2,'ADMIN')`,
        [workspaceId, auth.userId],
      );
      await client.query(`INSERT INTO workspace_sync_state(workspace_id) VALUES ($1)`, [
        workspaceId,
      ]);
      const tree = await client.query<{ id: string }>(
        `INSERT INTO task_trees(workspace_id, name) VALUES ($1,'团队任务树') RETURNING id`,
        [workspaceId],
      );
      const treeId = tree.rows[0]?.id;
      if (!treeId) throw new Error('Task tree creation did not return an id');
      const workstream = await client.query<{ id: string }>(
        `INSERT INTO workstreams(workspace_id, tree_id, name, sort_order)
         VALUES ($1,$2,'默认工作流',0) RETURNING id`,
        [workspaceId, treeId],
      );
      const workstreamId = workstream.rows[0]?.id;
      if (!workstreamId) throw new Error('Workstream creation did not return an id');
      const event = await appendEvent(client, {
        workspaceId,
        aggregateId: workspaceId,
        aggregateType: 'Workspace',
        aggregateVersion: 1,
        eventType: 'WorkspaceCreated',
        actorId: auth.userId,
        commandId: input.commandId,
        correlationId,
        payload: { name: input.name.trim(), timezone: input.timezone, treeId, workstreamId },
      });
      const body = {
        workspace: {
          id: workspaceId,
          name: input.name.trim(),
          timezone: input.timezone,
          role: 'ADMIN',
          tree: { id: treeId, name: '团队任务树' },
          defaultWorkstream: { id: workstreamId, name: '默认工作流' },
        },
        cursor: event.workspaceSequence,
      };
      await storeProcessedCommand(client, {
        workspaceId,
        commandId: input.commandId,
        actorId: auth.userId,
        commandType: 'CreateWorkspace',
        status: 201,
        body,
      });
      return { response: body, events: [event] };
    });
    this.eventHub.publish(events);
    return response;
  }

  async listMembers(auth: AuthContext, workspaceId: string): Promise<unknown[]> {
    await requireMembership(this.pool, workspaceId, auth.userId);
    const result = await this.pool.query(
      `SELECT u.id, u.display_name, u.email::text, wm.role, wm.joined_at
         FROM workspace_memberships wm
         JOIN users u ON u.id = wm.user_id
        WHERE wm.workspace_id = $1 AND wm.status = 'ACTIVE'
        ORDER BY lower(u.display_name), u.id`,
      [workspaceId],
    );
    return result.rows.map((row) => {
      const value = row as MemberRow;
      return {
        id: value.id,
        displayName: value.display_name,
        email: value.email,
        role: value.role,
        joinedAt: value.joined_at.toISOString(),
      };
    });
  }

  async invite(
    auth: AuthContext,
    workspaceId: string,
    input: { commandId: string; email: string; role: 'ADMIN' | 'MEMBER' },
  ): Promise<Record<string, unknown>> {
    const token = randomToken(40);
    const correlationId = randomUUID();
    const result = await inTransaction(this.pool, async (client) => {
      await requireAdmin(client, workspaceId, auth.userId);
      await lockCommand(client, auth.userId, input.commandId);
      const replay = await findProcessedCommand(
        client,
        workspaceId,
        input.commandId,
        auth.userId,
        'InviteWorkspaceMember',
      );
      if (replay) return { response: replay.body, events: [] as EventEnvelope[] };
      const existing = await client.query(
        `SELECT 1 FROM workspace_memberships wm
          JOIN users u ON u.id = wm.user_id
         WHERE wm.workspace_id = $1 AND wm.status = 'ACTIVE' AND u.email = $2`,
        [workspaceId, input.email.trim().toLowerCase()],
      );
      if (existing.rowCount)
        throw new ApiError(409, 'VALIDATION_ERROR', 'User is already a workspace member');

      const invitation = await client.query<{ id: string; expires_at: Date }>(
        `INSERT INTO workspace_invitations(
           workspace_id, email, role, token_hash, invited_by, expires_at
         ) VALUES ($1,$2,$3,$4,$5,clock_timestamp() + interval '7 days')
         RETURNING id, expires_at`,
        [workspaceId, input.email.trim().toLowerCase(), input.role, hashToken(token), auth.userId],
      );
      const row = invitation.rows[0];
      if (!row) throw new Error('Invitation creation did not return a row');
      const event = await appendEvent(client, {
        workspaceId,
        aggregateId: workspaceId,
        aggregateType: 'Workspace',
        aggregateVersion: 1,
        eventType: 'WorkspaceMemberInvited',
        actorId: auth.userId,
        commandId: input.commandId,
        correlationId,
        payload: {
          invitationId: row.id,
          email: input.email.trim().toLowerCase(),
          role: input.role,
        },
      });
      const body = {
        invitation: {
          id: row.id,
          email: input.email.trim().toLowerCase(),
          role: input.role,
          expiresAt: row.expires_at.toISOString(),
          token,
        },
        cursor: event.workspaceSequence,
      };
      await storeProcessedCommand(client, {
        workspaceId,
        commandId: input.commandId,
        actorId: auth.userId,
        commandType: 'InviteWorkspaceMember',
        status: 201,
        body,
      });
      return { response: body, events: [event] };
    });
    this.eventHub.publish(result.events);
    return result.response;
  }

  async acceptInvitation(
    auth: AuthContext,
    input: { commandId: string; token: string },
  ): Promise<Record<string, unknown>> {
    const tokenHash = hashToken(input.token);
    const correlationId = randomUUID();
    const result = await inTransaction(this.pool, async (client) => {
      await lockCommand(client, auth.userId, input.commandId);
      const replayBeforeInvitation = await findActorProcessedCommand(
        client,
        auth.userId,
        input.commandId,
        'AcceptWorkspaceInvitation',
      );
      if (replayBeforeInvitation) {
        return { response: replayBeforeInvitation.body, events: [] as EventEnvelope[] };
      }
      const invitationResult = await client.query<{
        id: string;
        workspace_id: string;
        role: 'ADMIN' | 'MEMBER';
        email: string;
      }>(
        `SELECT wi.id, wi.workspace_id, wi.role, wi.email::text
           FROM workspace_invitations wi
          WHERE wi.token_hash = $1 AND wi.accepted_at IS NULL AND wi.revoked_at IS NULL
            AND wi.expires_at > clock_timestamp()
          FOR UPDATE`,
        [tokenHash],
      );
      const invitation = invitationResult.rows[0];
      if (!invitation)
        throw new ApiError(400, 'VALIDATION_ERROR', 'Invitation is invalid or expired');
      if (invitation.email.toLowerCase() !== auth.email.toLowerCase()) {
        throw new ApiError(
          403,
          'FORBIDDEN',
          'Invitation belongs to a different verified email address',
        );
      }
      const replay = await findProcessedCommand(
        client,
        invitation.workspace_id,
        input.commandId,
        auth.userId,
        'AcceptWorkspaceInvitation',
      );
      if (replay) return { response: replay.body, events: [] as EventEnvelope[] };

      await client.query(
        `INSERT INTO workspace_memberships(workspace_id, user_id, role, status, removed_at)
         VALUES ($1,$2,$3,'ACTIVE',NULL)
         ON CONFLICT (workspace_id, user_id) DO UPDATE
           SET role = EXCLUDED.role, status = 'ACTIVE', removed_at = NULL, joined_at = clock_timestamp()`,
        [invitation.workspace_id, auth.userId, invitation.role],
      );
      await client.query(
        `UPDATE workspace_invitations SET accepted_at = clock_timestamp() WHERE id = $1`,
        [invitation.id],
      );
      const event = await appendEvent(client, {
        workspaceId: invitation.workspace_id,
        aggregateId: invitation.workspace_id,
        aggregateType: 'Workspace',
        aggregateVersion: 1,
        eventType: 'WorkspaceMemberJoined',
        actorId: auth.userId,
        commandId: input.commandId,
        correlationId,
        payload: { userId: auth.userId, role: invitation.role },
      });
      const body = {
        workspaceId: invitation.workspace_id,
        membership: { userId: auth.userId, role: invitation.role },
        cursor: event.workspaceSequence,
      };
      await storeProcessedCommand(client, {
        workspaceId: invitation.workspace_id,
        commandId: input.commandId,
        actorId: auth.userId,
        commandType: 'AcceptWorkspaceInvitation',
        status: 200,
        body,
      });
      return { response: body, events: [event] };
    });
    this.eventHub.publish(result.events);
    return result.response;
  }

  async changeMemberRole(
    auth: AuthContext,
    workspaceId: string,
    targetUserId: string,
    input: { commandId: string; role: 'ADMIN' | 'MEMBER' },
  ): Promise<Record<string, unknown>> {
    const correlationId = randomUUID();
    const result = await inTransaction(this.pool, async (client) => {
      await requireAdmin(client, workspaceId, auth.userId);
      await lockCommand(client, auth.userId, input.commandId);
      const replay = await findProcessedCommand(
        client,
        workspaceId,
        input.commandId,
        auth.userId,
        'ChangeWorkspaceMemberRole',
      );
      if (replay) return { response: replay.body, events: [] as EventEnvelope[] };

      await client.query(`SELECT id FROM workspaces WHERE id = $1 FOR UPDATE`, [workspaceId]);
      const membership = await client.query<{ role: 'ADMIN' | 'MEMBER' }>(
        `SELECT role FROM workspace_memberships
          WHERE workspace_id = $1 AND user_id = $2 AND status = 'ACTIVE'
          FOR UPDATE`,
        [workspaceId, targetUserId],
      );
      const beforeRole = membership.rows[0]?.role;
      if (!beforeRole) {
        throw new ApiError(403, 'FORBIDDEN', 'Workspace access is not available');
      }

      const events: EventEnvelope[] = [];
      if (beforeRole !== input.role) {
        if (beforeRole === 'ADMIN' && input.role === 'MEMBER') {
          const admins = await client.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM workspace_memberships
              WHERE workspace_id = $1 AND role = 'ADMIN' AND status = 'ACTIVE'`,
            [workspaceId],
          );
          if (Number(admins.rows[0]?.count) <= 1) {
            throw new ApiError(
              409,
              'VALIDATION_ERROR',
              'The last workspace administrator cannot be demoted',
            );
          }
        }

        await client.query(
          `UPDATE workspace_memberships SET role = $3
            WHERE workspace_id = $1 AND user_id = $2 AND status = 'ACTIVE'`,
          [workspaceId, targetUserId, input.role],
        );
        events.push(
          await appendEvent(client, {
            workspaceId,
            aggregateId: workspaceId,
            aggregateType: 'Workspace',
            aggregateVersion: 1,
            eventType: 'WorkspaceMemberRoleChanged',
            actorId: auth.userId,
            commandId: input.commandId,
            correlationId,
            payload: { userId: targetUserId, beforeRole, afterRole: input.role },
          }),
        );
      }

      const cursor =
        events.at(-1)?.workspaceSequence ??
        Number(
          (
            await client.query<{ last_sequence: string }>(
              `SELECT last_sequence::text FROM workspace_sync_state WHERE workspace_id = $1`,
              [workspaceId],
            )
          ).rows[0]?.last_sequence ?? 0,
        );
      const body = {
        member: { userId: targetUserId, role: input.role },
        changed: beforeRole !== input.role,
        cursor,
      };
      await storeProcessedCommand(client, {
        workspaceId,
        commandId: input.commandId,
        actorId: auth.userId,
        commandType: 'ChangeWorkspaceMemberRole',
        status: 200,
        body,
      });
      return { response: body, events };
    });
    if (result.events.length > 0) this.eventHub.disconnectMember(workspaceId, targetUserId);
    this.eventHub.publish(result.events);
    return result.response;
  }

  async removeMember(
    auth: AuthContext,
    workspaceId: string,
    targetUserId: string,
    commandId: string,
  ): Promise<Record<string, unknown>> {
    const correlationId = randomUUID();
    const result = await inTransaction(this.pool, async (client) => {
      await requireAdmin(client, workspaceId, auth.userId);
      await lockCommand(client, auth.userId, commandId);
      const replay = await findProcessedCommand(
        client,
        workspaceId,
        commandId,
        auth.userId,
        'RemoveWorkspaceMember',
      );
      if (replay) return { response: replay.body, events: [] as EventEnvelope[] };
      await client.query(`SELECT id FROM workspaces WHERE id = $1 FOR UPDATE`, [workspaceId]);
      const target = await requireMembership(client, workspaceId, targetUserId);
      if (target.role === 'ADMIN') {
        const admins = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM workspace_memberships
            WHERE workspace_id = $1 AND role = 'ADMIN' AND status = 'ACTIVE'`,
          [workspaceId],
        );
        if (Number(admins.rows[0]?.count) <= 1) {
          throw new ApiError(
            409,
            'VALIDATION_ERROR',
            'The last workspace administrator cannot be removed',
          );
        }
      }

      const changedTasks = await client.query<{ id: string; version: number }>(
        `UPDATE tasks SET owner_id = NULL, version = version + 1
          WHERE workspace_id = $1 AND owner_id = $2 AND archived_at IS NULL
          RETURNING id, version`,
        [workspaceId, targetUserId],
      );
      const collaboratorTasks = await client.query<{ task_id: string }>(
        `DELETE FROM task_collaborators tc
          USING tasks t
          WHERE tc.workspace_id = $1 AND tc.user_id = $2
            AND t.workspace_id = tc.workspace_id AND t.id = tc.task_id
            AND t.archived_at IS NULL
          RETURNING tc.task_id`,
        [workspaceId, targetUserId],
      );
      const collaboratorVersions = new Map<string, number>();
      if (collaboratorTasks.rowCount) {
        const ownerTaskIds = new Set(changedTasks.rows.map((task) => task.id));
        const collaboratorOnlyTaskIds = collaboratorTasks.rows
          .map((row) => row.task_id)
          .filter((taskId) => !ownerTaskIds.has(taskId));
        if (collaboratorOnlyTaskIds.length) {
          const updatedCollaboratorTasks = await client.query<{ id: string; version: number }>(
            `UPDATE tasks SET version = version + 1
              WHERE workspace_id = $1 AND id = ANY($2::uuid[])
              RETURNING id, version`,
            [workspaceId, collaboratorOnlyTaskIds],
          );
          for (const task of updatedCollaboratorTasks.rows) {
            collaboratorVersions.set(task.id, task.version);
          }
        }
      }
      await client.query(
        `UPDATE workspace_memberships
            SET status = 'REMOVED', removed_at = clock_timestamp()
          WHERE workspace_id = $1 AND user_id = $2`,
        [workspaceId, targetUserId],
      );

      const events: EventEnvelope[] = [];
      for (const task of changedTasks.rows) {
        collaboratorVersions.set(task.id, task.version);
        events.push(
          await appendEvent(client, {
            workspaceId,
            aggregateId: task.id,
            aggregateVersion: task.version,
            eventType: 'TaskDetailsUpdated',
            actorId: auth.userId,
            commandId,
            correlationId,
            payload: {
              changes: {
                ownerId: { before: targetUserId, after: null, reason: 'workspace_member_removed' },
              },
            },
          }),
        );
      }
      for (const collaboratorTask of collaboratorTasks.rows) {
        const version = collaboratorVersions.get(collaboratorTask.task_id);
        if (!version) continue;
        events.push(
          await appendEvent(client, {
            workspaceId,
            aggregateId: collaboratorTask.task_id,
            aggregateVersion: version,
            eventType: 'TaskCollaboratorRemoved',
            actorId: auth.userId,
            commandId,
            correlationId,
            payload: { collaboratorId: targetUserId },
          }),
        );
      }
      events.push(
        await appendEvent(client, {
          workspaceId,
          aggregateId: workspaceId,
          aggregateType: 'Workspace',
          aggregateVersion: 1,
          eventType: 'WorkspaceMemberRemoved',
          actorId: auth.userId,
          commandId,
          correlationId,
          payload: { userId: targetUserId },
        }),
      );
      const body = {
        removedUserId: targetUserId,
        releasedTaskIds: changedTasks.rows.map((task) => task.id),
        cursor: events.at(-1)?.workspaceSequence ?? 0,
      };
      await storeProcessedCommand(client, {
        workspaceId,
        commandId,
        actorId: auth.userId,
        commandType: 'RemoveWorkspaceMember',
        status: 200,
        body,
      });
      return { response: body, events };
    });
    this.eventHub.disconnectMember(workspaceId, targetUserId);
    this.eventHub.publish(result.events);
    return result.response;
  }
}

interface WorkspaceRow {
  id: string;
  name: string;
  timezone: string;
  role: 'ADMIN' | 'MEMBER';
  tree_id: string;
  tree_name: string;
}

interface MemberRow {
  id: string;
  display_name: string;
  email: string;
  role: 'ADMIN' | 'MEMBER';
  joined_at: Date;
}

function mapWorkspaceRow(row: WorkspaceRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    timezone: row.timezone,
    role: row.role,
    tree: { id: row.tree_id, name: row.tree_name },
  };
}
