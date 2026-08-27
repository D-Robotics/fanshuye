import { z } from 'zod';

import { ContractSchemaVersion, UuidSchema } from './common.js';
import { TaskSnapshotSchema } from './task.js';

export const ApiErrorCodeSchema = z.enum([
  'VALIDATION_ERROR',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'VERSION_CONFLICT',
  'INVALID_TRANSITION',
  'TASK_ALREADY_CLAIMED',
  'TASK_BLOCKED',
  'TASK_BLOCKED_BY_DEPENDENCY',
  'TASK_TERMINAL',
  'OWNER_REQUIRED',
  'OWNER_CANNOT_COLLABORATE',
  'INVALID_BLOCK',
  'INVALID_IMPORTANCE',
  'INVALID_ACTION_OVERRIDE',
  'SELF_DEPENDENCY',
  'DUPLICATE_DEPENDENCY',
  'CROSS_WORKSPACE_DEPENDENCY',
  'DEPENDENCY_CYCLE',
  'DANGLING_TASK',
  'DEPENDENCY_LIMIT_EXCEEDED',
  'COMMAND_ID_REUSED',
  'CURSOR_EXPIRED',
  'UNSUPPORTED_EVENT_VERSION',
  'INTERNAL_ERROR',
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

export const ApiErrorDetailsSchema = z.record(z.string(), z.unknown());

export const ApiErrorSchema = z
  .object({
    schemaVersion: z.literal(ContractSchemaVersion),
    error: z
      .object({
        code: ApiErrorCodeSchema,
        message: z.string().min(1),
        correlationId: UuidSchema.nullable(),
        details: ApiErrorDetailsSchema,
      })
      .strict(),
  })
  .strict();
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const VersionConflictDetailsSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    actualVersion: z.number().int().positive(),
    currentTask: TaskSnapshotSchema,
  })
  .strict();
export type VersionConflictDetails = z.infer<typeof VersionConflictDetailsSchema>;
