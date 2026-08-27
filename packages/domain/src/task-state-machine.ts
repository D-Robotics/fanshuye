import type { TaskStatus } from '@fanshuye/contracts';

import { DomainError } from './errors.js';

const ALLOWED_TRANSITIONS = {
  TODO: ['IN_PROGRESS', 'CANCELED'],
  IN_PROGRESS: ['TODO', 'IN_REVIEW', 'DONE', 'CANCELED'],
  IN_REVIEW: ['IN_PROGRESS', 'DONE', 'CANCELED'],
  DONE: ['TODO'],
  CANCELED: ['TODO'],
} as const satisfies Record<TaskStatus, readonly TaskStatus[]>;

export function allowedTransitions(from: TaskStatus): readonly TaskStatus[] {
  return ALLOWED_TRANSITIONS[from];
}

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return (ALLOWED_TRANSITIONS[from] as readonly TaskStatus[]).includes(to);
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) {
    throw new DomainError('INVALID_TRANSITION', `Task cannot transition from ${from} to ${to}`, {
      currentStatus: from,
      requestedStatus: to,
    });
  }
}

export function isTerminalStatus(status: TaskStatus): boolean {
  return status === 'DONE' || status === 'CANCELED';
}

export function isActiveStatus(status: TaskStatus): boolean {
  return !isTerminalStatus(status);
}
