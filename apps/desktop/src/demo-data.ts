import type { MemberSummary, TaskItem } from '@fanshuye/ui';

export const DEMO_MEMBERS: MemberSummary[] = [
  { id: 'member-ada', displayName: '艾达' },
  { id: 'member-lin', displayName: '林工' },
  { id: 'member-chen', displayName: '陈工' },
  { id: 'member-wu', displayName: '吴工' },
];

const titles = [
  '修复刷新令牌竞争条件',
  '完成桌面端任务树键盘导航',
  '评审任务认领事务实现',
  '补齐 WebSocket 断线恢复测试',
  '确认 Windows 150% DPI 表现',
  '收敛任务命令错误码',
  '验证依赖环并发保护',
  '设计首次登录空状态',
  '实现工作区成员邀请',
  '检查任务缓存隐私边界',
  '修正待评审状态通知',
  '建立数据库迁移基线',
  '梳理 API 权限测试矩阵',
  '优化树面 15 片叶子布局',
  '补写 Definition of Done 示例',
  '处理任务版本冲突反馈',
  '测试系统托盘退出流程',
  '实现全局快捷键设置',
  '验证透明窗口降级面板',
  '限制外部引用 URL 协议',
  '完善任务详情动态时间线',
  '检查高对比度视觉语义',
  '准备 30 任务可用性脚本',
  '验证离线首次启动提示',
  '调整悬浮窗移出延迟',
  '完成列表负责人筛选',
  '归档旧版同步原型',
  '取消过期的实验任务',
  '整理首轮试点反馈',
  '关闭无效性能调查',
];

const workstreams = [
  { id: 'desktop', name: '桌面端' },
  { id: 'backend', name: '服务端' },
  { id: 'quality', name: '质量与发布' },
] as const;

export function createDemoTasks(now = new Date()): TaskItem[] {
  return titles.map((title, index) => {
    const terminal = index >= 26;
    const status: TaskItem['status'] = terminal
      ? index % 2 === 0
        ? 'DONE'
        : 'CANCELED'
      : index % 6 === 2
        ? 'IN_REVIEW'
        : index % 3 === 0
          ? 'TODO'
          : 'IN_PROGRESS';
    const actionLevel: TaskItem['actionLevel'] = index < 6 ? 'NOW' : index < 16 ? 'NEXT' : 'LATER';
    const owner = index % 5 === 0 ? null : DEMO_MEMBERS[index % DEMO_MEMBERS.length]!;
    const collaborator = index % 4 === 1 ? DEMO_MEMBERS[(index + 1) % DEMO_MEMBERS.length]! : null;
    const workstream = workstreams[index % workstreams.length]!;
    const importance = ((index % 5) + 1) as TaskItem['importance'];
    const dueAt = new Date(now.getTime() + (index - 2) * 24 * 60 * 60 * 1000).toISOString();
    const prerequisiteIndex = index === 9 ? 4 : index === 6 || index === 15 ? index - 2 : null;
    const prerequisite =
      prerequisiteIndex === null
        ? null
        : {
            taskId: `task-${prerequisiteIndex.toString().padStart(2, '0')}`,
            title: titles[prerequisiteIndex]!,
            status: 'IN_PROGRESS' as const,
          };

    return {
      id: `task-${index.toString().padStart(2, '0')}`,
      title,
      description: `围绕“${title}”完成实现、验证与团队同步。所有正文均按纯文本展示。`,
      definitionOfDone: '相关测试通过；变更已评审；可从任务动态追溯结果。',
      status,
      actionLevel,
      actionReason:
        actionLevel === 'NOW'
          ? index < 3
            ? '已经逾期或距离截止不足 24 小时'
            : '阻塞更高行动等级的下游工作'
          : actionLevel === 'NEXT'
            ? '一周内到期'
            : '当前没有临近截止风险',
      importance,
      workstreamId: workstream.id,
      workstreamName: workstream.name,
      ownerId: owner?.id ?? null,
      ownerName: owner?.displayName ?? null,
      collaboratorIds: collaborator === null ? [] : [collaborator.id],
      collaboratorNames: collaborator === null ? [] : [collaborator.displayName],
      dueAt,
      manualBlock:
        index === 4 || index === 10 ? { type: 'decision', reason: '等待接口约定确认后继续' } : null,
      prerequisites: prerequisite === null ? [] : [prerequisite],
      incompletePrerequisites: prerequisite === null ? [] : [prerequisite],
      dependents:
        index === 4
          ? [
              { taskId: 'task-06', title: titles[6]!, status: 'IN_PROGRESS' },
              { taskId: 'task-09', title: titles[9]!, status: 'TODO' },
            ]
          : [],
      externalReferences:
        index === 3
          ? [
              {
                id: 'reference-1',
                type: 'document',
                label: '同步恢复设计记录',
                url: 'https://example.com/sync-notes',
              },
            ]
          : [],
      timeline: [
        {
          id: `event-${index}-created`,
          text: '创建任务',
          actorName: '团队成员',
          occurredAt: new Date(now.getTime() - (index + 2) * 60 * 60 * 1000).toISOString(),
        },
      ],
      version: 1,
      stableOrder: index,
      updatedAt: new Date(now.getTime() - index * 18 * 60 * 1000).toISOString(),
      archivedAt: terminal ? new Date(now.getTime() - index * 60 * 1000).toISOString() : null,
    };
  });
}
