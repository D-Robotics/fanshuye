import type { DependencyEdge, TaskStatus } from '@fanshuye/contracts';

import { DomainError } from './errors.js';

export interface AddBlockingDependencyInput {
  readonly workspaceId: string;
  readonly prerequisiteTaskId: string;
  readonly dependentTaskId: string;
  /** Authenticated actor creating the durable edge, when persistence records it. */
  readonly actorId?: string;
}

export type RemoveDependencyInput = AddBlockingDependencyInput;

export interface AddDependencyResult {
  readonly edge: DependencyEdge;
  readonly created: boolean;
}

export interface ImpactSubgraph {
  readonly taskIds: readonly string[];
  readonly edges: readonly DependencyEdge[];
  readonly truncated: boolean;
}

export interface DependencyCommandPort<TUnitOfWork = void> {
  prepareMutation(
    workspaceId: string,
    taskIds: readonly string[],
    unitOfWork?: TUnitOfWork,
  ): Promise<void>;
  addBlockingDependency(
    input: AddBlockingDependencyInput,
    unitOfWork?: TUnitOfWork,
  ): Promise<AddDependencyResult>;
  removeDependency(input: RemoveDependencyInput, unitOfWork?: TUnitOfWork): Promise<boolean>;
}

export interface DependencyQueryPort<TUnitOfWork = void> {
  getPrerequisites(
    workspaceId: string,
    taskId: string,
    unitOfWork?: TUnitOfWork,
  ): Promise<readonly string[]>;
  getDependents(
    workspaceId: string,
    taskId: string,
    unitOfWork?: TUnitOfWork,
  ): Promise<readonly string[]>;
  isReachable(
    workspaceId: string,
    fromTaskId: string,
    toTaskId: string,
    unitOfWork?: TUnitOfWork,
  ): Promise<boolean>;
  getImpactSubgraph(
    workspaceId: string,
    taskId: string,
    maxNodes: number,
    unitOfWork?: TUnitOfWork,
  ): Promise<ImpactSubgraph>;
}

export interface DependencyTaskReference {
  readonly taskId: string;
  readonly workspaceId: string;
}

/**
 * Deterministic in-memory DAG used by domain tests and local prototypes.
 * Production persistence stays behind the same ports and may use PostgreSQL
 * recursive CTEs; this helper deliberately has no database-specific API.
 */
export class InMemoryDependencyGraph implements DependencyCommandPort, DependencyQueryPort {
  readonly #tasks = new Map<string, DependencyTaskReference>();
  readonly #edges = new Map<string, DependencyEdge>();

  constructor(tasks: readonly DependencyTaskReference[] = []) {
    for (const task of tasks) this.registerTask(task);
  }

  registerTask(task: DependencyTaskReference): void {
    const existing = this.#tasks.get(task.taskId);
    if (existing !== undefined && existing.workspaceId !== task.workspaceId) {
      throw new DomainError(
        'CROSS_WORKSPACE_DEPENDENCY',
        'A stable task ID cannot belong to two workspaces',
        { taskId: task.taskId },
      );
    }
    this.#tasks.set(task.taskId, { ...task });
  }

  removeTask(taskId: string): void {
    for (const edge of this.#edges.values()) {
      if (edge.prerequisiteTaskId === taskId || edge.dependentTaskId === taskId) {
        throw new DomainError('DANGLING_TASK', 'A task with dependency edges cannot be removed', {
          taskId,
        });
      }
    }
    this.#tasks.delete(taskId);
  }

  async prepareMutation(workspaceId: string, taskIds: readonly string[]): Promise<void> {
    for (const taskId of [...new Set(taskIds)].sort()) {
      this.#assertTaskInWorkspace(taskId, workspaceId);
    }
  }

  async addBlockingDependency(input: AddBlockingDependencyInput): Promise<AddDependencyResult> {
    const { prerequisite, dependent } = this.#validateEndpoints(input);

    if (prerequisite.taskId === dependent.taskId) {
      throw new DomainError('SELF_DEPENDENCY', 'A task cannot block itself', {
        taskId: prerequisite.taskId,
      });
    }

    const key = edgeKey(input.workspaceId, prerequisite.taskId, dependent.taskId);
    const existing = this.#edges.get(key);
    if (existing !== undefined) return { edge: { ...existing }, created: false };

    if (await this.isReachable(input.workspaceId, dependent.taskId, prerequisite.taskId)) {
      throw new DomainError('DEPENDENCY_CYCLE', 'The dependency would create a directed cycle', {
        prerequisiteTaskId: prerequisite.taskId,
        dependentTaskId: dependent.taskId,
      });
    }

    const edge: DependencyEdge = {
      workspaceId: input.workspaceId,
      prerequisiteTaskId: prerequisite.taskId,
      dependentTaskId: dependent.taskId,
      type: 'BLOCKS',
    };
    this.#edges.set(key, edge);
    return { edge: { ...edge }, created: true };
  }

