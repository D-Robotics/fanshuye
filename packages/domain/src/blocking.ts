import type { ManualBlock, TaskStatus } from '@fanshuye/contracts';

import { DomainError } from './errors.js';

export interface EffectiveBlockState {
  readonly blocked: boolean;
  readonly manuallyBlocked: boolean;
  readonly dependencyBlocked: boolean;
  readonly manualBlock: ManualBlock | null;
  readonly incompletePrerequisiteTaskIds: readonly string[];
}

export function deriveEffectiveBlockState(
  manualBlock: ManualBlock | null,
  incompletePrerequisiteTaskIds: readonly string[],
): EffectiveBlockState {
  const prerequisiteIds = [...new Set(incompletePrerequisiteTaskIds)].sort();
  const manuallyBlocked = manualBlock !== null;
  const dependencyBlocked = prerequisiteIds.length > 0;

  return {
    blocked: manuallyBlocked || dependencyBlocked,
    manuallyBlocked,
    dependencyBlocked,
    manualBlock,
    incompletePrerequisiteTaskIds: prerequisiteIds,
  };
}

export function assertTaskCanStart(
  status: TaskStatus,
  manualBlock: ManualBlock | null,
  incompletePrerequisiteTaskIds: readonly string[],
): void {
  if (status !== 'TODO') {
    throw new DomainError(
      'INVALID_TRANSITION',
      `Only a TODO task can be started; current status is ${status}`,
      { currentStatus: status, requestedStatus: 'IN_PROGRESS' },
    );
  }

  if (manualBlock !== null) {
    throw new DomainError('TASK_BLOCKED', 'The task is manually blocked', {
      blockType: manualBlock.type,
      reason: manualBlock.reason,
    });
  }

  const prerequisiteIds = [...new Set(incompletePrerequisiteTaskIds)].sort();
  if (prerequisiteIds.length > 0) {
    throw new DomainError('TASK_BLOCKED_BY_DEPENDENCY', 'The task has incomplete prerequisites', {
      incompletePrerequisiteTaskIds: prerequisiteIds,
    });
  }
}
