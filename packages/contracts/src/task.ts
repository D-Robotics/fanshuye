import { z } from 'zod';

import {
  ImportanceSchema,
  IsoDateTimeSchema,
  ManualActionOverrideSchema,
  ManualBlockSchema,
  NonEmptyTextSchema,
  TaskStatusSchema,
  UuidSchema,
} from './common.js';

export const TaskTitleSchema = NonEmptyTextSchema.max(200);
export const TaskDescriptionSchema = z.string().max(20_000);
export const DefinitionOfDoneSchema = z.string().max(10_000);

export const TaskSnapshotSchema = z
  .object({
    id: UuidSchema,
    workspaceId: UuidSchema,
    taskTreeId: UuidSchema,
    workstreamId: UuidSchema,
    title: TaskTitleSchema,
    description: TaskDescriptionSchema,
    definitionOfDone: DefinitionOfDoneSchema,
    status: TaskStatusSchema,
    ownerId: UuidSchema.nullable(),
    collaboratorIds: z.array(UuidSchema),
    importance: ImportanceSchema,
    deadlineAt: IsoDateTimeSchema.nullable(),
    manualBlock: ManualBlockSchema.nullable(),
    manualActionOverride: ManualActionOverrideSchema.nullable(),
    manualOrder: z.number().finite().nullable(),
    version: z.number().int().positive(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    archivedAt: IsoDateTimeSchema.nullable(),
  })
  .strict()
  .superRefine((task, context) => {
    const uniqueCollaborators = new Set(task.collaboratorIds);
    if (uniqueCollaborators.size !== task.collaboratorIds.length) {
      context.addIssue({
        code: 'custom',
        path: ['collaboratorIds'],
        message: 'Collaborators must be unique',
      });
    }

    if (task.ownerId !== null && uniqueCollaborators.has(task.ownerId)) {
      context.addIssue({
        code: 'custom',
        path: ['collaboratorIds'],
        message: 'The primary owner cannot also be a collaborator',
      });
    }
  });
export type TaskSnapshot = z.infer<typeof TaskSnapshotSchema>;

export const TaskSummarySchema = z
  .object({
    id: UuidSchema,
    workspaceId: UuidSchema,
    title: TaskTitleSchema,
    status: TaskStatusSchema,
    ownerId: UuidSchema.nullable(),
    importance: ImportanceSchema,
    deadlineAt: IsoDateTimeSchema.nullable(),
    version: z.number().int().positive(),
    archivedAt: IsoDateTimeSchema.nullable(),
  })
  .strict();
export type TaskSummary = z.infer<typeof TaskSummarySchema>;

export const DependencyEdgeSchema = z
  .object({
    workspaceId: UuidSchema,
    prerequisiteTaskId: UuidSchema,
    dependentTaskId: UuidSchema,
    type: z.literal('BLOCKS'),
  })
  .strict()
  .refine((edge) => edge.prerequisiteTaskId !== edge.dependentTaskId, {
    message: 'A task cannot block itself',
    path: ['dependentTaskId'],
  });
export type DependencyEdge = z.infer<typeof DependencyEdgeSchema>;

export const ExternalReferenceTypeSchema = z.enum([
  'REPOSITORY',
  'ISSUE',
  'BRANCH',
  'PULL_REQUEST',
  'DOCUMENT',
  'OTHER',
]);
export type ExternalReferenceType = z.infer<typeof ExternalReferenceTypeSchema>;

export const ExternalReferenceSchema = z
  .object({
    id: UuidSchema,
    taskId: UuidSchema,
    type: ExternalReferenceTypeSchema,
    displayName: NonEmptyTextSchema.max(200),
    url: z
      .string()
      .url()
      .refine((value) => {
        const protocol = new URL(value).protocol;
        return protocol === 'https:' || protocol === 'http:';
      }, 'Only HTTP(S) links are allowed'),
  })
  .strict();
export type ExternalReference = z.infer<typeof ExternalReferenceSchema>;
