import { z } from 'zod';

import {
  ActionLevelSchema,
  BlockTypeSchema,
  ContractSchemaVersion,
  ImportanceSchema,
  IsoDateTimeSchema,
  NonEmptyTextSchema,
  UuidSchema,
} from './common.js';
import { DefinitionOfDoneSchema, TaskDescriptionSchema, TaskTitleSchema } from './task.js';

const CommandMetadataShape = {
  schemaVersion: z.literal(ContractSchemaVersion),
  commandId: UuidSchema,
  workspaceId: UuidSchema,
  correlationId: UuidSchema,
} as const;

const ExistingTaskMetadataShape = {
  ...CommandMetadataShape,
  taskId: UuidSchema,
  expectedVersion: z.number().int().positive(),
} as const;

export const CreateTaskCommandSchema = z
  .object({
    ...CommandMetadataShape,
    type: z.literal('CreateTask'),
    taskId: UuidSchema,
    taskTreeId: UuidSchema,
    workstreamId: UuidSchema,
    title: TaskTitleSchema,
    description: TaskDescriptionSchema.default(''),
    definitionOfDone: DefinitionOfDoneSchema.default(''),
    ownerId: UuidSchema.nullable().default(null),
    collaboratorIds: z.array(UuidSchema).default([]),
    importance: ImportanceSchema.default(3),
    deadlineAt: IsoDateTimeSchema.nullable().default(null),
  })
  .strict();

export const UpdateTaskDetailsCommandSchema = z
  .object({
    ...ExistingTaskMetadataShape,
    type: z.literal('UpdateTaskDetails'),
    title: TaskTitleSchema.optional(),
    description: TaskDescriptionSchema.optional(),
    definitionOfDone: DefinitionOfDoneSchema.optional(),
    deadlineAt: IsoDateTimeSchema.nullable().optional(),
    manualOrder: z.number().finite().nullable().optional(),
  })
  .strict()
  .refine(
    (command) =>
      command.title !== undefined ||
      command.description !== undefined ||
      command.definitionOfDone !== undefined ||
      command.deadlineAt !== undefined ||
      command.manualOrder !== undefined,
    'At least one task detail must be supplied',
  );

const taskCommand = <TType extends string>(type: TType) =>
  z
    .object({
      ...ExistingTaskMetadataShape,
      type: z.literal(type),
    })
    .strict();

export const StartTaskCommandSchema = taskCommand('StartTask');
export const PauseTaskCommandSchema = taskCommand('PauseTask');
export const ReleaseTaskCommandSchema = taskCommand('ReleaseTask');
export const UnblockTaskCommandSchema = taskCommand('UnblockTask');
export const RequestReviewCommandSchema = taskCommand('RequestReview');
export const RequestChangesCommandSchema = taskCommand('RequestChanges');
export const CompleteTaskCommandSchema = taskCommand('CompleteTask');
export const CancelTaskCommandSchema = taskCommand('CancelTask');
export const ReopenTaskCommandSchema = taskCommand('ReopenTask');
export const ArchiveTaskCommandSchema = taskCommand('ArchiveTask');
export const ClearActionOverrideCommandSchema = taskCommand('ClearActionOverride');

export const TransferOwnerCommandSchema = z
  .object({
    ...ExistingTaskMetadataShape,
    type: z.literal('TransferOwner'),
    targetOwnerId: UuidSchema,
  })
  .strict();

export const RequestOwnerTransferCommandSchema = taskCommand('RequestOwnerTransfer');

export const AddCollaboratorCommandSchema = z
  .object({
    ...ExistingTaskMetadataShape,
    type: z.literal('AddCollaborator'),
    collaboratorId: UuidSchema,
  })
  .strict();

export const RemoveCollaboratorCommandSchema = z
  .object({
    ...ExistingTaskMetadataShape,
    type: z.literal('RemoveCollaborator'),
    collaboratorId: UuidSchema,
  })
  .strict();

export const BlockTaskCommandSchema = z
  .object({
    ...ExistingTaskMetadataShape,
    type: z.literal('BlockTask'),
    blockType: BlockTypeSchema,
    reason: NonEmptyTextSchema.max(1_000),
  })
  .strict();

export const SetImportanceCommandSchema = z
  .object({
    ...ExistingTaskMetadataShape,
    type: z.literal('SetImportance'),
    importance: ImportanceSchema,
  })
  .strict();

export const SetActionOverrideCommandSchema = z
  .object({
    ...ExistingTaskMetadataShape,
    type: z.literal('SetActionOverride'),
    level: ActionLevelSchema,
    reason: NonEmptyTextSchema.max(500),
    expiresAt: IsoDateTimeSchema,
  })
  .strict();

export const AddDependencyCommandSchema = z
  .object({
    ...CommandMetadataShape,
    type: z.literal('AddDependency'),
    prerequisiteTaskId: UuidSchema,
    dependentTaskId: UuidSchema,
    expectedPrerequisiteVersion: z.number().int().positive(),
    expectedDependentVersion: z.number().int().positive(),
  })
  .strict()
  .refine((command) => command.prerequisiteTaskId !== command.dependentTaskId, {
    message: 'A task cannot block itself',
    path: ['dependentTaskId'],
  });

export const RemoveDependencyCommandSchema = z
  .object({
    ...CommandMetadataShape,
    type: z.literal('RemoveDependency'),
    prerequisiteTaskId: UuidSchema,
    dependentTaskId: UuidSchema,
    expectedPrerequisiteVersion: z.number().int().positive(),
    expectedDependentVersion: z.number().int().positive(),
  })
  .strict();

export const TaskCommandSchema = z.discriminatedUnion('type', [
  CreateTaskCommandSchema,
  UpdateTaskDetailsCommandSchema,
  StartTaskCommandSchema,
  PauseTaskCommandSchema,
  ReleaseTaskCommandSchema,
  TransferOwnerCommandSchema,
  RequestOwnerTransferCommandSchema,
  AddCollaboratorCommandSchema,
  RemoveCollaboratorCommandSchema,
  BlockTaskCommandSchema,
  UnblockTaskCommandSchema,
  RequestReviewCommandSchema,
  RequestChangesCommandSchema,
  CompleteTaskCommandSchema,
  CancelTaskCommandSchema,
  ReopenTaskCommandSchema,
  ArchiveTaskCommandSchema,
  SetImportanceCommandSchema,
  SetActionOverrideCommandSchema,
  ClearActionOverrideCommandSchema,
  AddDependencyCommandSchema,
  RemoveDependencyCommandSchema,
]);
export type TaskCommand = z.infer<typeof TaskCommandSchema>;

export const CommandAcceptedSchema = z
  .object({
    schemaVersion: z.literal(ContractSchemaVersion),
    commandId: UuidSchema,
    workspaceSequence: z.number().int().nonnegative(),
    aggregateVersion: z.number().int().positive(),
  })
  .strict();
export type CommandAccepted = z.infer<typeof CommandAcceptedSchema>;
