import type { TaskSummary } from '@fanshuye/contracts';

import { isActiveStatus } from './task-state-machine.js';

export interface PotentialDuplicate {
  readonly task: TaskSummary;
  readonly similarity: number;
}

export function findPotentialDuplicateTasks(
  title: string,
  tasks: readonly TaskSummary[],
  threshold = 0.45,
): PotentialDuplicate[] {
  const normalizedQuery = normalizeTitle(title);
  if (normalizedQuery.length === 0) return [];

  return tasks
    .filter((task) => task.archivedAt === null && isActiveStatus(task.status))
    .map((task) => ({
      task,
      similarity: titleSimilarity(normalizedQuery, normalizeTitle(task.title)),
    }))
    .filter((candidate) => candidate.similarity >= threshold)
    .sort((left, right) => {
      const scoreDifference = right.similarity - left.similarity;
      if (scoreDifference !== 0) return scoreDifference;
      if (left.task.id < right.task.id) return -1;
      if (left.task.id > right.task.id) return 1;
      return 0;
    });
}

export function normalizeTitle(title: string): string {
  return title
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('en-US')
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function titleSimilarity(normalizedLeft: string, normalizedRight: string): number {
  if (normalizedLeft === normalizedRight) return 1;
  if (normalizedLeft.length === 0 || normalizedRight.length === 0) return 0;
  if (normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft)) {
    const shorter = Math.min(normalizedLeft.length, normalizedRight.length);
    const longer = Math.max(normalizedLeft.length, normalizedRight.length);
    return 0.8 + 0.2 * (shorter / longer);
  }

  const leftBigrams = bigrams(normalizedLeft);
  const rightBigrams = bigrams(normalizedRight);
  let intersection = 0;
  const remaining = new Map(rightBigrams);
  for (const [bigram, count] of leftBigrams) {
    const matching = Math.min(count, remaining.get(bigram) ?? 0);
    intersection += matching;
  }
  const leftCount = sumCounts(leftBigrams);
  const rightCount = sumCounts(rightBigrams);
  return (2 * intersection) / (leftCount + rightCount);
}

function bigrams(value: string): Map<string, number> {
  const padded = ` ${value} `;
  const result = new Map<string, number>();
  for (let index = 0; index < padded.length - 1; index += 1) {
    const bigram = padded.slice(index, index + 2);
    result.set(bigram, (result.get(bigram) ?? 0) + 1);
  }
  return result;
}

function sumCounts(values: ReadonlyMap<string, number>): number {
  let total = 0;
  for (const value of values.values()) total += value;
  return total;
}