  async removeDependency(input: RemoveDependencyInput): Promise<boolean> {
    this.#validateEndpoints(input);
    return this.#edges.delete(
      edgeKey(input.workspaceId, input.prerequisiteTaskId, input.dependentTaskId),
    );
  }

  async getPrerequisites(workspaceId: string, taskId: string): Promise<readonly string[]> {
    this.#assertTaskInWorkspace(taskId, workspaceId);
    return [...this.#edges.values()]
      .filter((edge) => edge.workspaceId === workspaceId && edge.dependentTaskId === taskId)
      .map((edge) => edge.prerequisiteTaskId)
      .sort();
  }

  async getDependents(workspaceId: string, taskId: string): Promise<readonly string[]> {
    this.#assertTaskInWorkspace(taskId, workspaceId);
    return [...this.#edges.values()]
      .filter((edge) => edge.workspaceId === workspaceId && edge.prerequisiteTaskId === taskId)
      .map((edge) => edge.dependentTaskId)
      .sort();
  }

  async isReachable(workspaceId: string, fromTaskId: string, toTaskId: string): Promise<boolean> {
    this.#assertTaskInWorkspace(fromTaskId, workspaceId);
    this.#assertTaskInWorkspace(toTaskId, workspaceId);
    if (fromTaskId === toTaskId) return true;

    const visited = new Set<string>([fromTaskId]);
    const queue = [fromTaskId];
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) break;
      const dependents = await this.getDependents(workspaceId, current);
      for (const dependentId of dependents) {
        if (dependentId === toTaskId) return true;
        if (!visited.has(dependentId)) {
          visited.add(dependentId);
          queue.push(dependentId);
        }
      }
    }
    return false;
  }

  async getImpactSubgraph(
    workspaceId: string,
    taskId: string,
    maxNodes: number,
  ): Promise<ImpactSubgraph> {
    if (!Number.isInteger(maxNodes) || maxNodes < 1) {
      throw new DomainError('VALIDATION_ERROR', 'maxNodes must be a positive integer', {
        maxNodes,
      });
    }
    this.#assertTaskInWorkspace(taskId, workspaceId);

    const visited = new Set<string>([taskId]);
    const queue = [taskId];
    let truncated = false;

    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) break;
      const dependents = await this.getDependents(workspaceId, current);
      for (const dependentId of dependents) {
        if (visited.has(dependentId)) continue;
        if (visited.size >= maxNodes) {
          truncated = true;
          continue;
        }
        visited.add(dependentId);
        queue.push(dependentId);
      }
    }

    const taskIds = [...visited].sort();
    const edges = [...this.#edges.values()]
      .filter(
        (edge) =>
          edge.workspaceId === workspaceId &&
          visited.has(edge.prerequisiteTaskId) &&
          visited.has(edge.dependentTaskId),
      )
      .sort((left, right) =>
        edgeKey(left.workspaceId, left.prerequisiteTaskId, left.dependentTaskId).localeCompare(
          edgeKey(right.workspaceId, right.prerequisiteTaskId, right.dependentTaskId),
        ),
      )
      .map((edge) => ({ ...edge }));

    return { taskIds, edges, truncated };
  }

  #validateEndpoints(input: AddBlockingDependencyInput): {
    prerequisite: DependencyTaskReference;
    dependent: DependencyTaskReference;
  } {
    const prerequisite = this.#tasks.get(input.prerequisiteTaskId);
    const dependent = this.#tasks.get(input.dependentTaskId);
    if (prerequisite === undefined || dependent === undefined) {
      throw new DomainError('DANGLING_TASK', 'Both dependency endpoints must exist', {
        prerequisiteTaskId: input.prerequisiteTaskId,
        dependentTaskId: input.dependentTaskId,
      });
    }
    if (
      prerequisite.workspaceId !== input.workspaceId ||
      dependent.workspaceId !== input.workspaceId
    ) {
      throw new DomainError(
        'CROSS_WORKSPACE_DEPENDENCY',
        'Dependency endpoints must belong to the same requested workspace',
        {
          workspaceId: input.workspaceId,
          prerequisiteWorkspaceId: prerequisite.workspaceId,
          dependentWorkspaceId: dependent.workspaceId,
        },
      );
    }
    return { prerequisite, dependent };
  }

  #assertTaskInWorkspace(taskId: string, workspaceId: string): void {
    const task = this.#tasks.get(taskId);
    if (task === undefined) {
      throw new DomainError('DANGLING_TASK', 'Task does not exist', {
        taskId,
      });
    }
    if (task.workspaceId !== workspaceId) {
      throw new DomainError(
        'CROSS_WORKSPACE_DEPENDENCY',
        'Task does not belong to the requested workspace',
        { taskId, workspaceId },
      );
    }
  }
}

export function findIncompletePrerequisiteTaskIds(
  prerequisiteTaskIds: readonly string[],
  statusByTaskId: ReadonlyMap<string, TaskStatus>,
): string[] {
  const result: string[] = [];
  for (const taskId of new Set(prerequisiteTaskIds)) {
    const status = statusByTaskId.get(taskId);
    if (status === undefined) {
      throw new DomainError('DANGLING_TASK', 'A prerequisite task status is missing', { taskId });
    }
    if (status !== 'DONE') result.push(taskId);
  }
  return result.sort();
}

function edgeKey(workspaceId: string, prerequisiteTaskId: string, dependentTaskId: string): string {
  return `${workspaceId}:${prerequisiteTaskId}>${dependentTaskId}`;
}
