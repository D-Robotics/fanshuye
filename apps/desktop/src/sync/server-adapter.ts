import {
  ApiErrorSchema,
  CreateTaskRequestSchema,
  EventEnvelopeSchema,
  IncrementalSyncResponseSchema,
  RealtimeServerMessageSchema,
  SyncSnapshotResponseSchema,
  TaskCommandResultSchema,
  TaskEventTypeSchema,
  TaskMutationRequestSchema,
  UuidSchema,
  WireApiErrorSchema,
  WireTaskProjectionSchema,
  parseSupportedTaskEvent,
  type BlockType,
  type EventEnvelope,
  type TaskDomainEvent,
  type WireTaskProjection,
} from '@fanshuye/contracts';
import type { ManualBlock, TaskCommandRequest, TaskDraft, TaskItem } from '@fanshuye/ui';
import type { z } from 'zod';
import type { ConfirmedSnapshot } from './cache';

// These aliases make the desktop boundary explicit while keeping the runtime
// validator owned by @fanshuye/contracts rather than duplicating it locally.
export const ServerTaskProjectionSchema = WireTaskProjectionSchema;
export const ServerTaskCommandSchema = TaskMutationRequestSchema;
export const ServerCreateTaskInputSchema = CreateTaskRequestSchema;

export type ServerTaskProjection = WireTaskProjection;
export type ServerTaskCommand = z.input<typeof TaskMutationRequestSchema>;
export type ServerCreateTaskInput = z.input<typeof CreateTaskRequestSchema>;
export type ParsedServerEvent = TaskDomainEvent | EventEnvelope;

export interface ParsedApiError {
  code: string;
  message: string;
  details: Record<string, unknown>;
}

export function parseApiError(input: unknown): ParsedApiError | null {
  const sharedDomainError = ApiErrorSchema.safeParse(input);
  if (sharedDomainError.success) return sharedDomainError.data.error;
  const wireError = WireApiErrorSchema.safeParse(input);
  return wireError.success ? wireError.data.error : null;
}

export function parseServerSnapshot(input: unknown): ConfirmedSnapshot {
  const snapshot = SyncSnapshotResponseSchema.parse(input);
  const workstreamNames = new Map(snapshot.workstreams.map((item) => [item.id, item.name]));
  return {
    workspaceId: snapshot.workspace.id,
    cursor: snapshot.snapshotCursor,
    capturedAt: snapshot.capturedAt,
    workspace: snapshot.workspace,
    workstreams: snapshot.workstreams,
    members: snapshot.members,
    dependencies: snapshot.dependencies.map((dependency) => ({
      prerequisiteTaskId: dependency.prerequisiteTaskId,
      dependentTaskId: dependency.dependentTaskId,
      relationType: dependency.relationType,
    })),
    tasks: snapshot.tasks.map((task, index) =>
      mapServerTask(task, workstreamNames.get(task.workstreamId), index),
    ),
  };
}

export function parseServerCommandResult(
  input: unknown,
  workstreamName?: string,
): { task: TaskItem; cursor: number } {
  const result = TaskCommandResultSchema.parse(input);
  return {
    task: mapServerTask(result.task, workstreamName),
    cursor: result.cursor,
  };
}

export function parseServerIncremental(input: unknown): {
  events: ParsedServerEvent[];
  currentCursor: number;
  hasMore: boolean;
} {
  const response = IncrementalSyncResponseSchema.parse(input);
  return {
    events: response.events.map(parseServerEvent),
    currentCursor: response.currentCursor,
    hasMore: response.hasMore,
  };
}

export type ParsedRealtimeMessage =
  | { kind: 'ready'; workspaceId: string }
  | { kind: 'pong' }
  | { kind: 'event'; event: ParsedServerEvent };

export function parseRealtimeMessage(input: unknown): ParsedRealtimeMessage {
  const message = RealtimeServerMessageSchema.parse(input);
  if (message.type === 'ready') return { kind: 'ready', workspaceId: message.workspaceId };
  if (message.type === 'pong') return { kind: 'pong' };
  return { kind: 'event', event: parseServerEvent(message.event) };
}

export function parseServerEvent(input: unknown): ParsedServerEvent {
  const envelope = EventEnvelopeSchema.parse(input);
  if (envelope.aggregateType !== 'Task') return envelope;
  if (!TaskEventTypeSchema.safeParse(envelope.eventType).success) return envelope;
  return parseSupportedTaskEvent(envelope);
}

export function parseConflictTask(
  details: Record<string, unknown>,
  workstreamName?: string,
): TaskItem | null {
  const parsed = WireTaskProjectionSchema.safeParse(details.task);
  return parsed.success ? mapServerTask(parsed.data, workstreamName) : null;
}

export function buildServerTaskCommand(
  request: TaskCommandRequest,
  commandId: string,
  currentMemberId: string,
): z.output<typeof TaskMutationRequestSchema> {
  const base = { commandId, expectedVersion: request.expectedVersion };
  const memberId = () => UuidSchema.parse(currentMemberId);
  let command: unknown;
  switch (request.name) {
    case 'claim-and-start':
    case 'start':
      command = { ...base, type: 'StartTask' };
      break;
    case 'join':
      command = { ...base, type: 'AddCollaborator', userId: memberId() };
      break;
    case 'request-transfer':
      // The server derives the requester from the authenticated session. A
      // takeover request must never be serialized as an ownership transfer.
      command = { ...base, type: 'RequestOwnerTransfer' };
      break;
    case 'transfer':
      command = { ...base, type: 'TransferOwner', ownerId: request.payload?.ownerId };
      break;
    case 'pause':
      command = { ...base, type: 'PauseTask' };
      break;
    case 'release':
      command = { ...base, type: 'ReleaseTask' };
      break;
    case 'block':
      command = {
        ...base,
        type: 'BlockTask',
        blockType: mapBlockType(request.payload?.type),
        reason: request.payload?.reason,
      };
      break;
    case 'unblock':
      command = { ...base, type: 'UnblockTask' };
      break;
    case 'request-review':
      command = { ...base, type: 'RequestReview' };
      break;
    case 'request-changes':
      command = { ...base, type: 'RequestChanges' };
      break;
    case 'complete':
      command = { ...base, type: 'CompleteTask' };
      break;
    case 'cancel':
      command = { ...base, type: 'CancelTask' };
      break;
    case 'reopen':
      command = { ...base, type: 'ReopenTask' };
      break;
  }
  return TaskMutationRequestSchema.parse(command);
}

