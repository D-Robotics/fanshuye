import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { makeTask } from '../test/fixtures';
import { TaskForm } from './TaskForm';

describe('TaskForm', () => {
  it('shows deterministic title matches but still allows submission', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <TaskForm
        tasks={[makeTask({ title: '修复登录超时问题' })]}
        members={[]}
        online
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );

    await user.type(screen.getByLabelText('标题 *'), '修复登录超时');
    expect(screen.getByRole('region', { name: '潜在重复任务' })).toHaveTextContent(
      '修复登录超时问题',
    );
    await user.click(screen.getByRole('button', { name: '创建任务' }));
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it('blocks writes while offline', () => {
    render(
      <TaskForm tasks={[]} members={[]} online={false} onSubmit={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: '创建任务' })).toBeDisabled();
    expect(screen.getByText('离线只读：所有保存入口已禁用。')).toBeInTheDocument();
  });

  it('preserves direct prerequisites, rejects a client-detected cycle and displays server errors', async () => {
    const user = userEvent.setup();
    const existingPrerequisite = makeTask({ id: 'existing', title: '既有前置' });
    const cycleCandidate = makeTask({ id: 'cycle', title: '会成环的任务' });
    const edited = makeTask({
      id: 'edited',
      prerequisites: [{ taskId: 'existing', title: '既有前置', status: 'IN_PROGRESS' }],
      incompletePrerequisites: [{ taskId: 'existing', title: '既有前置', status: 'IN_PROGRESS' }],
    });
    const onSubmit = vi.fn();
    render(
      <TaskForm
        task={edited}
        tasks={[edited, existingPrerequisite, cycleCandidate]}
        members={[]}
        online
        submissionError="服务端拒绝：依赖会形成环"
        validateDependency={(candidateId) =>
          candidateId === cycleCandidate.id ? '这个依赖会形成直接或间接环，请调整方向。' : null
        }
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByRole('checkbox', { name: '既有前置' })).toBeChecked();
    expect(screen.getByRole('alert')).toHaveTextContent('服务端拒绝：依赖会形成环');
    await user.click(screen.getByRole('checkbox', { name: '会成环的任务' }));
    expect(screen.getByRole('alert')).toHaveTextContent('这个依赖会形成直接或间接环');
    expect(screen.getByRole('checkbox', { name: '会成环的任务' })).not.toBeChecked();

    await user.click(screen.getByRole('button', { name: '保存修改' }));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ prerequisiteTaskIds: ['existing'] }),
    );
  });
});
