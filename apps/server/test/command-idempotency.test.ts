import { describe, expect, it, vi } from 'vitest';

import type { DatabaseClient } from '../src/db/pool';
import {
  findActorProcessedCommand,
  findProcessedCommand,
  lockCommand,
  storeProcessedCommand,
} from '../src/modules/audit/events';

const workspaceId = '80000000-0000-4000-8000-000000000001';
const actorId = '80000000-0000-4000-8000-000000000002';
const commandId = '80000000-0000-4000-8000-000000000003';

describe('processed command idempotency boundary', () => {
  it('replays the original status and body for the same actor, workspace and command type', async () => {
    const originalBody = { task: { id: '80000000-0000-4000-8000-000000000004', version: 2 } };
    const { client, query } = fakeClient([
      {
        workspace_id: workspaceId,
        command_type: 'StartTask',
        response_status: 200,
        response_body: originalBody,
      },
    ]);

    await expect(
      findProcessedCommand(client, workspaceId, commandId, actorId, 'StartTask'),
    ).resolves.toEqual({ status: 200, body: originalBody });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[1]).toEqual([actorId, commandId]);
  });

  it.each([
    {
      label: 'workspace',
      requestedWorkspaceId: '80000000-0000-4000-8000-000000000099',
      requestedCommandType: 'StartTask',
    },
    {
      label: 'command type',
      requestedWorkspaceId: workspaceId,
      requestedCommandType: 'CompleteTask',
    },
  ])('rejects commandId reuse for a different $label', async (request) => {
    const { client } = fakeClient([
      {
        workspace_id: workspaceId,
        command_type: 'StartTask',
        response_status: 200,
        response_body: { task: { version: 2 } },
      },
    ]);

    await expect(
      findProcessedCommand(
        client,
        request.requestedWorkspaceId,
        commandId,
        actorId,
        request.requestedCommandType,
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'VALIDATION_ERROR',
      message: 'commandId was already used for a different command',
    });
  });

  it('returns no replay for an unseen command and rejects actor-scoped type reuse', async () => {
    const missing = fakeClient([]);
    await expect(
      findActorProcessedCommand(missing.client, actorId, commandId, 'CreateWorkspace'),
    ).resolves.toBeUndefined();

    const reused = fakeClient([
      {
        command_type: 'CreateWorkspace',
        response_status: 201,
        response_body: { workspace: { id: workspaceId } },
      },
    ]);
    await expect(
      findActorProcessedCommand(reused.client, actorId, commandId, 'AcceptWorkspaceInvitation'),
    ).rejects.toMatchObject({ statusCode: 409, code: 'VALIDATION_ERROR' });
  });

  it('locks the actor-command key and stores the exact replay payload', async () => {
    const { client, query } = fakeClient([]);
    const body = { task: { id: '80000000-0000-4000-8000-000000000004', version: 3 } };

    await lockCommand(client, actorId, commandId);
    await storeProcessedCommand(client, {
      workspaceId,
      actorId,
      commandId,
      commandType: 'CompleteTask',
      status: 200,
      body,
    });

    expect(query).toHaveBeenNthCalledWith(1, expect.stringContaining('pg_advisory_xact_lock'), [
      actorId,
      commandId,
    ]);
    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('INSERT INTO processed_commands'),
      [workspaceId, commandId, actorId, 'CompleteTask', 200, JSON.stringify(body)],
    );
  });
});

function fakeClient(rows: unknown[]): {
  client: DatabaseClient;
  query: ReturnType<typeof vi.fn>;
} {
  const query = vi.fn().mockResolvedValue({ rows, rowCount: rows.length });
  return { client: { query } as unknown as DatabaseClient, query };
}
