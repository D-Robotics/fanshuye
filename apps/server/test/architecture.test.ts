import { readFile, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

type AccessMode = 'read' | 'write';

type ModuleName = 'audit' | 'auth' | 'common' | 'dependencies' | 'sync' | 'tasks' | 'workspaces';

const TABLE_OWNERS = {
  users: 'auth',
  password_credentials: 'auth',
  email_verification_tokens: 'auth',
  sessions: 'auth',
  workspaces: 'workspaces',
  workspace_memberships: 'workspaces',
  workspace_invitations: 'workspaces',
  task_trees: 'workspaces',
  workstreams: 'workspaces',
  tasks: 'tasks',
  task_collaborators: 'tasks',
  task_external_references: 'tasks',
  task_dependencies: 'dependencies',
  workspace_sync_state: 'audit',
  task_events: 'audit',
  processed_commands: 'audit',
} as const satisfies Record<string, Exclude<ModuleName, 'common' | 'sync'>>;

type OwnedTable = keyof typeof TABLE_OWNERS;

interface CrossModuleDataBoundary {
  readonly file: `${ModuleName}/${string}.ts`;
  readonly table: OwnedTable;
  readonly access: readonly AccessMode[];
  readonly kind:
    | 'authorization-port'
    | 'domain-port-adapter'
    | 'composition-read-model'
    | 'application-read-boundary'
    | 'transaction-boundary-exception';
  readonly name: string;
  readonly rationale: string;
}

/**
 * This is intentionally an exact allow-list rather than a claim that the
 * modular monolith performs no cross-table reads. Snapshot/projection queries
 * compose several owners, dependency persistence validates task endpoints,
 * and two application services still contain explicitly audited transaction
 * boundaries. A new file, table or access mode must be reviewed here instead
 * of silently bypassing its owning module.
 */
const CROSS_MODULE_DATA_BOUNDARIES = [
  {
    file: 'common/access.ts',
    table: 'workspace_memberships',
    access: ['read'],
    kind: 'authorization-port',
    name: 'WorkspaceMembershipAuthorizationQuery',
    rationale:
      'Central membership guards are the authorization port used by every protected module.',
  },
  {
    file: 'dependencies/repository.ts',
    table: 'tasks',
    access: ['read'],
    kind: 'domain-port-adapter',
    name: 'DependencyTaskEndpointQuery',
    rationale:
      'The PostgreSQL dependency port validates stable task endpoints without exposing SQL to callers.',
  },
  {
    file: 'dependencies/repository.ts',
    table: 'workspaces',
    access: ['read', 'write'],
    kind: 'domain-port-adapter',
    name: 'DependencyGraphVersionLock',
    rationale:
      'The dependency port owns the graph_version column and locks it while preserving a DAG.',
  },
  ...[
    'users',
    'workspaces',
    'workspace_memberships',
    'task_trees',
    'workstreams',
    'task_dependencies',
    'workspace_sync_state',
    'task_events',
  ].map(
    (table) =>
      ({
        file: 'sync/service.ts',
        table,
        access: ['read'],
        kind: 'composition-read-model',
        name: 'WorkspaceSyncReadModel',
        rationale:
          'The authorized snapshot and delta read model composes confirmed state without mutating owners.',
      }) as CrossModuleDataBoundary,
  ),
  ...(['users', 'workspaces', 'task_dependencies'] as const).map(
    (table) =>
      ({
        file: 'tasks/projection.ts',
        table,
        access: ['read'],
        kind: 'composition-read-model',
        name: 'TaskProjectionReadModel',
        rationale:
          'The task projection composes display names, timezone and dependency facts as a read-only model.',
      }) as CrossModuleDataBoundary,
  ),
  ...(['users', 'task_trees', 'workstreams', 'workspace_sync_state', 'task_events'] as const).map(
    (table) =>
      ({
        file: 'tasks/service.ts',
        table,
        access: ['read'],
        kind: 'application-read-boundary',
        name: 'TaskApplicationReadBoundary',
        rationale:
          'This audited inline read dependency supplies task placement, actor display, cursor and timeline data.',
      }) as CrossModuleDataBoundary,
  ),
  {
    file: 'workspaces/service.ts',
    table: 'users',
    access: ['read'],
    kind: 'application-read-boundary',
    name: 'WorkspaceMemberDirectoryReadBoundary',
    rationale:
      'Workspace membership views resolve identity display data without changing the identity owner.',
  },
  {
    file: 'workspaces/service.ts',
    table: 'workspace_sync_state',
    access: ['read', 'write'],
    kind: 'transaction-boundary-exception',
    name: 'WorkspaceBootstrapEventStreamBoundary',
    rationale:
      'Workspace transactions bootstrap and return their event cursor atomically with appended audit events.',
  },
  {
    file: 'workspaces/service.ts',
    table: 'tasks',
    access: ['read', 'write'],
    kind: 'transaction-boundary-exception',
    name: 'WorkspaceMemberRemovalTaskCleanupBoundary',
    rationale:
      'Member removal atomically releases active ownership and versions affected task projections.',
  },
  {
    file: 'workspaces/service.ts',
    table: 'task_collaborators',
    access: ['write'],
    kind: 'transaction-boundary-exception',
    name: 'WorkspaceMemberRemovalTaskCleanupBoundary',
    rationale:
      'Member removal atomically deletes active collaboration links before access is revoked.',
  },
] as const satisfies readonly CrossModuleDataBoundary[];

describe('modular-monolith boundaries', () => {
  it("does not couple one module directly to another module's service implementation", async () => {
    const modulesRoot = join(process.cwd(), 'src', 'modules');
    const moduleNames = await readdir(modulesRoot);
    const violations: string[] = [];
    for (const moduleName of moduleNames) {
      const directory = join(modulesRoot, moduleName);
      for (const file of await collectTypeScriptFiles(directory)) {
        const content = await readFile(file, 'utf8');
        const imports = [...content.matchAll(/from\s+["']\.\.\/([^/]+)\/([^"']+)["']/g)];
        for (const match of imports) {
          const targetModule = match[1];
          const targetFile = match[2];
          if (targetModule && targetModule !== moduleName && targetFile?.endsWith('service')) {
            violations.push(`${moduleName} -> ${targetModule}/${targetFile}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('assigns every migrated application table to exactly one module', async () => {
    const migration = await readFile(join(process.cwd(), 'migrations', '0001_initial.sql'), 'utf8');
    const migratedTables = [
      ...migration.matchAll(/\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z_][a-z0-9_]*)"?/gi),
    ]
      .map((match) => match[1])
      .filter((table): table is string => table !== undefined)
      .sort();

    expect(migratedTables).toEqual(Object.keys(TABLE_OWNERS).sort());
  });

  it('rejects undeclared cross-module SQL access by file, table and read/write mode', async () => {
    const modulesRoot = join(process.cwd(), 'src', 'modules');
    const sourceFiles = await collectTypeScriptFiles(modulesRoot);
    const observedBoundaryKeys = new Set<string>();
    const violations: string[] = [];

    for (const absoluteFile of sourceFiles) {
      const file = normalizePath(relative(modulesRoot, absoluteFile));
      const moduleName = file.split('/')[0] as ModuleName;
      const content = await readFile(absoluteFile, 'utf8');

      for (const access of findSqlTableAccesses(content)) {
        const owner = TABLE_OWNERS[access.table];
        if (owner === moduleName) continue;

        const boundary = CROSS_MODULE_DATA_BOUNDARIES.find(
          (candidate) => candidate.file === file && candidate.table === access.table,
        );
        if (
          boundary === undefined ||
          !(boundary.access as readonly AccessMode[]).includes(access.mode)
        ) {
          violations.push(`${file} ${access.mode}s ${access.table} (owned by ${owner})`);
          continue;
        }
        observedBoundaryKeys.add(boundaryKey(boundary, access.mode));
      }
    }

    const staleDeclarations = CROSS_MODULE_DATA_BOUNDARIES.flatMap((boundary) =>
      boundary.access
        .filter((mode) => !observedBoundaryKeys.has(boundaryKey(boundary, mode)))
        .map((mode) => `${boundary.file} declares unused ${mode} access to ${boundary.table}`),
    );

    expect({ violations, staleDeclarations }).toEqual({ violations: [], staleDeclarations: [] });
  });

  it('keeps broad composition boundaries read-only and documents every exception', () => {
    const unsafeCompositionWrites = CROSS_MODULE_DATA_BOUNDARIES.filter(
      (boundary) =>
        boundary.kind === 'composition-read-model' &&
        (boundary.access as readonly AccessMode[]).includes('write'),
    );
    const undocumented = CROSS_MODULE_DATA_BOUNDARIES.filter(
      (boundary) => boundary.name.trim().length === 0 || boundary.rationale.trim().length < 24,
    );

    expect(unsafeCompositionWrites).toEqual([]);
    expect(undocumented).toEqual([]);
  });

  it('keeps dependency storage details behind the domain ports', async () => {
    const taskService = await readFile(
      join(process.cwd(), 'src', 'modules', 'tasks', 'service.ts'),
      'utf8',
    );
    const postgresAdapter = await readFile(
      join(process.cwd(), 'src', 'modules', 'dependencies', 'repository.ts'),
      'utf8',
    );

    expect(taskService).toContain('DependencyCommandPort');
    expect(taskService).toContain('DependencyQueryPort');
    expect(taskService).not.toContain('PostgresDependencyRepository');
    expect(taskService).not.toContain('task_dependencies');
    expect(taskService).not.toContain('graph_version');
    expect(postgresAdapter).toContain('implements DependencyCommandPort<DatabaseClient>');
    expect(postgresAdapter).toContain('DependencyQueryPort<DatabaseClient>');
  });
});

function findSqlTableAccesses(content: string): Array<{ table: OwnedTable; mode: AccessMode }> {
  const tablePattern = Object.keys(TABLE_OWNERS)
    .sort((left, right) => right.length - left.length)
    .map(escapeRegExp)
    .join('|');
  const pattern = new RegExp(
    `\\b(insert\\s+into|update|delete\\s+from|truncate(?:\\s+table)?|merge\\s+into|from|join|using)\\s+(?:"?[a-z_][a-z0-9_]*"?\\.)?"?(${tablePattern})"?\\b`,
    'gi',
  );
  const accesses = new Map<string, { table: OwnedTable; mode: AccessMode }>();

  for (const match of content.matchAll(pattern)) {
    const operation = match[1]?.toLowerCase();
    const table = match[2]?.toLowerCase() as OwnedTable | undefined;
    if (operation === undefined || table === undefined) continue;
    const mode: AccessMode = ['from', 'join', 'using'].includes(operation) ? 'read' : 'write';
    accesses.set(`${table}:${mode}`, { table, mode });
  }

  return [...accesses.values()].sort((left, right) =>
    `${left.table}:${left.mode}`.localeCompare(`${right.table}:${right.mode}`),
  );
}

function boundaryKey(boundary: CrossModuleDataBoundary, mode: AccessMode): string {
  return `${boundary.file}:${boundary.table}:${mode}`;
}

function normalizePath(path: string): string {
  return path.split(sep).join('/');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function collectTypeScriptFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectTypeScriptFiles(path)));
    else if (entry.name.endsWith('.ts')) files.push(path);
  }
  return files;
}
