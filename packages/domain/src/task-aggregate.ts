import {
  TaskSnapshotSchema,
  type ActionLevel,
  type BlockType,
  type Importance,
  type ManualActionOverride,
  type TaskEventType,
  type TaskSnapshot,
} from '@fanshuye/contracts';

import { assertTaskCanStart } from './blocking.js';
import { DomainError } from './errors.js';
import { assertTransition, isActiveStatus, isTerminalStatus } from './task-state-machine.js';

export interface CreateTaskInput {
  readonly id: string;
  readonly workspaceId: string;
  readonly taskTreeId: string;
  readonly workstreamId: string;
  readonly title: string;
  readonly description?: string;
  readonly definitionOfDone?: string;
  readonly ownerId?: string | null;
  readonly collaboratorIds?: readonly string[];
  readonly importance?: Importance;
  readonly deadlineAt?: string | null;
  readonly manualOrder?: number | null;
  readonly occurredAt?: Date;
}

export interface UpdateTaskDetailsInput {
  readonly title?: string;
  readonly description?: string;
  readonly definitionOfDone?: string;
  readonly deadlineAt?: string | null;
  readonly manualOrder?: number | null;
}

export interface UncommittedTaskEvent {
  readonly eventType: TaskEventType;
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly payload: Readonly<Record<string, unknown>>;
}

export class TaskAggregate {
  readonly #state: TaskSnapshot;
  readonly #uncommittedEvents: readonly UncommittedTaskEvent[];

  private constructor(state: TaskSnapshot, uncommittedEvents: readonly UncommittedTaskEvent[]) {
    this.#state = copySnapshot(state);
    this.#uncommittedEvents = [...uncommittedEvents];
  }

  static create(input: CreateTaskInput): TaskAggregate {
    const occurredAt = input.occurredAt ?? new Date();
    assertValidDate(occurredAt, 'occurredAt');
    const timestamp = occurredAt.toISOString();
    const ownerId = input.ownerId ?? null;
    const collaborators = [...new Set(input.collaboratorIds ?? [])].filter(
      (collaboratorId) => collaboratorId !== ownerId,
    );

    const state = TaskSnapshotSchema.parse({
      id: input.id,
      workspaceId: input.workspaceId,
      taskTreeId: input.taskTreeId,
      workstreamId: input.workstreamId,
      title: input.title,
      description: input.description ?? '',
      definitionOfDone: input.definitionOfDone ?? '',
      status: 'TODO',
      ownerId,
      collaboratorIds: collaborators,
      importance: input.importance ?? 3,
      deadlineAt: input.deadlineAt ?? null,
      manualBlock: null,
      manualActionOverride: null,
      manualOrder: input.manualOrder ?? null,
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      archivedAt: null,
    });

    return new TaskAggregate(state, [
      {
        eventType: 'TaskCreated',
        aggregateId: state.id,
        aggregateVersion: state.version,
        payload: { title: state.title },
      },
    ]);
  }

  static rehydrate(snapshot: TaskSnapshot): TaskAggregate {
    return new TaskAggregate(TaskSnapshotSchema.parse(snapshot), []);
  }

