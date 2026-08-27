import { describe, expect, it } from 'vitest';

import { InMemoryDependencyGraph, findIncompletePrerequisiteTaskIds } from '../src/index.js';
import type { DomainError } from '../src/index.js';

const workspaceA = '30000000-0000-4000-8000-000000000001';
const workspaceB = '30000000-0000-4000-8000-000000000002';
const A = '30000000-0000-4000-8000-00000000000a';
const B = '30000000-0000-4000-8000-00000000000b';
const C = '30000000-0000-4000-8000-00000000000c';
const D = '30000000-0000-4000-8000-00000000000d';

function graph() {
  return new InMemoryDependencyGraph([
    { taskId: A, workspaceId: workspaceA },
    { taskId: B, workspaceId: workspaceA },
    { taskId: C, workspaceId: workspaceA },
    { taskId: D, workspaceId: workspaceB },
  ]);
}

describe('dependency DAG ports', () => {
  it('stores A BLOCKS B direction and returns stable direct queries', async () => {
    const dependencies = graph();
    const result = await dependencies.addBlockingDependency({
      workspaceId: workspaceA,
      prerequisiteTaskId: A,
      dependentTaskId: B,
    });

    expect(result).toMatchObject({ created: true, edge: { type: 'BLOCKS' } });
    expect(await dependencies.getPrerequisites(workspaceA, B)).toEqual([A]);
    expect(await dependencies.getDependents(workspaceA, A)).toEqual([B]);
    expect(await dependencies.isReachable(workspaceA, A, B)).toBe(true);
    expect(await dependencies.isReachable(workspaceA, B, A)).toBe(false);
  });

  it('treats a duplicate edge as an idempotent success', async () => {
    const dependencies = graph();
    const input = {
      workspaceId: workspaceA,
      prerequisiteTaskId: A,
      dependentTaskId: B,
    };

    expect((await dependencies.addBlockingDependency(input)).created).toBe(true);
    expect((await dependencies.addBlockingDependency(input)).created).toBe(false);
    expect(await dependencies.getPrerequisites(workspaceA, B)).toEqual([A]);
  });

  it('makes repeated edge removal an idempotent no-op', async () => {
    const dependencies = graph();
    const input = {
      workspaceId: workspaceA,
      prerequisiteTaskId: A,
      dependentTaskId: B,
    };
    await dependencies.addBlockingDependency(input);

    expect(await dependencies.removeDependency(input)).toBe(true);
    expect(await dependencies.removeDependency(input)).toBe(false);
    expect(await dependencies.getPrerequisites(workspaceA, B)).toEqual([]);
    expect(await dependencies.getDependents(workspaceA, A)).toEqual([]);
  });

  it('rejects self, cross-workspace, and dangling edges', async () => {
    const dependencies = graph();

    await expect(
      dependencies.addBlockingDependency({
        workspaceId: workspaceA,
        prerequisiteTaskId: A,
        dependentTaskId: A,
      }),
    ).rejects.toMatchObject({ code: 'SELF_DEPENDENCY' });
    await expect(
      dependencies.addBlockingDependency({
        workspaceId: workspaceA,
        prerequisiteTaskId: A,
        dependentTaskId: D,
      }),
    ).rejects.toMatchObject({
      code: 'CROSS_WORKSPACE_DEPENDENCY',
    });
    await expect(
      dependencies.addBlockingDependency({
        workspaceId: workspaceA,
        prerequisiteTaskId: A,
        dependentTaskId: '30000000-0000-4000-8000-000000000099',
      }),
    ).rejects.toMatchObject({ code: 'DANGLING_TASK' });
  });

  it('rejects direct and indirect cycles without changing existing edges', async () => {
    const dependencies = graph();
    await dependencies.addBlockingDependency({
      workspaceId: workspaceA,
      prerequisiteTaskId: A,
      dependentTaskId: B,
    });

    await expect(
      dependencies.addBlockingDependency({
        workspaceId: workspaceA,
        prerequisiteTaskId: B,
        dependentTaskId: A,
      }),
    ).rejects.toMatchObject({ code: 'DEPENDENCY_CYCLE' });

    await dependencies.addBlockingDependency({
      workspaceId: workspaceA,
      prerequisiteTaskId: B,
      dependentTaskId: C,
    });
    await expect(
      dependencies.addBlockingDependency({
        workspaceId: workspaceA,
        prerequisiteTaskId: C,
        dependentTaskId: A,
      }),
    ).rejects.toMatchObject({ code: 'DEPENDENCY_CYCLE' });
    expect(await dependencies.getPrerequisites(workspaceA, A)).toEqual([]);
  });

  it('bounds downstream impact traversal', async () => {
    const dependencies = graph();
    await dependencies.addBlockingDependency({
      workspaceId: workspaceA,
      prerequisiteTaskId: A,
      dependentTaskId: B,
    });
    await dependencies.addBlockingDependency({
      workspaceId: workspaceA,
      prerequisiteTaskId: B,
      dependentTaskId: C,
    });

    expect(await dependencies.getImpactSubgraph(workspaceA, A, 2)).toEqual({
      taskIds: [A, B],
      edges: [
        {
          workspaceId: workspaceA,
          prerequisiteTaskId: A,
          dependentTaskId: B,
          type: 'BLOCKS',
        },
      ],
      truncated: true,
    });
  });

  it('prevents removing a task while an edge would become dangling', async () => {
    const dependencies = graph();
    await dependencies.addBlockingDependency({
      workspaceId: workspaceA,
      prerequisiteTaskId: A,
      dependentTaskId: B,
    });

    expect(() => dependencies.removeTask(A)).toThrowError(
      expect.objectContaining<Partial<DomainError>>({ code: 'DANGLING_TASK' }),
    );
  });
});

describe('dependency executability helpers', () => {
  it('treats only DONE prerequisites as complete', () => {
    expect(
      findIncompletePrerequisiteTaskIds(
        [A, B, C],
        new Map([
          [A, 'DONE'],
          [B, 'CANCELED'],
          [C, 'IN_REVIEW'],
        ]),
      ),
    ).toEqual([B, C]);
  });

  it('rejects an incomplete prerequisite lookup with a missing stable task', () => {
    expect(() => findIncompletePrerequisiteTaskIds([A], new Map())).toThrowError(
      expect.objectContaining<Partial<DomainError>>({ code: 'DANGLING_TASK' }),
    );
  });
});
