import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { makeTask } from '../test/fixtures';
import {
  BINARY_TASK_LEAF_SLOTS,
  TASK_PLANT_CAPACITY,
  TaskPlantOverlay,
  selectTaskPlantTasks,
} from './TaskPlantOverlay';

describe('TaskPlantOverlay', () => {
  const tasks = Array.from({ length: 11 }, (_, index) =>
    makeTask({
      id: `plant-${index}`,
      title: `任务叶${index}`,
      importance: Math.max(1, 5 - Math.floor(index / 2)) as 1 | 2 | 3 | 4 | 5,
      stableOrder: index,
    }),
  );

  it('defines four outward-ranked binary pairs with left before right', () => {
    expect(BINARY_TASK_LEAF_SLOTS).toHaveLength(8);
    for (let pair = 0; pair < 4; pair += 1) {
      const pairSlots = BINARY_TASK_LEAF_SLOTS.filter((slot) => slot.pair === pair);
      expect(pairSlots.map((slot) => slot.side)).toEqual(['left', 'right']);
      expect(pairSlots[0]?.outwardRank).toBe(pair);
      expect(pairSlots[1]?.outwardRank).toBe(pair);
    }
  });

  it('sorts by importance first and uses the stable action order for ties', () => {
    const selection = selectTaskPlantTasks([
      makeTask({ id: 'low', importance: 1, actionLevel: 'NOW', stableOrder: 0 }),
      makeTask({ id: 'high-right', importance: 5, actionLevel: 'NEXT', stableOrder: 2 }),
      makeTask({ id: 'high-left', importance: 5, actionLevel: 'NOW', stableOrder: 1 }),
    ]);

    expect(selection.visible.map((task) => task.id)).toEqual(['high-left', 'high-right', 'low']);
  });

  it('fills the left node before the right node and limits the tree to eight leaves', () => {
    const selection = selectTaskPlantTasks(tasks);
    expect(TASK_PLANT_CAPACITY).toBe(8);
    expect(selection.visible).toHaveLength(8);
    expect(selection.overflow).toHaveLength(3);

    const { container } = render(
      <TaskPlantOverlay tasks={[tasks[0]!]} onOpen={vi.fn()} onSelectTask={vi.fn()} />,
    );
    const onlyLeaf = container.querySelector('[data-task-id]');
    expect(onlyLeaf).toHaveAttribute('data-pair', '0');
    expect(onlyLeaf).toHaveAttribute('data-side', 'left');
    expect(onlyLeaf).toHaveAttribute('data-outward-rank', '0');
  });

  it('reuses the broad sweet-potato leaf silhouette without avatars and opens overflow', () => {
    const onOpen = vi.fn();
    const { container } = render(
      <TaskPlantOverlay tasks={tasks} onOpen={onOpen} onSelectTask={vi.fn()} />,
    );

    expect(screen.getByRole('region', { name: '常驻二叉任务树' })).toBeInTheDocument();
    expect(container.querySelectorAll('[data-task-id]')).toHaveLength(8);
    expect(container.querySelectorAll('.fy-task-plant__leaf-shape')).toHaveLength(8);
    expect(container.querySelector('.fy-task-plant__leaf-shape')).toHaveAttribute(
      'd',
      'M50 79 C42 63 7 60 5 29 C3 7 28 0 49 22 C69 0 96 7 95 30 C94 59 60 65 50 79Z',
    );
    expect(container.querySelector('img')).not.toBeInTheDocument();
    expect(container.querySelector('[class*="avatar"]')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '另有 3 个活跃任务，打开任务树' }));
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it('selects tasks only on click or keyboard activation and never on hover', async () => {
    const user = userEvent.setup();
    const onSelectTask = vi.fn();
    render(<TaskPlantOverlay tasks={tasks} onOpen={vi.fn()} onSelectTask={onSelectTask} />);
    const leaf = screen.getByRole('button', { name: /任务叶0.*第 1 对左叶.*点击展开/ });

    fireEvent.mouseEnter(leaf);
    fireEvent.mouseLeave(leaf);
    expect(onSelectTask).not.toHaveBeenCalled();
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    fireEvent.click(leaf);
    leaf.focus();
    await user.keyboard('{Enter}');
    expect(onSelectTask).toHaveBeenCalledTimes(2);
  });

  it('starts native dragging from the trunk without opening or selecting a task', () => {
    const onDragStart = vi.fn();
    const onOpen = vi.fn();
    const onSelectTask = vi.fn();
    render(
      <TaskPlantOverlay
        tasks={tasks}
        onOpen={onOpen}
        onSelectTask={onSelectTask}
        onDragStart={onDragStart}
      />,
    );

    const dragHandle = screen.getByRole('button', { name: '拖动悬浮窗' });
    expect(dragHandle).toHaveAttribute('data-tauri-drag-region');
    fireEvent.pointerDown(dragHandle, { button: 0 });
    expect(onDragStart).toHaveBeenCalledOnce();
    expect(onOpen).not.toHaveBeenCalled();
    expect(onSelectTask).not.toHaveBeenCalled();
  });

  it('removes real titles and people from the collapsed DOM in privacy mode', () => {
    const privateTask = makeTask({ title: '机密发布计划', ownerName: '艾达', importance: 5 });
    const { container } = render(
      <TaskPlantOverlay
        tasks={[privateTask]}
        privacyMode
        onOpen={vi.fn()}
        onSelectTask={vi.fn()}
      />,
    );

    expect(container.innerHTML).not.toContain('机密发布计划');
    expect(container).not.toHaveTextContent('艾达');
    expect(screen.getByRole('button', { name: /隐私任务.*重要度 5/ })).toBeInTheDocument();
  });
});