  get snapshot(): TaskSnapshot {
    return copySnapshot(this.#state);
  }

  get uncommittedEvents(): readonly UncommittedTaskEvent[] {
    return this.#uncommittedEvents.map((event) => ({
      ...event,
      payload: { ...event.payload },
    }));
  }

  get isActive(): boolean {
    return isActiveStatus(this.#state.status) && this.#state.archivedAt === null;
  }

  markCommitted(): TaskAggregate {
    return new TaskAggregate(this.#state, []);
  }

  assertExpectedVersion(expectedVersion: number): void {
    if (expectedVersion !== this.#state.version) {
      throw new DomainError('VERSION_CONFLICT', 'The task was changed by another command', {
        expectedVersion,
        actualVersion: this.#state.version,
        currentTask: this.snapshot,
      });
    }
  }

  updateDetails(input: UpdateTaskDetailsInput, occurredAt: Date = new Date()): TaskAggregate {
    this.#assertNonTerminal();
    if (Object.keys(input).length === 0) {
      throw new DomainError('VALIDATION_ERROR', 'At least one task detail must be supplied');
    }

    const next = {
      ...this.#state,
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.definitionOfDone === undefined ? {} : { definitionOfDone: input.definitionOfDone }),
      ...(input.deadlineAt === undefined ? {} : { deadlineAt: input.deadlineAt }),
      ...(input.manualOrder === undefined ? {} : { manualOrder: input.manualOrder }),
    };

    return this.#mutate(next, 'TaskDetailsUpdated', { changes: { ...input } }, occurredAt);
  }

  start(
    actorId: string,
    incompletePrerequisiteTaskIds: readonly string[],
    occurredAt: Date = new Date(),
  ): TaskAggregate {
    assertTaskCanStart(this.#state.status, this.#state.manualBlock, incompletePrerequisiteTaskIds);

    if (this.#state.ownerId !== null && this.#state.ownerId !== actorId) {
      throw new DomainError('TASK_ALREADY_CLAIMED', 'The task already has a primary owner', {
        currentOwnerId: this.#state.ownerId,
        currentStatus: this.#state.status,
        currentVersion: this.#state.version,
      });
    }

    const previousOwnerId = this.#state.ownerId;
    const nextOwnerId = previousOwnerId ?? actorId;
    const collaborators = this.#state.collaboratorIds.filter(
      (collaboratorId) => collaboratorId !== nextOwnerId,
    );
    return this.#mutate(
      {
        ...this.#state,
        status: 'IN_PROGRESS',
        ownerId: nextOwnerId,
        collaboratorIds: collaborators,
      },
      'TaskStarted',
      statusPayload(this.#state.status, 'IN_PROGRESS', previousOwnerId, nextOwnerId),
      occurredAt,
    );
  }

  pause(occurredAt: Date = new Date()): TaskAggregate {
    assertTransition(this.#state.status, 'TODO');
    if (this.#state.status !== 'IN_PROGRESS') {
      throw new DomainError('INVALID_TRANSITION', 'Only an in-progress task can be paused', {
        currentStatus: this.#state.status,
      });
    }
    return this.#mutate(
      { ...this.#state, status: 'TODO' },
      'TaskPaused',
      statusPayload('IN_PROGRESS', 'TODO', this.#state.ownerId, this.#state.ownerId),
      occurredAt,
    );
  }

  release(occurredAt: Date = new Date()): TaskAggregate {
    if (this.#state.status !== 'IN_PROGRESS') {
      throw new DomainError('INVALID_TRANSITION', 'Only an in-progress task can be released', {
        currentStatus: this.#state.status,
      });
    }
    assertTransition(this.#state.status, 'TODO');
    const previousOwnerId = this.#state.ownerId;
    return this.#mutate(
      { ...this.#state, status: 'TODO', ownerId: null },
      'TaskReleased',
      statusPayload('IN_PROGRESS', 'TODO', previousOwnerId, null),
      occurredAt,
    );
  }

  transferOwner(targetOwnerId: string, occurredAt: Date = new Date()): TaskAggregate {
    this.#assertNonTerminal();
    if (targetOwnerId.trim().length === 0) {
      throw new DomainError('VALIDATION_ERROR', 'A target owner is required');
    }
    if (targetOwnerId === this.#state.ownerId) return this;

    const previousOwnerId = this.#state.ownerId;
    return this.#mutate(
      {
        ...this.#state,
        ownerId: targetOwnerId,
        collaboratorIds: this.#state.collaboratorIds.filter(
          (collaboratorId) => collaboratorId !== targetOwnerId,
        ),
      },
      'TaskOwnerTransferred',
      { previousOwnerId, currentOwnerId: targetOwnerId },
      occurredAt,
    );
  }

  addCollaborator(collaboratorId: string, occurredAt: Date = new Date()): TaskAggregate {
    this.#assertNonTerminal();
    if (collaboratorId === this.#state.ownerId) {
      throw new DomainError(
        'OWNER_CANNOT_COLLABORATE',
        'The primary owner cannot also be a collaborator',
        { ownerId: this.#state.ownerId },
      );
    }
    if (this.#state.collaboratorIds.includes(collaboratorId)) return this;

    return this.#mutate(
      {
        ...this.#state,
        collaboratorIds: [...this.#state.collaboratorIds, collaboratorId].sort(),
      },
      'TaskCollaboratorAdded',
      { collaboratorId },
      occurredAt,
    );
  }

  removeCollaborator(collaboratorId: string, occurredAt: Date = new Date()): TaskAggregate {
    this.#assertNonTerminal();
    if (!this.#state.collaboratorIds.includes(collaboratorId)) return this;

    return this.#mutate(
      {
        ...this.#state,
        collaboratorIds: this.#state.collaboratorIds.filter(
          (currentId) => currentId !== collaboratorId,
        ),
      },
      'TaskCollaboratorRemoved',
      { collaboratorId },
      occurredAt,
    );
  }

  block(blockType: BlockType, reason: string, occurredAt: Date = new Date()): TaskAggregate {
    this.#assertNonTerminal();
    const normalizedReason = reason.trim();
    if (normalizedReason.length === 0) {
      throw new DomainError('INVALID_BLOCK', 'A visible blocking reason is required');
    }

    const blockedAt = toIsoDate(occurredAt, 'occurredAt');
    return this.#mutate(
      {
        ...this.#state,
        manualBlock: {
          type: blockType,
          reason: normalizedReason,
          blockedAt,
        },
      },
      'TaskBlocked',
      { blockType, reason: normalizedReason },
      occurredAt,
    );
  }

  unblock(occurredAt: Date = new Date()): TaskAggregate {
    this.#assertNonTerminal();
    if (this.#state.manualBlock === null) return this;
    const previousBlockType = this.#state.manualBlock.type;
    return this.#mutate(
      { ...this.#state, manualBlock: null },
      'TaskUnblocked',
      { previousBlockType },
      occurredAt,
    );
  }

  requestReview(occurredAt: Date = new Date()): TaskAggregate {
    return this.#transition('IN_REVIEW', 'TaskReviewRequested', occurredAt);
  }

  requestChanges(occurredAt: Date = new Date()): TaskAggregate {
    return this.#transition('IN_PROGRESS', 'TaskChangesRequested', occurredAt);
  }

  complete(occurredAt: Date = new Date()): TaskAggregate {
    if (this.#state.status !== 'IN_PROGRESS' && this.#state.status !== 'IN_REVIEW') {
      throw new DomainError(
        'INVALID_TRANSITION',
        'Only an in-progress or in-review task can be completed',
        { currentStatus: this.#state.status },
      );
    }
    assertTransition(this.#state.status, 'DONE');
    return this.#transitionToTerminal('DONE', 'TaskCompleted', occurredAt);
  }

  cancel(occurredAt: Date = new Date()): TaskAggregate {
    this.#assertNonTerminal();
    assertTransition(this.#state.status, 'CANCELED');
    return this.#transitionToTerminal('CANCELED', 'TaskCanceled', occurredAt);
  }

  reopen(occurredAt: Date = new Date()): TaskAggregate {
    if (!isTerminalStatus(this.#state.status)) {
      throw new DomainError(
        'INVALID_TRANSITION',
        'Only a completed or canceled task can be reopened',
        { currentStatus: this.#state.status },
      );
    }
    assertTransition(this.#state.status, 'TODO');
    const previousStatus = this.#state.status;
    return this.#mutate(
      {
        ...this.#state,
        status: 'TODO',
        archivedAt: null,
        manualBlock: null,
      },
      'TaskReopened',
      statusPayload(previousStatus, 'TODO', this.#state.ownerId, this.#state.ownerId),
      occurredAt,
    );
  }

  setImportance(importance: Importance, occurredAt: Date = new Date()): TaskAggregate {
    this.#assertNonTerminal();
    if (!Number.isInteger(importance) || importance < 1 || importance > 5) {
      throw new DomainError('INVALID_IMPORTANCE', 'Importance must be an integer from 1 to 5', {
        importance,
      });
    }
    if (importance === this.#state.importance) return this;
    const previousImportance = this.#state.importance;
    return this.#mutate(
      { ...this.#state, importance },
      'TaskImportanceChanged',
      { previousImportance, currentImportance: importance },
      occurredAt,
    );
  }

  setActionOverride(
    level: ActionLevel,
    reason: string,
    expiresAt: string,
    occurredAt: Date = new Date(),
  ): TaskAggregate {
    this.#assertNonTerminal();
    const normalizedReason = reason.trim();
    if (normalizedReason.length === 0) {
      throw new DomainError(
        'INVALID_ACTION_OVERRIDE',
        'An action override requires a visible reason',
      );
    }
    const expiry = new Date(expiresAt);
    assertValidDate(expiry, 'expiresAt');
    if (expiry.getTime() <= occurredAt.getTime()) {
      throw new DomainError(
        'INVALID_ACTION_OVERRIDE',
        'An action override must expire in the future',
        { expiresAt },
      );
    }
    const override: ManualActionOverride = {
      level,
      reason: normalizedReason,
      expiresAt: expiry.toISOString(),
    };
    return this.#mutate(
      { ...this.#state, manualActionOverride: override },
      'TaskActionOverrideSet',
      { ...override },
      occurredAt,
    );
  }

  clearActionOverride(occurredAt: Date = new Date(), expired = false): TaskAggregate {
    this.#assertNonTerminal();
    if (this.#state.manualActionOverride === null) return this;
    return this.#mutate(
      { ...this.#state, manualActionOverride: null },
      'TaskActionOverrideCleared',
      { expired },
      occurredAt,
    );
  }

  expireActionOverride(now: Date = new Date()): TaskAggregate {
    const override = this.#state.manualActionOverride;
    if (override === null || new Date(override.expiresAt).getTime() > now.getTime()) {
      return this;
    }
    return this.clearActionOverride(now, true);
  }

  #transition(
    targetStatus: TaskSnapshot['status'],
    eventType: TaskEventType,
    occurredAt: Date,
  ): TaskAggregate {
    assertTransition(this.#state.status, targetStatus);
    return this.#mutate(
      { ...this.#state, status: targetStatus },
      eventType,
      statusPayload(this.#state.status, targetStatus, this.#state.ownerId, this.#state.ownerId),
      occurredAt,
    );
  }

  #transitionToTerminal(
    targetStatus: 'DONE' | 'CANCELED',
    eventType: 'TaskCompleted' | 'TaskCanceled',
    occurredAt: Date,
  ): TaskAggregate {
    const timestamp = toIsoDate(occurredAt, 'occurredAt');
    return this.#mutate(
      {
        ...this.#state,
        status: targetStatus,
        manualBlock: null,
        manualActionOverride: null,
        archivedAt: timestamp,
      },
      eventType,
      statusPayload(this.#state.status, targetStatus, this.#state.ownerId, this.#state.ownerId),
      occurredAt,
    );
  }

  #mutate(
    candidate: TaskSnapshot,
    eventType: TaskEventType,
    payload: Readonly<Record<string, unknown>>,
    occurredAt: Date,
  ): TaskAggregate {
    const timestamp = toIsoDate(occurredAt, 'occurredAt');
    const next = TaskSnapshotSchema.parse({
      ...candidate,
      version: this.#state.version + 1,
      updatedAt: timestamp,
    });
    const event: UncommittedTaskEvent = {
      eventType,
      aggregateId: next.id,
      aggregateVersion: next.version,
      payload: { ...payload },
    };
    return new TaskAggregate(next, [...this.#uncommittedEvents, event]);
  }

  #assertNonTerminal(): void {
    if (isTerminalStatus(this.#state.status)) {
      throw new DomainError(
        'TASK_TERMINAL',
        'A terminal task must be reopened before it can be changed',
        { currentStatus: this.#state.status },
      );
    }
  }
}

function copySnapshot(snapshot: TaskSnapshot): TaskSnapshot {
  return {
    ...snapshot,
    collaboratorIds: [...snapshot.collaboratorIds],
    manualBlock: snapshot.manualBlock === null ? null : { ...snapshot.manualBlock },
    manualActionOverride:
      snapshot.manualActionOverride === null ? null : { ...snapshot.manualActionOverride },
  };
}

function statusPayload(
  previousStatus: TaskSnapshot['status'],
  currentStatus: TaskSnapshot['status'],
  previousOwnerId: string | null,
  currentOwnerId: string | null,
): Readonly<Record<string, unknown>> {
  return {
    previousStatus,
    currentStatus,
    previousOwnerId,
    currentOwnerId,
  };
}

function toIsoDate(date: Date, fieldName: string): string {
  assertValidDate(date, fieldName);
  return date.toISOString();
}

function assertValidDate(date: Date, fieldName: string): void {
  if (!Number.isFinite(date.getTime())) {
    throw new DomainError('VALIDATION_ERROR', `${fieldName} must be a valid date`);
  }
}
