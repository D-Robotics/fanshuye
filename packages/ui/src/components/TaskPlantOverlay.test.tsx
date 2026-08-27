import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { makeTask } from '../test/fixtures';
import { TASK_PLANT_CAPACITY, TaskPlantOverlay, selectTaskPlantTasks } from './TaskPlantOverlay';

describe('TaskPlantOverlay', () => {
  const tasks = Array.from({ length: 8 }, (_, index) =>
    makeTask({ id: `plant-${index}`, title: `任务叶 ${index}`, stableOrder: index }),
  );

  it('selects five active tasks deterministically and reports overflow', () => {
    const selection = selectTaskPlantTasks(tasks);
    expect(TASK_PLANT_CAPACITY).toBe(5);
    expect(selection.visible.map((task) => task.id)).toEqual([
      'plant-0',
      'plant-1',
      'plant-2',
      'plant-3',
      'plant-4',
    ]);
    expect(selection.overflow).toHaveLength(3);
  });

  it('renders task titles on five leaves without avatars and opens overflow', () => {
    const onOpen = vi.fn();
    const { container } = render(
      <TaskPlantOverlay tasks={tasks} onOpen={onOpen} onSelectTask={vi.fn()} />,
    );

    expect(container.querySelectorAll('[data-task-id]')).toHaveLength(5);
    expect(screen.getByText('任务叶0')).toBeInTheDocument();
    expect(container.querySelector('img')).not.toBeInTheDocument();
    expect(container.querySelector('[class*="avatar"]')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '另有 3 个活跃任务，打开任务树' }));
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it('opens a selected task only after click or keyboard activation', async () => {
    const user = userEvent.setup();
    const onSelectTask = vi.fn();
    const onOpen = vi.fn();
    render(<TaskPlantOverlay tasks={tasks} onOpen={onOpen} onSelectTask={onSelectTask} />);
    const leaf = screen.getByRole('button', { name: /任务叶 0.*点击展开/ });

    fireEvent.mouseEnter(leaf);
    fireEvent.mouseLeave(leaf);
    expect(onSelectTask).not.toHaveBeenCalled();
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    fireEvent.click(leaf);
    expect(onSelectTask).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'plant-0' }));

    leaf.focus();
    await user.keyboard('{Enter}');
    expect(onSelectTask).toHaveBeenCalledTimes(2);
  });

  it('removes task titles and people from the collapsed DOM in privacy mode', () => {
    const privateTask = makeTask({ title: '机密发布计划', ownerName: '艾达' });
    const { container } = render(
      <TaskPlantOverlay
        tasks={[privateTask]}
        privacyMode
        onOpen={vi.fn()}
        onSelectTask={vi.fn()}
      />,
    );

    expect(container).not.toHaveTextContent('机密发布计划');
    expect(container.innerHTML).not.toContain('机密发布计划');
    expect(container).not.toHaveTextContent('艾达');
    expect(screen.getByRole('button', { name: /隐私任务/ })).toBeInTheDocument();
  });

  it('keeps the illustrated plant useful when there are no tasks', () => {
    render(<TaskPlantOverlay tasks={[]} onOpen={vi.fn()} onSelectTask={vi.fn()} />);
    expect(screen.getByText(/还没有任务叶/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '打开番薯叶任务树总览' })).toBeInTheDocument();
  });
});
