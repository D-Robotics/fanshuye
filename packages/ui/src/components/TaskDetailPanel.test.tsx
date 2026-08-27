import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { makeTask } from '../test/fixtures';
import { TaskDetailPanel } from './TaskDetailPanel';

describe('TaskDetailPanel security and accessibility boundaries', () => {
  it('renders user content as text and refuses scriptable external URLs', () => {
    const payload = '<img src=x onerror="globalThis.pwned=true"><script>alert(1)</script>';
    const { container } = render(
      <TaskDetailPanel
        online
        task={makeTask({
          title: payload,
          description: payload,
          definitionOfDone: payload,
          externalReferences: [
            {
              id: 'unsafe-reference',
              label: 'Unsafe reference',
              type: 'other',
              url: 'javascript:alert(1)',
            },
            {
              id: 'safe-reference',
              label: 'Safe reference',
              type: 'document',
              url: 'https://example.test/tasks/1',
            },
          ],
        })}
      />,
    );

    expect(screen.getByRole('heading', { name: payload })).toBeInTheDocument();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Unsafe reference' })).toBeNull();
    expect(screen.getByText('Unsafe reference（链接不可用）')).toBeInTheDocument();

    const safeLink = screen.getByRole('link', { name: 'Safe reference' });
    expect(safeLink).toHaveAttribute('href', 'https://example.test/tasks/1');
    expect(safeLink).toHaveAttribute('target', '_blank');
    expect(safeLink).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  it('exposes a labelled detail region and ordered native controls', () => {
    render(<TaskDetailPanel online task={makeTask()} onClose={() => undefined} />);

    expect(screen.getByRole('complementary', { name: '任务详情' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '关闭任务详情' })).toHaveAttribute('type', 'button');
    expect(screen.getByRole('group', { name: '任务操作' })).toBeInTheDocument();
  });

  it('offers ordinary non-participants self-join and a non-mutating takeover request', () => {
    const onCommand = vi.fn();
    render(
      <TaskDetailPanel
        online
        currentMemberId="member-chen"
        task={makeTask()}
        onCommand={onCommand}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '加入协作' }));
    fireEvent.click(screen.getByRole('button', { name: '请求接手' }));

    expect(onCommand).toHaveBeenNthCalledWith(1, {
      name: 'join',
      taskId: 'task-001',
      expectedVersion: 3,
    });
    expect(onCommand).toHaveBeenNthCalledWith(2, {
      name: 'request-transfer',
      taskId: 'task-001',
      expectedVersion: 3,
    });
  });

  it('does not offer joining to the owner or an existing collaborator', () => {
    const { rerender } = render(
      <TaskDetailPanel online currentMemberId="member-ada" task={makeTask()} />,
    );

    expect(screen.queryByRole('button', { name: '加入协作' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '请求接手' })).not.toBeInTheDocument();

    rerender(<TaskDetailPanel online currentMemberId="member-lin" task={makeTask()} />);
    expect(screen.queryByRole('button', { name: '加入协作' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '请求接手' })).toBeInTheDocument();
  });

  it('does not offer StartTask for a TODO task owned by somebody else', () => {
    render(
      <TaskDetailPanel online currentMemberId="member-chen" task={makeTask({ status: 'TODO' })} />,
    );

    expect(screen.queryByRole('button', { name: '开始处理' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '加入协作' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '请求接手' })).toBeInTheDocument();
  });

  it('shows every direct prerequisite while calling out only unfinished blockers', () => {
    const { container } = render(
      <TaskDetailPanel
        online
        task={makeTask({
          prerequisites: [
            { taskId: 'done', title: '已完成前置', status: 'DONE' },
            { taskId: 'active', title: '未完成前置', status: 'IN_PROGRESS' },
          ],
          incompletePrerequisites: [
            { taskId: 'active', title: '未完成前置', status: 'IN_PROGRESS' },
          ],
        })}
      />,
    );

    expect(screen.getByText('已完成前置 · 已完成')).toBeInTheDocument();
    expect(screen.getByText('未完成前置 · 进行中')).toBeInTheDocument();
    const blocker = container.querySelector('.fy-task-detail__section--blocked');
    expect(blocker).toHaveTextContent('未完成前置：未完成前置');
    expect(blocker).not.toHaveTextContent('已完成前置');
  });
});
