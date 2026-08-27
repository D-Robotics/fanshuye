import { z } from 'zod';

import {
  ActionLevelSchema,
  BlockTypeSchema,
  ContractSchemaVersion,
  ImportanceSchema,
  IsoDateTimeSchema,
  LeafSizeSchema,
  TaskStatusSchema,
  UuidSchema,
  WorkspaceRoleSchema,
} from './common.js';
import { EventEnvelopeSchema } from './events.js';

const VersionField = z.literal(ContractSchemaVersion).default(ContractSchemaVersion);
const boundedText = (maximum: number) => z.string().trim().max(maximum);

export const WireMemberReferenceSchema = z
  .object({ id: UuidSchema, displayName: z.string().trim().min(1).max(100) })
  .strict();

export const WireRelatedTaskSchema = z
  .object({
    id: UuidSchema,
    title: z.string().trim().min(1).max(240),
    status: TaskStatusSchema,
    version: z.number().int().positive(),
    incomplete: z.boolean().optional(),
  })
  .strict();

export const WireTaskProjectionSchema = z
  .object({
    id: UuidSchema,
    workspaceId: UuidSchema,
    treeId: UuidSchema,
    workstreamId: UuidSchema,
    title: z.string().trim().min(1).max(240),
    description: z.string().max(100_000),
    definitionOfDone: z.string().max(50_000),
    owner: WireMemberReferenceSchema.nullable(),
    collaborators: z.array(WireMemberReferenceSchema).max(100),
    status: TaskStatusSchema,
    manualBlock: z
      .object({ type: BlockTypeSchema, reason: z.string().nullable() })
      .strict()
      .nullable(),
    manualBlocked: z.boolean(),
    dependencyBlocked: z.boolean(),
    effectiveBlocked: z.boolean(),
    incompletePrerequisites: z.array(WireRelatedTaskSchema),
    prerequisites: z.array(WireRelatedTaskSchema),
    dependents: z.array(WireRelatedTaskSchema),
    importance: ImportanceSchema,
    leafSize: LeafSizeSchema,
    dueAt: IsoDateTimeSchema.nullable(),
    overdue: z.boolean(),
    actionLevel: ActionLevelSchema,
    actionReasons: z.array(z.string().trim().min(1)),
    actionOverride: z
      .object({
        level: ActionLevelSchema,
        reason: z.string().nullable(),
        expiresAt: IsoDateTimeSchema,
        active: z.boolean(),
      })
      .strict()
      .nullable(),
    manualOrder: z.union([z.number(), z.string()]).nullable(),
    version: z.number().int().positive(),
    archivedAt: IsoDateTimeSchema.nullable(),
    createdBy: WireMemberReferenceSchema,
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    externalReferences: z.array(
      z
        .object({
          id: UuidSchema,
          referenceType: z.string().trim().min(1).max(40),
          displayName: z.string().trim().min(1).max(160),
          url: z.url(),
        })
        .strict(),
    ),
    workspaceTimezone: z.string().trim().min(1).max(64),
  })
  .strict();
export type WireTaskProjection = z.infer<typeof WireTaskProjectionSchema>;

const commandBase = {
  schemaVersion: VersionField,
  commandId: UuidSchema,
  expectedVersion: z.number().int().positive(),
} as const;

export const TaskMutationRequestSchema = z.discriminatedUnion('type', [
  z
    .object({
      ...commandBase,
      type: z.literal('UpdateTaskDetails'),
      title: boundedText(240).min(1).optional(),
      description: boundedText(100_000).optional(),
      definitionOfDone: boundedText(50_000).optional(),
      dueAt: IsoDateTimeSchema.nullable().optional(),
    })
    .strict()
    .refine(
      (value) =>
        value.title !== undefined ||
        value.description !== undefined ||
        value.definitionOfDone !== undefined ||
        value.dueAt !== undefined,
      'At least one task detail must be supplied',
    ),
  z.object({ ...commandBase, type: z.literal('StartTask') }).strict(),
  z.object({ ...commandBase, type: z.literal('PauseTask') }).strict(),
  z.object({ ...commandBase, type: z.literal('ReleaseTask') }).strict(),
  z.object({ ...commandBase, type: z.literal('TransferOwner'), ownerId: UuidSchema }).strict(),
  z.object({ ...commandBase, type: z.literal('RequestOwnerTransfer') }).strict(),
  z.object({ ...commandBase, type: z.literal('AddCollaborator'), userId: UuidSchema }).strict(),
  z.object({ ...commandBase, type: z.literal('RemoveCollaborator'), userId: UuidSchema }).strict(),
  z
    .object({
      ...commandBase,
      type: z.literal('BlockTask'),
      blockType: BlockTypeSchema,
      reason: boundedText(1_000).min(1),
    })
    .strict(),
  z.object({ ...commandBase, type: z.literal('UnblockTask') }).strict(),
  z.object({ ...commandBase, type: z.literal('RequestReview') }).strict(),
  z.object({ ...commandBase, type: z.literal('RequestChanges') }).strict(),
  z.object({ ...commandBase, type: z.literal('CompleteTask') }).strict(),
  z.object({ ...commandBase, type: z.literal('CancelTask') }).strict(),
  z.object({ ...commandBase, type: z.literal('ReopenTask') }).strict(),
  z
    .object({ ...commandBase, type: z.literal('SetImportance'), importance: ImportanceSchema })
    .strict(),
  z
    .object({
      ...commandBase,
      type: z.literal('SetActionOverride'),
      level: ActionLevelSchema,
      reason: boundedText(500).min(1),
      expiresAt: IsoDateTimeSchema,
    })
    .strict(),
  z.object({ ...commandBase, type: z.literal('ClearActionOverride') }).strict(),
  z
    .object({ ...commandBase, type: z.literal('AddDependency'), prerequisiteTaskId: UuidSchema })
    .strict(),
  z
    .object({ ...commandBase, type: z.literal('RemoveDependency'), prerequisiteTaskId: UuidSchema })
    .strict(),
]);
export type TaskMutationRequest = z.infer<typeof TaskMutationRequestSchema>;

