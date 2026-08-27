import { randomUUID } from 'node:crypto';
import type { DatabaseClient } from '../../db/pool';
import { ApiError } from '../../lib/errors';
import type { EventEnvelope } from '../sync/event-hub';

interface AppendEventInput {
  workspaceId: string;
  aggregateId: string;
  aggregateVersion: number;
  eventType: string;
  actorType?: EventEnvelope['actorType'];
  actorId: string | null;
  commandId: string;
  correlationId?: string | null;
  causationId?: string | null;
  payload?: Record<string, unknown>;
  aggregateType?: string;
}

export async function lockCommand(
  client: DatabaseClient,
  actorId: string,
  commandId: string,
): Promise<void> {
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtextextended($1::text || ':' || $2::text, 0))`,
    [actorId, commandId],
  );
}

export async function appendEvent(
  client: DatabaseClient,
  input: AppendEventInput,
): Promise<EventEnvelope> {
  const sequenceResult = await client.query<{ last_sequence: string }>(
    `UPDATE workspace_sync_state
        SET last_sequence = last_sequence + 1, updated_at = clock_timestamp()
      WHERE workspace_id = $1
      RETURNING last_sequence`,
    [input.workspaceId],
  );
  const sequence = Number(sequenceResult.rows[0]?.last_sequence);
  if (!Number.isSafeInteger(sequence)) throw new Error('Workspace sync sequence is unavailable');

  const eventId = randomUUID();
  const result = await client.query<{
    occurred_at: Date;
  }>(
    `INSERT INTO task_events(
       event_id, workspace_id, workspace_sequence, aggregate_type, aggregate_id,
       aggregate_version, event_type, schema_version, actor_type, actor_id,
       command_id, correlation_id, causation_id, payload
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,$9,$10,$11,$12,$13::jsonb)
     RETURNING occurred_at`,
    [
      eventId,
      input.workspaceId,
      sequence,
      input.aggregateType ?? 'Task',
      input.aggregateId,
      input.aggregateVersion,
      input.eventType,
      input.actorType ?? 'human',
      input.actorId,
      input.commandId,
      input.correlationId ?? null,
      input.causationId ?? null,
      JSON.stringify(input.payload ?? {}),
    ],
  );

  return {
    eventId,
    workspaceId: input.workspaceId,
    workspaceSequence: sequence,
    aggregateType: input.aggregateType ?? 'Task',
    aggregateId: input.aggregateId,
    aggregateVersion: input.aggregateVersion,
    eventType: input.eventType,
    schemaVersion: 1,
    actorType: input.actorType ?? 'human',
    actorId: input.actorId,
    occurredAt: result.rows[0]?.occurred_at.toISOString() ?? new Date().toISOString(),
    commandId: input.commandId,
    correlationId: input.correlationId ?? null,
    causationId: input.causationId ?? null,
    payload: input.payload ?? {},
  };
}

export async function findProcessedCommand(
  client: DatabaseClient,
  workspaceId: string,
  commandId: string,
  actorId: string,
  commandType: string,
): Promise<{ status: number; body: Record<string, unknown> } | undefined> {
  const result = await client.query<{
    workspace_id: string;
    command_type: string;
    response_status: number;
    response_body: Record<string, unknown>;
  }>(
    `SELECT workspace_id, command_type, response_status, response_body
       FROM processed_commands
      WHERE actor_id = $1 AND command_id = $2`,
    [actorId, commandId],
  );
  const row = result.rows[0];
  if (!row) return undefined;
  if (row.workspace_id !== workspaceId || row.command_type !== commandType) {
    throw new ApiError(
      409,
      'VALIDATION_ERROR',
      'commandId was already used for a different command',
    );
  }
  return { status: row.response_status, body: row.response_body };
}

export async function findActorProcessedCommand(
  client: DatabaseClient,
  actorId: string,
  commandId: string,
  commandType: string,
): Promise<{ status: number; body: Record<string, unknown> } | undefined> {
  const result = await client.query<{
    command_type: string;
    response_status: number;
    response_body: Record<string, unknown>;
  }>(
    `SELECT command_type, response_status, response_body
       FROM processed_commands
      WHERE actor_id = $1 AND command_id = $2`,
    [actorId, commandId],
  );
  const row = result.rows[0];
  if (row && row.command_type !== commandType) {
    throw new ApiError(
      409,
      'VALIDATION_ERROR',
      'commandId was already used for a different command',
    );
  }
  return row ? { status: row.response_status, body: row.response_body } : undefined;
}

export async function storeProcessedCommand(
  client: DatabaseClient,
  input: {
    workspaceId: string;
    commandId: string;
    actorId: string;
    commandType: string;
    status: number;
    body: Record<string, unknown>;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO processed_commands(
       workspace_id, command_id, actor_id, command_type, response_status, response_body
     ) VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
    [
      input.workspaceId,
      input.commandId,
      input.actorId,
      input.commandType,
      input.status,
      JSON.stringify(input.body),
    ],
  );
}
