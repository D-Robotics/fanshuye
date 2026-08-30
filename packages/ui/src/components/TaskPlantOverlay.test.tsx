import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { makeTask } from '../test/fixtures';
import {
  BINARY_TASK_LEAF_SLOTS,
  TASK_PLANT_CAPACITY,
  TaskPlantOverlay,
  defaultTaskPlantRelationshipScore,
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
    expect(BINARY_TASK_LEAF_SLOTS.filter((slot) => slot.pair === 3).map((slot) => slot.x)).toEqual([
      33, 55,
    ]);
  });

  it('sorts by importance first and uses the stable action order for ties', () => {
    const selection = selectTaskPlantTasks([
      makeTask({ id: 'low', importance: 1, actionLevel: 'NOW', stableOrder: 0 }),
      makeTask({ id: 'high-right', importance: 5, actionLevel: 'NEXT', stableOrder: 2 }),
      makeTask({ id: 'high-left', importance: 5, actionLevel: 'NOW', stableOrder: 1 }),
    ]);

    expect(selection.visible.map((task) => task.id)).toEqual(['high-left', 'high-right', 'low']);
  });

  it('groups direct dependencies before same-workstream tasks and keeps the left leaf higher ranked', () => {
    const direct = makeTask({ id: 'direct', importance: 1, workstreamId: 'other' });
    const related = makeTask({ id: 'related', importance: 4, workstreamId: 'platform' });
    const left = makeTask({
      id: 'left',
      importance: 5,
      workstreamId: 'platform',
      dependents: [{ taskId: 'direct', title: '直接依赖', status: 'TODO' }],
    });
    const selection = selectTaskPlantTasks([direct, related, left]);

    expect(defaultTaskPlantRelationshipScore(left, direct)).toBeGreaterThan(
      defaultTaskPlantRelationshipScore(left, related),
    );
    expect(selection.branches[0]?.left.id).toBe('left');
    expect(selection.branches[0]?.right?.id).toBe('direct');
    expect(selection.visible.map((task) => task.id)).toEqual(['left', 'direct', 'related']);
    expect(selection.branches[0]!.left.importance).toBeGreaterThan(
      selection.branches[0]!.right!.importance,
    );
  });

  it('keeps unrelated tasks as single leaves and accepts a replaceable relationship scorer', () => {
    const unrelated = Array.from({ length: 5 }, (_, index) =>
      makeTask({
        id: `solo-${index}`,
        importance: (5 - index) as 1 | 2 | 3 | 4 | 5,
        workstreamId: `stream-${index}`,
      }),
    );
    const singletonSelection = selectTaskPlantTasks(unrelated);

    expect(singletonSelection.branches).toHaveLength(4);
    expect(singletonSelection.branches.every((branch) => branch.right === null)).toBe(true);
    expect(singletonSelection.visible).toHaveLength(4);
    expect(singletonSelection.overflow.map((task) => task.id)).toEqual(['solo-4']);

    const agentReadySelection = selectTaskPlantTasks(unrelated, (left, candidate) =>
      left.id === 'solo-0' && candidate.id === 'solo-4' ? 42 : 0,
    );
    expect(agentReadySelection.branches[0]?.right?.id).toBe('solo-4');
  });

  it('fills the left node before the right node and limits the tree to eight leaves', () => {
    const selection = selectTaskPlantTasks(tasks);
    expect(TASK_PLANT_CAPACITY).toBe(8);
    expect(selection.visible).toHaveLength(8);
    expect(selection.overflow).toHaveLength(3);

    const { container } = render(
      <TaskPlantOverlay tasks={[tasks[0]!]} onSelectTask={vi.fn()} onCreateTask={vi.fn()} />,
    );
    const onlyLeaf = container.querySelector('[data-task-id]');
    expect(onlyLeaf).toHaveAttribute('data-pair', '0');
    expect(onlyLeaf).toHaveAttribute('data-side', 'left');
    expect(onlyLeaf).toHaveAttribute('data-outward-rank', '0');
  });

  it('renders the hand-drawn natural tree without avatars or an overflow badge', () => {
    const { container } = render(
      <TaskPlantOverlay tasks={tasks} onSelectTask={vi.fn()} onCreateTask={vi.fn()} />,
    );

    expect(screen.getByRole('region', { name: '常驻二叉任务树' })).toBeInTheDocument();
    expect(container.querySelectorAll('[data-task-id]')).toHaveLength(8);
    expect(container.querySelectorAll('.fy-task-plant__leaf-shape')).toHaveLength(8);
    expect(container.querySelector('.fy-task-plant__leaf-shape')).toHaveAttribute(
      'd',
      'M36 92 C24 76 15 58 19 41 C23 24 33 12 43 4 C46 21 55 37 52 53 C49 70 42 84 36 92Z',
    );
    expect(container.querySelector('img')).not.toBeInTheDocument();
    expect(container.querySelector('[class*="avatar"]')).not.toBeInTheDocument();
    expect(container.querySelector('[data-natural-stem="fluid-s-curve"]')).toHaveAttribute(
      'd',
      'M91 190 C99 176 98 165 93 154 C88 143 86 132 89 118 C91 108 95 99 93 90 C90 78 86 70 91 61 C92 57 94 54 96 52',
    );
    expect(container.querySelectorAll('.fy-task-plant__branch-outline')).toHaveLength(1);
    expect(container.querySelectorAll('.fy-task-plant__branch-fill')).toHaveLength(1);
    expect(container.querySelectorAll('[data-natural-branch]')).toHaveLength(4);
    expect(container.querySelector('.fy-task-plant__binary-nodes')).not.toBeInTheDocument();
    expect(
      [...container.querySelectorAll('[data-branch-segment], [data-child-side]')].every(
        (path) => path.getAttribute('d')?.includes('C') && !path.getAttribute('d')?.includes('L'),
      ),
    ).toBe(true);
    expect(container.querySelector('.fy-task-plant__crown-bud')).not.toBeInTheDocument();
    expect(container.querySelector('.fy-task-plant__root-fibers')).toBeInTheDocument();
    expect(container.querySelector('[data-root-shape="natural-tuber"]')).toHaveAttribute(
      'd',
      'M32 209 C29 198 36 185 49 178 C62 171 78 174 87 183 C95 191 92 202 82 209 C70 216 52 216 40 213 C35 212 32 211 32 209Z',
    );
    expect(container.innerHTML).not.toContain('M79 185 C65 184 59 194 65 204 C71 214 83 207');

    expect(container.querySelector('.fy-task-plant__overflow')).not.toBeInTheDocument();
    expect(screen.queryByText('+3')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /另有 .*活跃任务/ })).not.toBeInTheDocument();
  });

  it('can expose compact labels on the main task page while keeping the overlay tree clean', () => {
    const { container, rerender } = render(
      <TaskPlantOverlay tasks={tasks} onSelectTask={vi.fn()} onCreateTask={vi.fn()} />,
    );

    expect(container.querySelector('.fy-task-plant')).not.toHaveClass('fy-task-plant--labeled');
    rerender(
      <TaskPlantOverlay
        tasks={tasks}
        showTaskLabels
        onSelectTask={vi.fn()}
        onCreateTask={vi.fn()}
      />,
    );
    expect(container.querySelector('.fy-task-plant')).toHaveClass('fy-task-plant--labeled');
    expect(container.querySelectorAll('.fy-task-plant__leaf-rank')).toHaveLength(8);
    expect(container.querySelectorAll('.fy-task-plant__leaf-status')).toHaveLength(8);
  });

  it('grows a natural new-task bud that creates without selecting or dragging', () => {
    const onCreateTask = vi.fn();
    const onSelectTask = vi.fn();
    const onDragStart = vi.fn();
    const { container, rerender } = render(
      <TaskPlantOverlay
        tasks={tasks}
        onSelectTask={onSelectTask}
        onCreateTask={onCreateTask}
        onDragStart={onDragStart}
      />,
    );

    const bud = screen.getByRole('button', { name: '新增任务，让任务树长出新叶' });
    expect(bud).toHaveAttribute('data-new-task-bud');
    expect(container.querySelectorAll('[data-new-task-twig]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-task-id]')).toHaveLength(8);
    fireEvent.click(bud);
    expect(onCreateTask).toHaveBeenCalledOnce();
    expect(onSelectTask).not.toHaveBeenCalled();
    expect(onDragStart).not.toHaveBeenCalled();

    rerender(
      <TaskPlantOverlay
        tasks={tasks}
        createTaskDisabled
        onSelectTask={onSelectTask}
        onCreateTask={onCreateTask}
      />,
    );
    expect(screen.getByRole('button', { name: '新增任务，让任务树长出新叶' })).toBeDisabled();
  });

  it('draws a right twig only when a related right leaf exists', () => {
    const solo = makeTask({ id: 'solo', workstreamId: 'one' });
    const related = makeTask({ id: 'related', importance: 4, workstreamId: 'one' });
    const unrelated = makeTask({ id: 'unrelated', importance: 3, workstreamId: 'two' });
    const { container } = render(
      <TaskPlantOverlay
        tasks={[unrelated, related, solo]}
        onSelectTask={vi.fn()}
        onCreateTask={vi.fn()}
      />,
    );

    expect(
      container.querySelector('[data-natural-branch="0"] [data-child-side="right"]'),
    ).toBeInTheDocument();
    expect(
      container.querySelector('[data-natural-branch="1"] [data-child-side="right"]'),
    ).not.toBeInTheDocument();
    expect(container.querySelector('[data-task-id="unrelated"]')).toHaveAttribute(
      'data-side',
      'left',
    );
  });

  it('selects tasks only on click or keyboard activation and never on hover', async () => {
    const user = userEvent.setup();
    const onSelectTask = vi.fn();
    render(<TaskPlantOverlay tasks={tasks} onSelectTask={onSelectTask} onCreateTask={vi.fn()} />);
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

  it('starts native dragging from the trunk without selecting a task', () => {
    const onDragStart = vi.fn();
    const onSelectTask = vi.fn();
    render(
      <TaskPlantOverlay
        tasks={tasks}
        onSelectTask={onSelectTask}
        onCreateTask={vi.fn()}
        onDragStart={onDragStart}
      />,
    );

    const dragHandle = screen.getByRole('button', { name: '拖动悬浮窗' });
    expect(dragHandle).toHaveAttribute('data-tauri-drag-region');
    expect(dragHandle).toBeEmptyDOMElement();
    expect(screen.queryByText('按住主干移动')).not.toBeInTheDocument();
    fireEvent.pointerDown(dragHandle, { button: 0 });
    expect(onDragStart).toHaveBeenCalledOnce();
    expect(onSelectTask).not.toHaveBeenCalled();
  });

  it('removes the native drag hit area when the plant is embedded in the main task page', () => {
    render(
      <TaskPlantOverlay
        tasks={tasks}
        draggable={false}
        onSelectTask={vi.fn()}
        onCreateTask={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: '拖动悬浮窗' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '新增任务，让任务树长出新叶' })).toBeInTheDocument();
  });

  it('marks the selected task and draws its visible prerequisite and dependent on the tree', () => {
    const prerequisite = makeTask({
      id: 'before',
      title: '前置任务',
      importance: 5,
      dependents: [{ taskId: 'selected', title: '当前任务', status: 'IN_PROGRESS' }],
    });
    const selected = makeTask({
      id: 'selected',
      title: '当前任务',
      importance: 4,
      prerequisites: [{ taskId: 'before', title: '前置任务', status: 'IN_PROGRESS' }],
      dependents: [{ taskId: 'after', title: '后续任务', status: 'TODO' }],
    });
    const dependent = makeTask({
      id: 'after',
      title: '后续任务',
      importance: 3,
      prerequisites: [{ taskId: 'selected', title: '当前任务', status: 'IN_PROGRESS' }],
    });
    const { container } = render(
      <TaskPlantOverlay
        tasks={[dependent, selected, prerequisite]}
        selectedTaskId="selected"
        onSelectTask={vi.fn()}
        onCreateTask={vi.fn()}
      />,
    );

    expect(container.querySelector('[data-task-id="selected"]')).toHaveAttribute(
      'data-relation',
      'selected',
    );
    expect(container.querySelector('[data-task-id="before"]')).toHaveAttribute(
      'data-relation',
      'prerequisite',
    );
    expect(container.querySelector('[data-task-id="after"]')).toHaveAttribute(
      'data-relation',
      'dependent',
    );
    expect(container.querySelectorAll('.fy-task-plant__relation-line')).toHaveLength(2);
    expect(screen.getByText('前')).toBeInTheDocument();
    expect(screen.getByText('后')).toBeInTheDocument();
  });

  it('removes real titles and people from the collapsed DOM in privacy mode', () => {
    const privateTask = makeTask({ title: '机密发布计划', ownerName: '艾达', importance: 5 });
    const { container } = render(
      <TaskPlantOverlay
        tasks={[privateTask]}
        privacyMode
        onSelectTask={vi.fn()}
        onCreateTask={vi.fn()}
      />,
    );

    expect(container.innerHTML).not.toContain('机密发布计划');
    expect(container).not.toHaveTextContent('艾达');
    expect(screen.getByRole('button', { name: /隐私任务.*重要度 5/ })).toBeInTheDocument();
  });
});
