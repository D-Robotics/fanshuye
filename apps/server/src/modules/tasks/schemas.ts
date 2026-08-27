import {
  ActionLevelSchema,
  CreateTaskRequestSchema,
  ExternalReferenceRequestSchema,
  ListTasksWireQuerySchema,
  TaskMutationRequestSchema,
  TaskStatusSchema,
  UuidSchema,
} from '@fanshuye/contracts';
import type { z } from 'zod';

export { ActionLevelSchema, TaskStatusSchema, UuidSchema };

// Keep the server module API stable while the shared runtime package remains
// the single wire-contract source for both the desktop and the server.
export const CreateTaskSchema = CreateTaskRequestSchema;
export const TaskCommandSchema = TaskMutationRequestSchema;
export const ExternalReferenceSchema = ExternalReferenceRequestSchema;
export const ListTasksQuerySchema = ListTasksWireQuerySchema;

export type CreateTaskInput = z.infer<typeof CreateTaskSchema>;
export type TaskCommand = z.infer<typeof TaskCommandSchema>;