export function buildCreateTaskInput(
  draft: TaskDraft,
  commandId: string,
): z.output<typeof CreateTaskRequestSchema> {
  return CreateTaskRequestSchema.parse({
    commandId,
    title: draft.title,
    description: draft.description,
    definitionOfDone: draft.definitionOfDone,
    importance: draft.importance,
    dueAt: draft.dueAt,
    ownerId: draft.ownerId,
    collaboratorIds: draft.collaboratorIds,
    ...(draft.workstreamId.length === 0 ? {} : { workstreamId: draft.workstreamId }),
  });
}

export function buildUpdateTaskCommand(
  draft: TaskDraft,
  expectedVersion: number,
  commandId: string,
): z.output<typeof TaskMutationRequestSchema> {
  return TaskMutationRequestSchema.parse({
    type: 'UpdateTaskDetails',
    commandId,
    expectedVersion,
    title: draft.title,
    description: draft.description,
    definitionOfDone: draft.definitionOfDone,
    dueAt: draft.dueAt,
  });
}

function mapServerTask(
  task: ServerTaskProjection,
  workstreamName = '未命名工作流',
  fallbackOrder = 0,
): TaskItem {
  const manualOrder = task.manualOrder === null ? Number.NaN : Number(task.manualOrder);
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    definitionOfDone: task.definitionOfDone,
    status: task.status,
    actionLevel: task.actionLevel,
    actionReason: describeActionReasons(task.actionReasons),
    importance: toUiImportance(task.importance),
    workstreamId: task.workstreamId,
    workstreamName,
    ownerId: task.owner?.id ?? null,
    ownerName: task.owner?.displayName ?? null,
    collaboratorIds: task.collaborators.map((member) => member.id),
    collaboratorNames: task.collaborators.map((member) => member.displayName),
    dueAt: task.dueAt,
    manualBlock:
      task.manualBlock === null
        ? null
        : {
            type: mapUiBlockType(task.manualBlock.type),
            reason: task.manualBlock.reason ?? '未填写阻塞原因',
          },
    prerequisites: task.prerequisites.map(mapRelation),
    incompletePrerequisites: task.incompletePrerequisites.map(mapRelation),
    dependents: task.dependents.map(mapRelation),
    externalReferences: task.externalReferences.map((reference) => ({
      id: reference.id,
      label: reference.displayName,
      type: mapReferenceType(reference.referenceType),
      url: reference.url,
    })),
    timeline: [],
    version: task.version,
    stableOrder: Number.isFinite(manualOrder) ? manualOrder : fallbackOrder,
    updatedAt: task.updatedAt,
    archivedAt: task.archivedAt,
  };
}

function mapRelation(task: ServerTaskProjection['incompletePrerequisites'][number]) {
  return { taskId: task.id, title: task.title, status: task.status };
}

function toUiImportance(value: number): TaskItem['importance'] {
  if (value === 1 || value === 2 || value === 3 || value === 4 || value === 5) return value;
  throw new Error('服务端返回了无效的重要度。');
}

function mapBlockType(input: unknown): BlockType {
  const values: Record<string, BlockType> = {
    technical: 'TECHNICAL',
    decision: 'DECISION',
    resource: 'CAPACITY',
    external: 'EXTERNAL',
    other: 'OTHER',
  };
  return typeof input === 'string' ? (values[input] ?? 'OTHER') : 'OTHER';
}

function mapUiBlockType(value: BlockType): ManualBlock['type'] {
  const values: Record<BlockType, ManualBlock['type']> = {
    TECHNICAL: 'technical',
    EXTERNAL: 'external',
    DECISION: 'decision',
    CAPACITY: 'resource',
    OTHER: 'other',
  };
  return values[value];
}

function mapReferenceType(value: string): TaskItem['externalReferences'][number]['type'] {
  switch (value.toUpperCase()) {
    case 'REPOSITORY':
      return 'repository';
    case 'ISSUE':
      return 'issue';
    case 'PULL_REQUEST':
      return 'pull-request';
    case 'DOCUMENT':
      return 'document';
    default:
      return 'other';
  }
}

function describeActionReasons(reasons: string[]): string {
  const labels: Record<string, string> = {
    DEFAULT: '按默认优先级排列',
    DEADLINE_OVERDUE: '已经超过截止时间',
    DEADLINE_WITHIN_24_HOURS: '将在 24 小时内到期',
    DEADLINE_WITHIN_7_CALENDAR_DAYS: '将在 7 天内到期',
    HIGH_IMPORTANCE: '任务重要度较高',
    UNLOCKS_DOWNSTREAM: '完成后可解除下游阻塞',
    MANUAL_OVERRIDE: '团队手动调整了行动等级',
  };
  return reasons.map((reason) => labels[reason] ?? reason).join('；') || '按默认优先级排列';
}
