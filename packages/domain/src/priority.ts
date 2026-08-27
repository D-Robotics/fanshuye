import type { ActionLevel, Importance, LeafSize, ManualActionOverride } from '@fanshuye/contracts';

import { DomainError } from './errors.js';

const MILLISECONDS_PER_HOUR = 60 * 60 * 1_000;
const MILLISECONDS_PER_DAY = 24 * MILLISECONDS_PER_HOUR;

const ACTION_LEVEL_SCORE = {
  LATER: 0,
  NEXT: 1,
  NOW: 2,
} as const satisfies Record<ActionLevel, number>;

export type ActionReasonCode =
  | 'DEFAULT'
  | 'DEADLINE_OVERDUE'
  | 'DEADLINE_WITHIN_24_HOURS'
  | 'DEADLINE_WITHIN_7_CALENDAR_DAYS'
  | 'HIGH_IMPORTANCE'
  | 'UNLOCKS_DOWNSTREAM'
  | 'MANUAL_OVERRIDE';

export interface ActionReason {
  readonly code: ActionReasonCode;
  readonly level: ActionLevel;
  readonly detail: string;
}

export interface DeriveActionLevelInput {
  readonly importance: Importance;
  readonly deadlineAt: string | null;
  readonly executable: boolean;
  readonly timeZone: string;
  readonly now?: Date;
  readonly manualOverride?: ManualActionOverride | null;
  readonly highestBlockedDependentLevel?: ActionLevel | null;
  readonly manuallyBlocked?: boolean;
  readonly incompletePrerequisiteTaskIds?: readonly string[];
}

export interface DerivedActionLevel {
  readonly level: ActionLevel;
  readonly reasons: readonly ActionReason[];
  readonly primaryReason: ActionReason;
  readonly overdue: boolean;
  readonly blocked: boolean;
  readonly manualOverrideActive: boolean;
}

export interface PrioritizedTask {
  readonly id: string;
  readonly actionLevel: ActionLevel;
  readonly manualOrder: number | null;
  readonly deadlineAt: string | null;
  readonly importance: Importance;
}

export function mapImportanceToLeafSize(importance: Importance): LeafSize {
  if (!Number.isInteger(importance) || importance < 1 || importance > 5) {
    throw new DomainError('INVALID_IMPORTANCE', 'Importance must be an integer from 1 to 5', {
      importance,
    });
  }

  if (importance <= 2) return 'SMALL';
  if (importance === 3) return 'MEDIUM';
  return 'LARGE';
}

export function deriveActionLevel(input: DeriveActionLevelInput): DerivedActionLevel {
  // Validate even though most callers arrive through a runtime contract.
  mapImportanceToLeafSize(input.importance);
  assertTimeZone(input.timeZone);

  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) {
    throw new DomainError('VALIDATION_ERROR', 'now must be a valid date');
  }

  let level: ActionLevel = 'LATER';
  let primaryReason: ActionReason = {
    code: 'DEFAULT',
    level: 'LATER',
    detail: 'No higher action rule applies',
  };
  const reasons: ActionReason[] = [];
  let overdue = false;

  if (input.deadlineAt !== null) {
    const deadline = parseDate(input.deadlineAt, 'deadlineAt');
    const differenceMs = deadline.getTime() - nowMs;
    overdue = differenceMs <= 0;

    if (overdue) {
      const reason: ActionReason = {
        code: 'DEADLINE_OVERDUE',
        level: 'NOW',
        detail: 'The deadline has passed',
      };
      reasons.push(reason);
      if (input.executable) {
        level = 'NOW';
        primaryReason = reason;
      }
    } else if (differenceMs <= MILLISECONDS_PER_DAY) {
      const reason: ActionReason = {
        code: 'DEADLINE_WITHIN_24_HOURS',
        level: 'NOW',
        detail: 'The deadline is within 24 hours',
      };
      reasons.push(reason);
      if (input.executable) {
        level = 'NOW';
        primaryReason = reason;
      }
    } else if (calendarDayDifference(now, deadline, input.timeZone) <= 7) {
      const reason: ActionReason = {
        code: 'DEADLINE_WITHIN_7_CALENDAR_DAYS',
        level: 'NEXT',
        detail: 'The deadline is within 7 calendar days',
      };
      reasons.push(reason);
      if (input.executable) {
        level = 'NEXT';
        primaryReason = reason;
      }
    }
  }

  if (input.importance >= 4) {
    const reason: ActionReason = {
      code: 'HIGH_IMPORTANCE',
      level: 'NEXT',
      detail: `Importance ${input.importance} protects time in NEXT`,
    };
    reasons.push(reason);
    if (ACTION_LEVEL_SCORE[level] < ACTION_LEVEL_SCORE.NEXT) {
      level = 'NEXT';
      primaryReason = reason;
    }
  }

  const downstreamLevel = input.highestBlockedDependentLevel ?? null;
  if (downstreamLevel !== null && ACTION_LEVEL_SCORE[downstreamLevel] > ACTION_LEVEL_SCORE[level]) {
    const promotedScore = Math.min(
      ACTION_LEVEL_SCORE[level] + 1,
      ACTION_LEVEL_SCORE[downstreamLevel],
    );
    const promotedLevel = actionLevelFromScore(promotedScore);
    const reason: ActionReason = {
      code: 'UNLOCKS_DOWNSTREAM',
      level: promotedLevel,
      detail: `Completing this task unlocks a ${downstreamLevel} task`,
    };
    reasons.push(reason);
    level = promotedLevel;
    primaryReason = reason;
  }

  let manualOverrideActive = false;
  const manualOverride = input.manualOverride ?? null;
  if (manualOverride !== null) {
    const expiresAt = parseDate(manualOverride.expiresAt, 'override expiresAt');
    if (expiresAt.getTime() > nowMs) {
      manualOverrideActive = true;
      const reason: ActionReason = {
        code: 'MANUAL_OVERRIDE',
        level: manualOverride.level,
        detail: manualOverride.reason,
      };
      reasons.push(reason);

      // A pin can promote but cannot demote an objective deadline/dependency
      // risk. This is how an override remains incapable of hiding urgency.
      if (ACTION_LEVEL_SCORE[manualOverride.level] >= ACTION_LEVEL_SCORE[level]) {
        level = manualOverride.level;
        primaryReason = reason;
      }
    }
  }

  if (reasons.length === 0) reasons.push(primaryReason);

  const dependencyBlocked = (input.incompletePrerequisiteTaskIds?.length ?? 0) > 0;

  return {
    level,
    reasons,
    primaryReason,
    overdue,
    blocked: (input.manuallyBlocked ?? false) || dependencyBlocked,
    manualOverrideActive,
  };
}

