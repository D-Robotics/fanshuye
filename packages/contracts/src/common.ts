import { z } from 'zod';

export const ContractSchemaVersion = 1 as const;

export const UuidSchema = z.string().uuid();
export const IsoDateTimeSchema = z.string().datetime({ offset: true });
export const NonEmptyTextSchema = z.string().trim().min(1);

export const TaskStatusSchema = z.enum(['TODO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE', 'CANCELED']);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const WorkspaceRoleSchema = z.enum(['ADMIN', 'MEMBER']);
export type WorkspaceRole = z.infer<typeof WorkspaceRoleSchema>;

export const ImportanceSchema = z.number().int().min(1).max(5);
export type Importance = z.infer<typeof ImportanceSchema>;

export const LeafSizeSchema = z.enum(['SMALL', 'MEDIUM', 'LARGE']);
export type LeafSize = z.infer<typeof LeafSizeSchema>;

export const ActionLevelSchema = z.enum(['NOW', 'NEXT', 'LATER']);
export type ActionLevel = z.infer<typeof ActionLevelSchema>;

// Alias kept for callers that use the product copy's "tier" terminology.
export const ActionTierSchema = ActionLevelSchema;
export type ActionTier = ActionLevel;

export const ActorTypeSchema = z.enum(['human', 'integration', 'agent', 'system']);
export type ActorType = z.infer<typeof ActorTypeSchema>;

export const DependencyTypeSchema = z.literal('BLOCKS');
export type DependencyType = z.infer<typeof DependencyTypeSchema>;

export const BlockTypeSchema = z.enum(['TECHNICAL', 'EXTERNAL', 'DECISION', 'CAPACITY', 'OTHER']);
export type BlockType = z.infer<typeof BlockTypeSchema>;

export const ManualBlockSchema = z
  .object({
    type: BlockTypeSchema,
    reason: NonEmptyTextSchema.max(1_000),
    blockedAt: IsoDateTimeSchema,
  })
  .strict();
export type ManualBlock = z.infer<typeof ManualBlockSchema>;

export const ManualActionOverrideSchema = z
  .object({
    level: ActionLevelSchema,
    reason: NonEmptyTextSchema.max(500),
    expiresAt: IsoDateTimeSchema,
  })
  .strict();
export type ManualActionOverride = z.infer<typeof ManualActionOverrideSchema>;
