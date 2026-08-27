import type { DependencyEdge } from '@fanshuye/contracts';
import type {
  AddBlockingDependencyInput,
  AddDependencyResult,
  DependencyCommandPort,
  DependencyQueryPort,
  ImpactSubgraph,
  RemoveDependencyInput,
} from '@fanshuye/domain';
import type { AppConfig } from '../../config';
import { inTransaction, type DatabaseClient, type DatabasePool } from '../../db/pool';
import { ApiError } from '../../lib/errors';
import type { MetricsRegistry } from '../../observability/metrics';

type Queryable = Pick<DatabaseClient, 'query'>;

export interface RelatedDependencyTask {
  id: string;
  title: string;
  status: string;
  version: number;
  incomplete: boolean;
}

export interface ImpactNode {
  taskId: string;
  depth: number;
  direction: 'UPSTREAM' | 'DOWNSTREAM';
}

/** PostgreSQL adapter for the storage-agnostic dependency domain ports. */
export class PostgresDependencyRepository
  implements DependencyCommandPort<DatabaseClient>, DependencyQueryPort<DatabaseClient>
{
  public constructor(
    private readonly pool: DatabasePool,
    private readonly config: Pick<
      AppConfig,
      'DEPENDENCY_QUERY_TIMEOUT_MS' | 'DEPENDENCY_QUERY_MAX_NODES'
    >,
    private readonly metrics: MetricsRegistry,
  ) {}

  async prepareMutation(
    workspaceId: string,
    taskIds: readonly string[],
    unitOfWork?: DatabaseClient,
  ): Promise<void> {
    if (!unitOfWork) {
      return inTransaction(this.pool, (client) =>
        this.prepareMutation(workspaceId, taskIds, client),
      );
    }
    await unitOfWork.query(`SELECT graph_version FROM workspaces WHERE id = $1 FOR UPDATE`, [
      workspaceId,
    ]);
    const uniqueTaskIds = [...new Set(taskIds)].sort();
    const tasks = await unitOfWork.query<{ id: string }>(
      `SELECT id FROM tasks
        WHERE workspace_id = $1 AND id = ANY($2::uuid[])
        ORDER BY id
        FOR UPDATE`,
      [workspaceId, uniqueTaskIds],
    );
    if (tasks.rowCount !== uniqueTaskIds.length) {
      throw new ApiError(404, 'NOT_FOUND', 'One or more dependency tasks are unavailable');
    }
  }

  async addBlockingDependency(
    input: AddBlockingDependencyInput,
    unitOfWork?: DatabaseClient,
  ): Promise<AddDependencyResult> {
    if (!unitOfWork) {
      return inTransaction(this.pool, (client) => this.addBlockingDependency(input, client));
    }
    if (!input.actorId) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'Authenticated dependency actor is required');
    }
    if (input.prerequisiteTaskId === input.dependentTaskId) {
      throw new ApiError(422, 'DEPENDENCY_CONFLICT', 'A task cannot block itself');
    }

    await this.prepareMutation(
      input.workspaceId,
      [input.prerequisiteTaskId, input.dependentTaskId],
      unitOfWork,
    );
    await this.limitQuery(unitOfWork);

    const duplicate = await unitOfWork.query<DependencyRow>(
      `SELECT prerequisite_task_id, dependent_task_id
         FROM task_dependencies
        WHERE workspace_id = $1 AND prerequisite_task_id = $2 AND dependent_task_id = $3`,
      [input.workspaceId, input.prerequisiteTaskId, input.dependentTaskId],
    );
    const existing = duplicate.rows[0];
    if (existing) return { edge: mapEdge(input.workspaceId, existing), created: false };

    const cycle = await this.metrics.measureDependencyQuery('reachability', () =>
      this.isReachableWith(
        unitOfWork,
        input.workspaceId,
        input.dependentTaskId,
        input.prerequisiteTaskId,
      ),
    );
    if (cycle) {
      throw new ApiError(409, 'DEPENDENCY_CYCLE', 'Dependency would create a directed cycle', {
        prerequisiteTaskId: input.prerequisiteTaskId,
        dependentTaskId: input.dependentTaskId,
      });
    }

    const inserted = await unitOfWork.query<DependencyRow>(
      `INSERT INTO task_dependencies(
         workspace_id, prerequisite_task_id, dependent_task_id, created_by
       ) VALUES ($1,$2,$3,$4)
       RETURNING prerequisite_task_id, dependent_task_id`,
      [input.workspaceId, input.prerequisiteTaskId, input.dependentTaskId, input.actorId],
    );
    await unitOfWork.query(
      `UPDATE workspaces SET graph_version = graph_version + 1 WHERE id = $1`,
      [input.workspaceId],
    );
    const row = inserted.rows[0];
    if (!row) throw new Error('Dependency insert did not return a row');
    return { edge: mapEdge(input.workspaceId, row), created: true };
  }

  async removeDependency(
    input: RemoveDependencyInput,
    unitOfWork?: DatabaseClient,
  ): Promise<boolean> {
    if (!unitOfWork) {
      return inTransaction(this.pool, (client) => this.removeDependency(input, client));
    }
    await this.prepareMutation(
      input.workspaceId,
      [input.prerequisiteTaskId, input.dependentTaskId],
      unitOfWork,
    );
    const result = await unitOfWork.query(
      `DELETE FROM task_dependencies
        WHERE workspace_id = $1 AND prerequisite_task_id = $2 AND dependent_task_id = $3`,
      [input.workspaceId, input.prerequisiteTaskId, input.dependentTaskId],
    );
    if (!result.rowCount) return false;
    await unitOfWork.query(
      `UPDATE workspaces SET graph_version = graph_version + 1 WHERE id = $1`,
      [input.workspaceId],
    );
    return true;
  }

  async getPrerequisites(
    workspaceId: string,
    taskId: string,
    unitOfWork?: DatabaseClient,
  ): Promise<readonly string[]> {
    return this.metrics.measureDependencyQuery('prerequisites', async () => {
      if (unitOfWork) {
        await unitOfWork.query(`SELECT graph_version FROM workspaces WHERE id = $1 FOR SHARE`, [
          workspaceId,
        ]);
      }
      const result = await (unitOfWork ?? this.pool).query<{ task_id: string }>(
        `SELECT prerequisite_task_id AS task_id
           FROM task_dependencies
          WHERE workspace_id = $1 AND dependent_task_id = $2
          ORDER BY prerequisite_task_id`,
        [workspaceId, taskId],
      );
      return result.rows.map((row) => row.task_id);
    });
  }

  async getDependents(
    workspaceId: string,
    taskId: string,
    unitOfWork?: DatabaseClient,
  ): Promise<readonly string[]> {
    return this.metrics.measureDependencyQuery('dependents', async () => {
      if (unitOfWork) {
        await unitOfWork.query(`SELECT graph_version FROM workspaces WHERE id = $1 FOR SHARE`, [
          workspaceId,
        ]);
      }
      const result = await (unitOfWork ?? this.pool).query<{ task_id: string }>(
        `SELECT dependent_task_id AS task_id
           FROM task_dependencies
          WHERE workspace_id = $1 AND prerequisite_task_id = $2
          ORDER BY dependent_task_id`,
        [workspaceId, taskId],
      );
      return result.rows.map((row) => row.task_id);
    });
  }

  async isReachable(
    workspaceId: string,
    fromTaskId: string,
    toTaskId: string,
    unitOfWork?: DatabaseClient,
  ): Promise<boolean> {
    return this.metrics.measureDependencyQuery('reachability', async () => {
      if (unitOfWork) {
        await this.limitQuery(unitOfWork);
        return this.isReachableWith(unitOfWork, workspaceId, fromTaskId, toTaskId);
      }
      return this.withReadClient(async (client) => {
        await this.limitQuery(client);
        return this.isReachableWith(client, workspaceId, fromTaskId, toTaskId);
      });
    });
  }

  async getImpactSubgraph(
    workspaceId: string,
    taskId: string,
    maxNodes: number,
    unitOfWork?: DatabaseClient,
  ): Promise<ImpactSubgraph> {
    return this.metrics.measureDependencyQuery('impact_subgraph', async () => {
      if (!Number.isInteger(maxNodes) || maxNodes < 1) {
        throw new ApiError(422, 'VALIDATION_ERROR', 'maxNodes must be a positive integer');
      }
      const load = async (database: DatabaseClient): Promise<ImpactSubgraph> => {
        await this.limitQuery(database);
        const nodes = await this.getImpactNodesWith(database, workspaceId, taskId, maxNodes + 1);
        const uniqueTaskIds = [...new Set([taskId, ...nodes.map((node) => node.taskId)])];
        const truncated = uniqueTaskIds.length > maxNodes;
        const taskIds = uniqueTaskIds.slice(0, maxNodes).sort();
        const edges = await database.query<DependencyRow>(
          `SELECT prerequisite_task_id, dependent_task_id
             FROM task_dependencies
            WHERE workspace_id = $1
              AND prerequisite_task_id = ANY($2::uuid[])
              AND dependent_task_id = ANY($2::uuid[])
            ORDER BY prerequisite_task_id, dependent_task_id`,
          [workspaceId, taskIds],
        );
        return {
          taskIds,
          edges: edges.rows.map((row) => mapEdge(workspaceId, row)),
          truncated,
        };
      };
      return unitOfWork ? load(unitOfWork) : this.withReadClient(load);
    });
  }

  /** Rich read model used only at the HTTP composition edge. */
  async getPrerequisiteDetails(
    workspaceId: string,
    taskId: string,
  ): Promise<RelatedDependencyTask[]> {
    return this.metrics.measureDependencyQuery('prerequisites', () =>
      this.getRelatedTaskDetails(workspaceId, taskId, 'prerequisite'),
    );
  }

  /** Rich read model used only at the HTTP composition edge. */
  async getDependentDetails(workspaceId: string, taskId: string): Promise<RelatedDependencyTask[]> {
    return this.metrics.measureDependencyQuery('dependents', () =>
      this.getRelatedTaskDetails(workspaceId, taskId, 'dependent'),
    );
  }

  async getImpactNodes(workspaceId: string, taskId: string): Promise<ImpactNode[]> {
    return this.metrics.measureDependencyQuery('impact_nodes', () =>
      this.withReadClient(async (client) => {
        await this.limitQuery(client);
        return this.getImpactNodesWith(
          client,
          workspaceId,
          taskId,
          this.config.DEPENDENCY_QUERY_MAX_NODES,
        );
      }),
    );
  }

  private async getRelatedTaskDetails(
    workspaceId: string,
    taskId: string,
    direction: 'prerequisite' | 'dependent',
  ): Promise<RelatedDependencyTask[]> {
    const relatedColumn =
      direction === 'prerequisite' ? 'prerequisite_task_id' : 'dependent_task_id';
    const filterColumn =
      direction === 'prerequisite' ? 'dependent_task_id' : 'prerequisite_task_id';
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT t.id, t.title, t.status, t.version,
              (t.status <> 'DONE') AS incomplete
         FROM task_dependencies d
         JOIN tasks t ON t.workspace_id = d.workspace_id AND t.id = d.${relatedColumn}
        WHERE d.workspace_id = $1 AND d.${filterColumn} = $2
        ORDER BY lower(t.title), t.id`,
      [workspaceId, taskId],
    );
    return result.rows.map(mapRelatedTask);
  }

  private async getImpactNodesWith(
    database: Queryable,
    workspaceId: string,
    taskId: string,
    maxNodes: number,
  ): Promise<ImpactNode[]> {
    const result = await database.query<{
      task_id: string;
      depth: number;
      direction: 'UPSTREAM' | 'DOWNSTREAM';
    }>(
      `WITH RECURSIVE upstream(task_id, depth, path) AS (
         SELECT d.prerequisite_task_id, 1, ARRAY[$2::uuid, d.prerequisite_task_id]
           FROM task_dependencies d
          WHERE d.workspace_id = $1 AND d.dependent_task_id = $2
         UNION ALL
         SELECT d.prerequisite_task_id, i.depth + 1, i.path || d.prerequisite_task_id
           FROM upstream i
           JOIN task_dependencies d
             ON d.workspace_id = $1 AND d.dependent_task_id = i.task_id
          WHERE NOT d.prerequisite_task_id = ANY(i.path)
       ), downstream(task_id, depth, path) AS (
         SELECT d.dependent_task_id, 1, ARRAY[$2::uuid, d.dependent_task_id]
           FROM task_dependencies d
          WHERE d.workspace_id = $1 AND d.prerequisite_task_id = $2
         UNION ALL
         SELECT d.dependent_task_id, i.depth + 1, i.path || d.dependent_task_id
           FROM downstream i
           JOIN task_dependencies d
             ON d.workspace_id = $1 AND d.prerequisite_task_id = i.task_id
          WHERE NOT d.dependent_task_id = ANY(i.path)
       ), impact(task_id, depth, direction) AS (
         SELECT task_id, depth, 'UPSTREAM'::text FROM upstream
         UNION ALL
         SELECT task_id, depth, 'DOWNSTREAM'::text FROM downstream
       )
       SELECT task_id, min(depth)::int AS depth, direction
         FROM impact
        GROUP BY task_id, direction
        ORDER BY depth, direction, task_id
        LIMIT $3`,
      [workspaceId, taskId, maxNodes],
    );
    return result.rows.map((row) => ({
      taskId: row.task_id,
      depth: row.depth,
      direction: row.direction,
    }));
  }

  private async isReachableWith(
    database: Queryable,
    workspaceId: string,
    fromTaskId: string,
    toTaskId: string,
  ): Promise<boolean> {
    const result = await database.query<{ reachable: boolean }>(
      `WITH RECURSIVE reachable(task_id, path) AS (
         SELECT d.dependent_task_id, ARRAY[$2::uuid, d.dependent_task_id]
           FROM task_dependencies d
          WHERE d.workspace_id = $1 AND d.prerequisite_task_id = $2
         UNION ALL
         SELECT d.dependent_task_id, r.path || d.dependent_task_id
           FROM reachable r
           JOIN task_dependencies d
             ON d.workspace_id = $1 AND d.prerequisite_task_id = r.task_id
          WHERE NOT d.dependent_task_id = ANY(r.path)
       )
       SELECT EXISTS(SELECT 1 FROM reachable WHERE task_id = $3 LIMIT 1) AS reachable`,
      [workspaceId, fromTaskId, toTaskId],
    );
    return result.rows[0]?.reachable ?? false;
  }

  private async limitQuery(client: DatabaseClient): Promise<void> {
    await client.query("SELECT set_config('statement_timeout', $1, true)", [
      `${this.config.DEPENDENCY_QUERY_TIMEOUT_MS}ms`,
    ]);
  }

  private async withReadClient<T>(work: (client: DatabaseClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN READ ONLY');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

interface DependencyRow {
  prerequisite_task_id: string;
  dependent_task_id: string;
}

function mapEdge(workspaceId: string, row: DependencyRow): DependencyEdge {
  return {
    workspaceId,
    prerequisiteTaskId: row.prerequisite_task_id,
    dependentTaskId: row.dependent_task_id,
    type: 'BLOCKS',
  };
}

function mapRelatedTask(row: Record<string, unknown>): RelatedDependencyTask {
  return {
    id: String(row.id),
    title: String(row.title),
    status: String(row.status),
    version: Number(row.version),
    incomplete: Boolean(row.incomplete),
  };
}
