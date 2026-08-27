import { createHash } from 'node:crypto';
import { fireEvent, render, screen } from '@testing-library/react';
import { SyncStatusBanner } from './components/SyncStatusBanner';
import { TaskDetailPanel } from './components/TaskDetailPanel';
import { TaskList } from './components/TaskList';
import { TaskTree } from './components/TaskTree';
import { makeTask } from './test/fixtures';

function visualDigest(container: HTMLElement): string {
  const normalized = container.innerHTML
    .replaceAll(/fy-arrow-[\w-]+/g, 'fy-arrow-STABLE')
    .replaceAll(/最后同步 [^<]+/g, '最后同步 STABLE')
    .replaceAll(/\s+/g, ' ')
    .trim();
  return createHash('sha256').update(normalized).digest('hex');
}

describe('component visual contracts', () => {
  it('detects structural visual regressions across the MVP surfaces', () => {
    const task = makeTask({
      dueAt: null,
      prerequisites: [{ taskId: 'pre', title: '前置任务', status: 'IN_PROGRESS' }],
      incompletePrerequisites: [{ taskId: 'pre', title: '前置任务', status: 'IN_PROGRESS' }],
    });

    const tree = render(<TaskTree tasks={[task]} />);
    fireEvent.mouseEnter(screen.getByRole('button', { name: /修复登录超时问题/ }));
    const treeAndCard = visualDigest(tree.container);
    tree.unmount();

    const detail = render(<TaskDetailPanel online task={task} />);
    const detailPanel = visualDigest(detail.container);
    detail.unmount();

    const list = render(<TaskList tasks={[task]} currentMemberId="member-ada" />);
    const taskList = visualDigest(list.container);
    list.unmount();

    const privacy = render(<TaskTree tasks={[task]} privacyMode />);
    const privacyTree = visualDigest(privacy.container);
    privacy.unmount();

    const offline = render(
      <SyncStatusBanner
        state={{
          status: 'offline',
          lastSyncedAt: '2030-01-02T03:04:00.000Z',
          message: '正在显示最近一次确认的数据',
        }}
      />,
    );
    const offlineBanner = visualDigest(offline.container);

    expect({ treeAndCard, detailPanel, taskList, privacyTree, offlineBanner }).toEqual({
      treeAndCard: '358203a5ac60f309f89a09bf32ff1f2b3d0651773542a8c13e2f5df1e9077973',
      detailPanel: 'a55c3359208c3746a6a3daacb560c851156e06ee0e9ffeeaa2923d12ad9b052b',
      taskList: '67d3c8ea4551951cd75b5c62efb2ac53a8bd362878099a72196fe3d061430ed5',
      privacyTree: '7ee66cbcfee9b4b5f0d0110bba040a5f44706dda0e049b3c4a4cae02103b651a',
      offlineBanner: '8500689c20847adbd4122e6dc109dd6ad714b8115cca2017398b050348762993',
    });
  });
});
