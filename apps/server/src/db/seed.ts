import { hash } from '@node-rs/argon2';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config';
import { createPool, inTransaction } from './pool';
import { migrate } from './migrate';

const ids = {
  admin: '10000000-0000-4000-8000-000000000001',
  developer: '10000000-0000-4000-8000-000000000002',
  reviewer: '10000000-0000-4000-8000-000000000003',
  workspace: '20000000-0000-4000-8000-000000000001',
  tree: '30000000-0000-4000-8000-000000000001',
  workstream: '40000000-0000-4000-8000-000000000001',
  tasks: {
    unowned: '50000000-0000-4000-8000-000000000001',
    inProgress: '50000000-0000-4000-8000-000000000002',
    inReview: '50000000-0000-4000-8000-000000000003',
    manualBlocked: '50000000-0000-4000-8000-000000000004',
    prerequisite: '50000000-0000-4000-8000-000000000005',
    dependencyBlocked: '50000000-0000-4000-8000-000000000006',
    overdue: '50000000-0000-4000-8000-000000000007',
    done: '50000000-0000-4000-8000-000000000008',
  },
  dependency: '60000000-0000-4000-8000-000000000001',
} as const;

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.NODE_ENV === 'production')
    throw new Error('Development seed cannot run in production');
  const pool = createPool(config);
  try {
    await migrate(pool);
    const passwordHash = await hash('FanshuyeDemo2026!', {
      memoryCost: 19_456,
      timeCost: 3,
      outputLen: 32,
      parallelism: 1,
    });
    await inTransaction(pool, async (client) => {
      const users = [
        [ids.admin, 'admin@fanshuye.local', '林管理员'],
        [ids.developer, 'developer@fanshuye.local', '陈开发'],
        [ids.reviewer, 'reviewer@fanshuye.local', '周评审'],
      ] as const;
      for (const [id, email, name] of users) {
        await client.query(
          `INSERT INTO users(id, email, display_name, email_verified_at)
           VALUES ($1,$2,$3,clock_timestamp())
           ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, display_name = EXCLUDED.display_name,
             email_verified_at = COALESCE(users.email_verified_at, EXCLUDED.email_verified_at)`,
          [id, email, name],
        );
        await client.query(
          `INSERT INTO password_credentials(user_id, password_hash)
           VALUES ($1,$2) ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
          [id, passwordHash],
        );
      }
      await client.query(
        `INSERT INTO workspaces(id, name, timezone, created_by)
         VALUES ($1,'番薯叶开发组','Asia/Shanghai',$2)
         ON CONFLICT (id) DO NOTHING`,
        [ids.workspace, ids.admin],
      );
      for (const [userId, role] of [
        [ids.admin, 'ADMIN'],
        [ids.developer, 'MEMBER'],
        [ids.reviewer, 'MEMBER'],
      ] as const) {
        await client.query(
          `INSERT INTO workspace_memberships(workspace_id, user_id, role, status, removed_at)
           VALUES ($1,$2,$3,'ACTIVE',NULL)
           ON CONFLICT (workspace_id, user_id) DO UPDATE
             SET role = EXCLUDED.role, status = 'ACTIVE', removed_at = NULL`,
          [ids.workspace, userId, role],
        );
      }
      await client.query(
        `INSERT INTO workspace_sync_state(workspace_id) VALUES ($1)
         ON CONFLICT (workspace_id) DO NOTHING`,
        [ids.workspace],
      );
      await client.query(
        `INSERT INTO task_trees(id, workspace_id, name) VALUES ($1,$2,'团队任务树')
         ON CONFLICT (id) DO NOTHING`,
        [ids.tree, ids.workspace],
      );
      await client.query(
        `INSERT INTO workstreams(id, workspace_id, tree_id, name, sort_order)
         VALUES ($1,$2,$3,'产品开发',0) ON CONFLICT (id) DO NOTHING`,
        [ids.workstream, ids.workspace, ids.tree],
      );

      const taskRows = [
        [ids.tasks.unowned, '补充本地开发文档', null, 'TODO', null, null, 2, null, null],
        [
          ids.tasks.inProgress,
          '实现任务详情抽屉',
          ids.developer,
          'IN_PROGRESS',
          null,
          null,
          4,
          null,
          null,
        ],
        [
          ids.tasks.inReview,
          '评审任务状态机',
          ids.developer,
          'IN_REVIEW',
          null,
          null,
          5,
          null,
          null,
        ],
        [
          ids.tasks.manualBlocked,
          '修复 Windows 多屏定位',
          ids.developer,
          'IN_PROGRESS',
          'EXTERNAL',
          '等待多显示器测试设备',
          4,
          null,
          null,
        ],
        [
          ids.tasks.prerequisite,
          '完成同步协议',
          ids.admin,
          'IN_PROGRESS',
          null,
          null,
          5,
          null,
          null,
        ],
        [
          ids.tasks.dependencyBlocked,
          '接入桌面同步控制器',
          ids.developer,
          'TODO',
          null,
          null,
          5,
          null,
          null,
        ],
        [
          ids.tasks.overdue,
          '处理登录错误提示',
          ids.developer,
          'TODO',
          null,
          null,
          3,
          '-2 days',
          null,
        ],
        [ids.tasks.done, '建立单仓库', ids.admin, 'DONE', null, null, 4, null, '-1 day'],
      ] as const;
      for (const row of taskRows) {
        await client.query(
          `INSERT INTO tasks(
             id, workspace_id, tree_id, workstream_id, title, owner_id, status,
             manual_block_type, manual_block_reason, importance, due_at, archived_at,
             description, definition_of_done, created_by
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
             CASE WHEN $11::text IS NULL THEN NULL ELSE clock_timestamp() + $11::interval END,
             CASE WHEN $12::text IS NULL THEN NULL ELSE clock_timestamp() + $12::interval END,
             '用于验证番薯叶 MVP 的可重复种子任务', '满足任务标题描述的验收条件', $13
           ) ON CONFLICT (id) DO NOTHING`,
          [
            row[0],
            ids.workspace,
            ids.tree,
            ids.workstream,
            row[1],
            row[2],
            row[3],
            row[4],
            row[5],
            row[6],
            row[7],
            row[8],
            ids.admin,
          ],
        );
      }
      await client.query(
        `INSERT INTO task_collaborators(workspace_id, task_id, user_id, added_by)
         VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [ids.workspace, ids.tasks.inProgress, ids.reviewer, ids.admin],
      );
      await client.query(
        `INSERT INTO task_dependencies(
           id, workspace_id, prerequisite_task_id, dependent_task_id, created_by
         ) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [
          ids.dependency,
          ids.workspace,
          ids.tasks.prerequisite,
          ids.tasks.dependencyBlocked,
          ids.admin,
        ],
      );
    });
    process.stdout.write(
      'Seeded workspace 番薯叶开发组. Demo users share password FanshuyeDemo2026!\n',
    );
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
