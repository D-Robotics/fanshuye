import { describe, expect, it } from 'vitest';

import type { TaskStatus } from '@fanshuye/contracts';

import { allowedTransitions, assertTransition, canTransition } from '../src/index.js';
import type { DomainError } from '../src/index.js';

const statuses = [
  'TODO',
  'IN_PROGRESS',
  'IN_REVIEW',
  'DONE',
  'CANCELED',
] as const satisfies readonly TaskStatus[];

const expected = new Set([
  'TODO>IN_PROGRESS',
  'TODO>CANCELED',
  'IN_PROGRESS>TODO',
  'IN_PROGRESS>IN_REVIEW',
  'IN_PROGRESS>DONE',
  'IN_PROGRESS>CANCELED',
  'IN_REVIEW>IN_PROGRESS',
  'IN_REVIEW>DONE',
  'IN_REVIEW>CANCELED',
  'DONE>TODO',
  'CANCELED>TODO',
]);

describe('task state machine', () => {
  it.each(statuses.flatMap((from) => statuses.map((to) => [from, to] as const)))(
    'fully defines %s -> %s',
    (from, to) => {
      expect(canTransition(from, to)).toBe(expected.has(`${from}>${to}`));
    },
  );

  it('exposes only the transitions represented by canTransition', () => {
    for (const status of statuses) {
      expect(allowedTransitions(status)).toEqual(
        statuses.filter((target) => canTransition(status, target)),
      );
    }
  });

  it.each(statuses.flatMap((from) => statuses.map((to) => [from, to] as const)))(
    'enforces %s -> %s through the throwing guard',
    (from, to) => {
      if (expected.has(`${from}>${to}`)) {
        expect(() => assertTransition(from, to)).not.toThrow();
        return;
      }

      expect(() => assertTransition(from, to)).toThrowError(
        expect.objectContaining<Partial<DomainError>>({
          code: 'INVALID_TRANSITION',
          details: { currentStatus: from, requestedStatus: to },
        }),
      );
    },
  );

  it('returns current and requested states with an illegal transition', () => {
    expect(() => assertTransition('TODO', 'DONE')).toThrowError(
      expect.objectContaining<Partial<DomainError>>({
        code: 'INVALID_TRANSITION',
        details: { currentStatus: 'TODO', requestedStatus: 'DONE' },
      }),
    );
  });
});