export const CreateTaskRequestSchema = z
  .object({
    schemaVersion: VersionField,
    commandId: UuidSchema,
    title: boundedText(240).min(1),
    description: boundedText(100_000).default(''),
    definitionOfDone: boundedText(50_000).default(''),
    importance: ImportanceSchema.default(3),
    dueAt: IsoDateTimeSchema.nullable().default(null),
    ownerId: UuidSchema.nullable().default(null),
    collaboratorIds: z.array(UuidSchema).max(100).default([]),
    workstreamId: UuidSchema.optional(),
  })
  .strict();
export type CreateTaskRequest = z.infer<typeof CreateTaskRequestSchema>;

export const ExternalReferenceRequestSchema = z
  .object({
    schemaVersion: VersionField,
    commandId: UuidSchema,
    expectedVersion: z.number().int().positive(),
    referenceType: boundedText(40).min(1),
    displayName: boundedText(160).min(1),
    url: z.url().max(2_048),
  })
  .strict();

export const ListTasksWireQuerySchema = z.object({
  search: z.string().trim().max(240).optional(),
  status: TaskStatusSchema.optional(),
  ownerId: UuidSchema.optional(),
  workstreamId: UuidSchema.optional(),
  active: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});

export const TaskCommandResultSchema = z
  .object({
    schemaVersion: VersionField,
    task: WireTaskProjectionSchema,
    cursor: z.number().int().nonnegative(),
    replayedNoOp: z.boolean().optional(),
  })
  .strict();
export type TaskCommandResult = z.infer<typeof TaskCommandResultSchema>;

export const TaskDetailResponseSchema = z
  .object({ schemaVersion: VersionField, task: WireTaskProjectionSchema })
  .strict();

export const TaskListResponseSchema = z
  .object({
    schemaVersion: VersionField,
    tasks: z.array(WireTaskProjectionSchema),
    page: z
      .object({
        limit: z.number().int().positive(),
        offset: z.number().int().nonnegative(),
        returned: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export const SyncSnapshotResponseSchema = z
  .object({
    schemaVersion: z.literal(ContractSchemaVersion),
    snapshotCursor: z.number().int().nonnegative(),
    capturedAt: IsoDateTimeSchema,
    workspace: z
      .object({
        id: UuidSchema,
        name: z.string().trim().min(1).max(120),
        timezone: z.string().trim().min(1).max(64),
        tree: z.object({ id: UuidSchema, name: z.string().trim().min(1).max(120) }).strict(),
      })
      .strict(),
    workstreams: z.array(
      z
        .object({
          id: UuidSchema,
          name: z.string().trim().min(1).max(120),
          sortOrder: z.number().int(),
        })
        .strict(),
    ),
    members: z.array(
      z
        .object({
          id: UuidSchema,
          displayName: z.string().trim().min(1).max(100),
          role: WorkspaceRoleSchema,
        })
        .strict(),
    ),
    tasks: z.array(WireTaskProjectionSchema),
    dependencies: z.array(
      z
        .object({
          id: UuidSchema,
          prerequisiteTaskId: UuidSchema,
          dependentTaskId: UuidSchema,
          relationType: z.literal('BLOCKS'),
        })
        .strict(),
    ),
  })
  .strict();
export type SyncSnapshotResponse = z.infer<typeof SyncSnapshotResponseSchema>;

export const IncrementalSyncResponseSchema = z
  .object({
    schemaVersion: z.literal(ContractSchemaVersion),
    events: z.array(EventEnvelopeSchema),
    nextCursor: z.number().int().nonnegative(),
    currentCursor: z.number().int().nonnegative(),
    hasMore: z.boolean(),
  })
  .strict();
export type IncrementalSyncResponse = z.infer<typeof IncrementalSyncResponseSchema>;

export const RealtimeServerMessageSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('ready'),
      workspaceId: UuidSchema,
      schemaVersion: z.literal(ContractSchemaVersion),
    })
    .strict(),
  z.object({ type: z.literal('pong') }).strict(),
  z.object({ type: z.literal('event'), event: EventEnvelopeSchema }).strict(),
]);
export type RealtimeServerMessage = z.infer<typeof RealtimeServerMessageSchema>;

export const WireApiErrorCodeSchema = z.enum([
  'AUTHENTICATION_REQUIRED',
  'INVALID_CREDENTIALS',
  'EMAIL_NOT_VERIFIED',
  'FORBIDDEN',
  'NOT_FOUND',
  'VALIDATION_ERROR',
  'VERSION_CONFLICT',
  'CLAIM_CONFLICT',
  'INVALID_TRANSITION',
  'TASK_BLOCKED',
  'DEPENDENCY_CYCLE',
  'DEPENDENCY_CONFLICT',
  'SNAPSHOT_REQUIRED',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
]);

export const WireApiErrorSchema = z
  .object({
    schemaVersion: VersionField,
    error: z
      .object({
        code: WireApiErrorCodeSchema,
        message: z.string().min(1),
        details: z.record(z.string(), z.unknown()).default({}),
        correlationId: z.string().min(1).nullable().optional(),
      })
      .strict(),
  })
  .strict();
export type WireApiError = z.infer<typeof WireApiErrorSchema>;
