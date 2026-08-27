import { describe, expect, it } from 'vitest';

import { deriveActionLevel, mapImportanceToLeafSize, sortTasksForTree } from '../src/index.js';

const NOW = new Date('2026-08-26T00:00:00.000Z');

function derive(overrides: Partial<Parameters<typeof deriveActionLevel>[0]> = {}) {
  return deriveActionLevel({
    importance: 3,
    deadlineAt: null,
    executable: true,
    timeZone: 'Asia/Shanghai',
    now: NOW,
    ...overrides,
  });
}

describe('importance leaf mapping', () => {
  it.each([
    [1, 'SMALL'],
    [2, 'SMALL'],
    [3, 'MEDIUM'],
    [4, 'LARGE'],
    [5, 'LARGE'],
  ] as const)('maps importance %i to %s', (importance, expected) => {
    expect(mapImportanceToLeafSize(importance)).toBe(expected);
  });

  it('never rewrites the importance value to represent urgency', () => {
    const importance = 1 as const;
    const result = derive({
      importance,
      deadlineAt: '2026-08-26T06:00:00.000Z',
    });

    expect(result.level).toBe('NOW');
    expect(importance).toBe(1);
    expect(mapImportanceToLeafSize(importance)).toBe('SMALL');
  });
});

describe('explainable action levels', () => {
  it('places overdue and <=24 hour executable tasks in NOW', () => {
    expect(derive({ deadlineAt: '2026-08-25T23:59:00.000Z' })).toMatchObject({
      level: 'NOW',
      overdue: true,
      primaryReason: { code: 'DEADLINE_OVERDUE' },
    });
    expect(derive({ deadlineAt: '2026-08-27T00:00:00.000Z' })).toMatchObject({
      level: 'NOW',
      overdue: false,
      primaryReason: { code: 'DEADLINE_WITHIN_24_HOURS' },
    });
  });

  it("uses calendar days in the team's IANA time zone for NEXT", () => {
    expect(derive({ deadlineAt: '2026-09-01T15:59:00.000Z' })).toMatchObject({
      level: 'NEXT',
      primaryReason: { code: 'DEADLINE_WITHIN_7_CALENDAR_DAYS' },
    });
    expect(derive({ deadlineAt: '2026-09-02T16:00:00.000Z' })).toMatchObject({ level: 'LATER' });
  });

  it('promotes high importance only as far as NEXT', () => {
    expect(derive({ importance: 5 })).toMatchObject({
      level: 'NEXT',
      primaryReason: { code: 'HIGH_IMPORTANCE' },
    });
  });

  it('promotes a prerequisite by at most one level', () => {
    expect(derive({ highestBlockedDependentLevel: 'NOW' })).toMatchObject({
      level: 'NEXT',
      primaryReason: { code: 'UNLOCKS_DOWNSTREAM' },
    });
    expect(
      derive({
        importance: 5,
        highestBlockedDependentLevel: 'NOW',
      }),
    ).toMatchObject({
      level: 'NOW',
      primaryReason: { code: 'UNLOCKS_DOWNSTREAM' },
    });
  });

  it('applies a valid manual pin and ignores it after expiry', () => {
    const manualOverride = {
      level: 'NOW',
      reason: 'Production incident',
      expiresAt: '2026-08-26T12:00:00.000Z',
    } as const;

    expect(derive({ manualOverride })).toMatchObject({
      level: 'NOW',
      manualOverrideActive: true,
      primaryReason: {
        code: 'MANUAL_OVERRIDE',
        detail: 'Production incident',
      },
    });
    expect(
      derive({
        manualOverride,
        now: new Date('2026-08-26T12:00:00.000Z'),
      }),
    ).toMatchObject({ level: 'LATER', manualOverrideActive: false });
  });

  it('never lets an override hide deadline or blocked risk', () => {
    const result = derive({
      deadlineAt: '2026-08-25T23:00:00.000Z',
      executable: false,
      manuallyBlocked: true,
      incompletePrerequisiteTaskIds: ['task-a'],
      manualOverride: {
        level: 'LATER',
        reason: 'Do later',
        expiresAt: '2026-08-27T00:00:00.000Z',
      },
    });

    expect(result).toMatchObject({
      overdue: true,
      blocked: true,
      manualOverrideActive: true,
    });
    expect(result.reasons.map((reason) => reason.code)).toEqual(
      expect.arrayContaining(['DEADLINE_OVERDUE', 'MANUAL_OVERRIDE']),
    );
  });

  it('does not let a lower manual override demote executable deadline urgency', () => {
    const result = derive({
      deadlineAt: '2026-08-25T23:00:00.000Z',
      manualOverride: {
        level: 'LATER',
        reason: 'Team preference',
        expiresAt: '2026-08-27T00:00:00.000Z',
      },
    });

    expect(result).toMatchObject({
      level: 'NOW',
      overdue: true,
      manualOverrideActive: true,
      primaryReason: { code: 'DEADLINE_OVERDUE' },
    });
    expect(result.reasons.map((reason) => reason.code)).toEqual(
      expect.arrayContaining(['DEADLINE_OVERDUE', 'MANUAL_OVERRIDE']),
    );
  });
});

describe('deterministic tree sorting', () => {
  it('sorts by level, explicit order, deadline, importance, then stable id', () => {
    const sorted = sortTasksForTree([
      {
        id: 'z',
        actionLevel: 'NEXT',
        manualOrder: null,
        deadlineAt: null,
        importance: 5,
      },
      {
        id: 'b',
        actionLevel: 'NOW',
        manualOrder: 2,
        deadlineAt: null,
        importance: 1,
      },
      {
        id: 'a',
        actionLevel: 'NOW',
        manualOrder: 1,
        deadlineAt: null,
        importance: 1,
      },
      {
        id: 'd',
        actionLevel: 'NOW',
        manualOrder: null,
        deadlineAt: '2026-08-27T00:00:00.000Z',
        importance: 3,
      },
      {
        id: 'c',
        actionLevel: 'NOW',
        manualOrder: null,
        deadlineAt: '2026-08-27T00:00:00.000Z',
        importance: 3,
      },
    ]);

    expect(sorted.map((task) => task.id)).toEqual(['a', 'b', 'c', 'd', 'z']);
  });

  it("does not mutate the caller's array", () => {
    const tasks = [
      {
        id: 'b',
        actionLevel: 'LATER' as const,
        manualOrder: null,
        deadlineAt: null,
        importance: 1 as const,
      },
      {
        id: 'a',
        actionLevel: 'LATER' as const,
        manualOrder: null,
        deadlineAt: null,
        importance: 1 as const,
      },
    ];

    expect(sortTasksForTree(tasks).map((task) => task.id)).toEqual(['a', 'b']);
    expect(tasks.map((task) => task.id)).toEqual(['b', 'a']);
  });
});
