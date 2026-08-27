import { describe, expect, it } from 'vitest';

import type { TaskSummary } from '@fanshuye/contracts';

import { findPotentialDuplicateTasks, normalizeTitle, titleSimilarity } from '../src/index.js';

const workspaceId = '40000000-0000-4000-8000-000000000001';

function summary(id: string, title: string, status: TaskSummary['status'] = 'TODO'): TaskSummary {
  return {
    id,
    workspaceId,
    title,
    status,
    ownerId: null,
    importance: 3,
    deadlineAt: null,
    version: 1,
    archivedAt: status === 'DONE' || status === 'CANCELED' ? '2026-08-26T00:00:00.000Z' : null,
  };
}

describe('deterministic active-title duplicate search', () => {
  it('normalizes punctuation, width, case, and whitespace', () => {
    expect(normalizeTitle('  FIX：Login   Timeout! ')).toBe('fix login timeout');
  });

  it('returns strong active matches and never blocks creation', () => {
    const exactId = '40000000-0000-4000-8000-000000000002';
    const similarId = '40000000-0000-4000-8000-000000000003';
    const matches = findPotentialDuplicateTasks('Fix login timeout', [
      summary(similarId, 'Fix the login timeout bug'),
      summary(exactId, 'FIX: login timeout'),
      summary('40000000-0000-4000-8000-000000000004', 'Fix login timeout', 'DONE'),
      summary('40000000-0000-4000-8000-000000000005', 'Redesign settings'),
    ]);

    expect(matches.map((match) => match.task.id)).toEqual([exactId, similarId]);
    expect(matches[0]?.similarity).toBe(1);
    expect(findPotentialDuplicateTasks('', [])).toEqual([]);
  });

  it('uses a deterministic bounded similarity', () => {
    const score = titleSimilarity(
      normalizeTitle('login timeout fix'),
      normalizeTitle('fix login timeout'),
    );
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(1);
  });
});
