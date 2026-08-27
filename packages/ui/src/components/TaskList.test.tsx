import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { makeTask } from '../test/fixtures';
import { TaskList } from './TaskList';

describe('TaskList', () => {
  it('filters to tasks owned or collaborated on by the current member', async () => {
    const user = userEvent.setup();
    render(
      <TaskList
        currentMemberId="me"
        tasks={[
          makeTask({ id: 'mine', title: '我的任务', ownerId: 'me', ownerName: '我' }),
          makeTask({
            id: 'collaboration',
            title: '协作任务',
            collaboratorIds: ['me'],
            collaboratorNames: ['我'],
          }),
          makeTask({ id: 'other', title: '其他任务', ownerId: 'other', ownerName: '其他人' }),
        ]}
      />,
    );

    await user.click(screen.getByRole('checkbox', { name: '只看我的任务' }));
    expect(screen.getByText('我的任务')).toBeInTheDocument();
    expect(screen.getByText('协作任务')).toBeInTheDocument();
    expect(screen.queryByText('其他任务')).not.toBeInTheDocument();
  });

  it('keeps terminal tasks out of the active list and exposes them in history', async () => {
    const user = userEvent.setup();
    render(
      <TaskList
        currentMemberId="me"
        tasks={[
          makeTask({ id: 'active', title: '活跃任务', status: 'IN_PROGRESS', archivedAt: null }),
          makeTask({
            id: 'completed',
            title: '已完成任务',
            status: 'DONE',
            archivedAt: '2030-01-02T00:00:00.000Z',
          }),
          makeTask({
            id: 'canceled',
            title: '已取消任务',
            status: 'CANCELED',
            archivedAt: '2030-01-03T00:00:00.000Z',
          }),
        ]}
      />,
    );

    expect(screen.getByText('活跃任务')).toBeInTheDocument();
    expect(screen.queryByText('已完成任务')).not.toBeInTheDocument();
    expect(screen.queryByText('已取消任务')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '历史' }));
    expect(screen.queryByText('活跃任务')).not.toBeInTheDocument();
    expect(screen.getByText('已完成任务')).toBeInTheDocument();
    expect(screen.getByText('已取消任务')).toBeInTheDocument();
  });

  it('clears sensitive filters and removes title and owner values as soon as privacy mode starts', async () => {
    const user = userEvent.setup();
    const secretTitle = '绝密任务标题';
    const secretOwner = '机密负责人';
    const task = makeTask({ title: secretTitle, ownerId: 'secret-owner', ownerName: secretOwner });
    const { container, rerender } = render(
      <TaskList tasks={[task]} currentMemberId="member-ada" />,
    );

    await user.type(screen.getByRole('searchbox'), secretTitle);
    await user.selectOptions(screen.getByRole('combobox', { name: '负责人' }), 'secret-owner');
    expect(screen.getByRole('searchbox')).toHaveValue(secretTitle);

    rerender(<TaskList tasks={[task]} currentMemberId="member-ada" privacyMode />);

    expect(screen.getByRole('searchbox')).toBeDisabled();
    expect(screen.getByRole('searchbox')).toHaveValue('');
    expect(screen.queryByRole('combobox', { name: '负责人' })).not.toBeInTheDocument();
    expect(container.innerHTML).not.toContain(secretTitle);
    expect(container.innerHTML).not.toContain(secretOwner);

    rerender(<TaskList tasks={[task]} currentMemberId="member-ada" />);
    expect(screen.getByRole('searchbox')).toHaveValue('');
    expect(screen.getByRole('combobox', { name: '负责人' })).toHaveValue('ALL');
  });
});