// Terminology alias used by early prototypes and some server modules.
export const deriveActionTier = deriveActionLevel;

export function comparePrioritizedTasks(left: PrioritizedTask, right: PrioritizedTask): number {
  const levelDifference =
    ACTION_LEVEL_SCORE[right.actionLevel] - ACTION_LEVEL_SCORE[left.actionLevel];
  if (levelDifference !== 0) return levelDifference;

  const manualOrderDifference = compareNullableNumbers(left.manualOrder, right.manualOrder);
  if (manualOrderDifference !== 0) return manualOrderDifference;

  const deadlineDifference = compareNullableDates(left.deadlineAt, right.deadlineAt);
  if (deadlineDifference !== 0) return deadlineDifference;

  const importanceDifference = right.importance - left.importance;
  if (importanceDifference !== 0) return importanceDifference;

  return compareCodePoints(left.id, right.id);
}

export function sortTasksForTree<TTask extends PrioritizedTask>(tasks: readonly TTask[]): TTask[] {
  return [...tasks].sort(comparePrioritizedTasks);
}

export function isActionOverrideActive(
  override: ManualActionOverride | null,
  now: Date = new Date(),
): boolean {
  if (override === null) return false;
  return parseDate(override.expiresAt, 'override expiresAt').getTime() > now.getTime();
}

function actionLevelFromScore(score: number): ActionLevel {
  if (score >= ACTION_LEVEL_SCORE.NOW) return 'NOW';
  if (score >= ACTION_LEVEL_SCORE.NEXT) return 'NEXT';
  return 'LATER';
}

function parseDate(value: string, fieldName: string): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new DomainError('VALIDATION_ERROR', `${fieldName} must be a valid ISO date-time`, {
      value,
    });
  }
  return date;
}

function assertTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone }).format();
  } catch {
    throw new DomainError('VALIDATION_ERROR', 'timeZone must be a valid IANA time zone', {
      timeZone,
    });
  }
}

function calendarDayDifference(from: Date, to: Date, timeZone: string): number {
  return localDateOrdinal(to, timeZone) - localDateOrdinal(from, timeZone);
}

function localDateOrdinal(date: Date, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(date);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  const year = Number(values.get('year'));
  const month = Number(values.get('month'));
  const day = Number(values.get('day'));
  return Math.floor(Date.UTC(year, month - 1, day) / MILLISECONDS_PER_DAY);
}

function compareNullableNumbers(left: number | null, right: number | null): number {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left - right;
}

function compareNullableDates(left: string | null, right: string | null): number {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return parseDate(left, 'deadlineAt').getTime() - parseDate(right, 'deadlineAt').getTime();
}

function compareCodePoints(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
