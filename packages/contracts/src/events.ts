import { z } from 'zod';

import {
  ActorTypeSchema,
  BlockTypeSchema,
  ContractSchemaVersion,
  ImportanceSchema,
  IsoDateTimeSchema,
  TaskStatusSchema,
  UuidSchema,
} from './common.js';

export const TaskEventTypeSchema = z.enum([
  'TaskCreated',
  'TaskDetailsUpdated',
  'TaskStarted',
  'TaskPaused',
  'TaskReleased',
  'TaskOwnerTransferRequested',
  'TaskReviewRequested',
  'TaskChangesRequested',
  'TaskCompleted',
  'TaskCanceled',
  'TaskReopened',
  'TaskArchived',
  'TaskBlocked',
  'TaskUnblocked',
  'TaskOwnerTransferred',
  'TaskCollaboratorAdded',
  'TaskCollaboratorRemoved',
  'TaskImportanceChanged',
  'TaskActionOverrideSet',
  'TaskActionOverrideCleared',
  'DependencyAdded',
  'DependencyRemoved',
  'TaskExecutabilityChanged',
]);
export type TaskEventType = z.infer<typeof TaskEventTypeSchema>;

const EventEnvelopeShape = {
  schemaVersion: z.literal(ContractSchemaVersion),
  eventId: UuidSchema,
  workspaceId: UuidSchema,
  workspaceSequence: z.number().int().nonnegative(),
  aggregateType: z.string().trim().min(1).max(80),
  aggregateId: UuidSchema,
  aggregateVersion: z.number().int().positive(),
  actorType: ActorTypeSchema,
  actorId: UuidSchema.nullable(),
  occurredAt: IsoDateTimeSchema,
  commandId: UuidSchema,
  correlationId: UuidSchema.nullable(),
  causationId: UuidSchema.nullable(),
} as const;

const statusPayload = z
  .object({
    previousStatus: TaskStatusSchema,
    currentStatus: TaskStatusSchema,
    previousOwnerId: UuidSchema.nullable(),
    currentOwnerId: UuidSchema.nullable(),
  })
  .strict();

const event = <TType extends string, TPayload extends z.ZodType>(
  eventType: TType,
  payload: TPayload,
) =>
  z
    .object({
      ...EventEnvelopeShape,
      aggregateType: z.literal('Task'),
      eventType: z.literal(eventType),
      payload,
    })
    .strict();

const genericChangesPayload = z.object({ changes: z.record(z.string(), z.unknown()) }).strict();

export const TaskCreatedEventSchema = event(
  'TaskCreated',
  z.object({ title: z.string().min(1) }).strict(),
);
export const TaskDetailsUpdatedEventSchema = event('TaskDetailsUpdated', genericChangesPayload);
export const TaskStartedEventSchema = event('TaskStarted', statusPayload);
export const TaskPausedEventSchema = event('TaskPaused', statusPayload);
export const TaskReleasedEventSchema = event('TaskReleased', statusPayload);
export const TaskReviewRequestedEventSchema = event('TaskReviewRequested', statusPayload);
export const TaskChangesRequestedEventSchema = event('TaskChangesRequested', statusPayload);
export const TaskCompletedEventSchema = event('TaskCompleted', statusPayload);
export const TaskCanceledEventSchema = event('TaskCanceled', statusPayload);
export const TaskReopenedEventSchema = event('TaskReopened', statusPayload);
export const TaskArchivedEventSchema = event(
  'TaskArchived',
  z.object({ archivedAt: IsoDateTimeSchema }).strict(),
);
export const TaskBlockedEventSchema = event(
  'TaskBlocked',
  z.object({ blockType: BlockTypeSchema, reason: z.string().min(1) }).strict(),
);
export const TaskUnblockedEventSchema = event(
  'TaskUnblocked',
  z.object({ previousBlockType: BlockTypeSchema }).strict(),
);
export const TaskOwnerTransferredEventSchema = event(
  'TaskOwnerTransferred',
  z
    .object({
      previousOwnerId: UuidSchema.nullable(),
      currentOwnerId: UuidSchema,
    })
    .strict(),
);
export const TaskOwnerTransferRequestedEventSchema = event(
  'TaskOwnerTransferRequested',
  z
    .object({
      requesterId: UuidSchema,
      currentOwnerId: UuidSchema,
    })
    .strict(),
);
export const TaskCollaboratorAddedEventSchema = event(
  'TaskCollaboratorAdded',
  z.object({ collaboratorId: UuidSchema }).strict(),
);
export const TaskCollaboratorRemovedEventSchema = event(
  'TaskCollaboratorRemoved',
  z.object({ collaboratorId: UuidSchema }).strict(),
);
export const TaskImportanceChangedEventSchema = event(
  'TaskImportanceChanged',
  z
    .object({
      previousImportance: ImportanceSchema,
      currentImportance: ImportanceSchema,
    })
    .strict(),
);
export const TaskActionOverrideSetEventSchema = event(
  'TaskActionOverrideSet',
  z
    .object({
      level: z.enum(['NOW', 'NEXT', 'LATER']),
      reason: z.string().min(1),
      expiresAt: IsoDateTimeSchema,
    })
    .strict(),
);
export const TaskActionOverrideClearedEventSchema = event(
  'TaskActionOverrideCleared',
  z.object({ expired: z.boolean() }).strict(),
);
const dependencyPayload = z
  .object({
    prerequisiteTaskId: UuidSchema,
    dependentTaskId: UuidSchema,
    dependencyType: z.literal('BLOCKS'),
  })
  .strict();
export const DependencyAddedEventSchema = event('DependencyAdded', dependencyPayload);
export const DependencyRemovedEventSchema = event('DependencyRemoved', dependencyPayload);
export const TaskExecutabilityChangedEventSchema = event(
  'TaskExecutabilityChanged',
  z
    .object({
      executable: z.boolean(),
      incompletePrerequisiteTaskIds: z.array(UuidSchema),
    })
    .strict(),
);

export const TaskDomainEventSchema = z.discriminatedUnion('eventType', [
  TaskCreatedEventSchema,
  TaskDetailsUpdatedEventSchema,
  TaskStartedEventSchema,
  TaskPausedEventSchema,
  TaskReleasedEventSchema,
  TaskOwnerTransferRequestedEventSchema,
  TaskReviewRequestedEventSchema,
  TaskChangesRequestedEventSchema,
  TaskCompletedEventSchema,
  TaskCanceledEventSchema,
  TaskReopenedEventSchema,
  TaskArchivedEventSchema,
  TaskBlockedEventSchema,
  TaskUnblockedEventSchema,
  TaskOwnerTransferredEventSchema,
  TaskCollaboratorAddedEventSchema,
  TaskCollaboratorRemovedEventSchema,
  TaskImportanceChangedEventSchema,
  TaskActionOverrideSetEventSchema,
  TaskActionOverrideClearedEventSchema,
  DependencyAddedEventSchema,
  DependencyRemovedEventSchema,
  TaskExecutabilityChangedEventSchema,
]);
export type TaskDomainEvent = z.infer<typeof TaskDomainEventSchema>;

// A forward-compatible envelope for relays that must validate metadata before
// deciding whether they support a particular event type/schema combination.
export const EventEnvelopeSchema = z
  .object({
    ...EventEnvelopeShape,
    eventType: z.string().trim().min(1).max(100),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

export function parseSupportedTaskEvent(input: unknown): TaskDomainEvent {
  return TaskDomainEventSchema.parse(input);
}
