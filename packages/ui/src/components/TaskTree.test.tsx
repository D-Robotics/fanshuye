import { fireEvent, render, screen, within } from '@testing-library/react';
import { makeTask } from '../test/fixtures';
import { TaskTree } from './TaskTree';

describe('TaskTree', () => {
  it('renders leaf semantics without avatars, initials, or resident people names', () => {
    const { container } = render(<TaskTree tasks={[makeTask()]} />);
    const leaf = screen.getByRole('button', { name: /修复登录超时问题/ });

    expect(leaf).toHaveAttribute('data-leaf-size', 'large');
    expect(container.querySelector('img')).not.toBeInTheDocument();
    expect(container.querySelector('[class*="avatar"]')).not.toBeInTheDocument();
    expect(container).not.toHaveTextContent('艾达');
    expect(container).not.toHaveTextContent('AD');
  });

  it('shows people as text only in the hover card', () => {
    render(<TaskTree tasks={[makeTask()]} />);
    fireEvent.mouseEnter(screen.getByRole('button', { name: /修复登录超时问题/ }));

    const card = screen.getByRole('tooltip');
    expect(card).toHaveTextContent('负责人');
    expect(card).toHaveTextContent('艾达');
    expect(card).toHaveTextContent('林工');
    expect(within(card).queryByRole('img')).not.toBeInTheDocument();
  });

  it('uses labels and symbols in addition to color for exceptional states', () => {
    render(
      <TaskTree
        tasks={[
          makeTask({
            ownerId: null,
            ownerName: null,
            manualBlock: { type: 'technical', reason: '等待协议确认' },
            incompletePrerequisites: [
              { taskId: 'pre-1', title: '统一接口协议', status: 'IN_PROGRESS' },
            ],
            dueAt: '2020-01-01T00:00:00.000Z',
          }),
        ]}
      />,
    );

    const leaf = screen.getByRole('button', {
      name: /无人认领，人工阻塞，依赖阻塞，已经逾期/,
    });
    expect(leaf).toHaveClass('fy-task-leaf--unassigned');
    expect(leaf).toHaveClass('fy-task-leaf--manual-blocked');
    expect(leaf).toHaveClass('fy-task-leaf--dependency-blocked');
    expect(leaf.querySelector('.fy-task-leaf__badge--blocked')).toBeInTheDocument();
    expect(leaf.querySelector('.fy-task-leaf__badge--overdue')).toBeInTheDocument();
  });

  it('aggregates excess leaves and opens the matching overflow list', () => {
    const tasks = Array.from({ length: 17 }, (_, index) =>
      makeTask({ id: `task-${index}`, title: `任务 ${index}`, stableOrder: index }),
    );
    const onClusterClick = vi.fn();
    render(<TaskTree tasks={tasks} maximumVisible={12} onClusterClick={onClusterClick} />);

    fireEvent.click(screen.getByRole('button', { name: '另有 5 个活跃任务，打开列表' }));
    expect(onClusterClick).toHaveBeenCalledOnce();
    expect(onClusterClick.mock.calls[0]?.[0]).toHaveLength(5);
  });

  it('draws direct dependency lines only for the selected task', () => {
    const prerequisite = makeTask({ id: 'pre', title: '前置任务', stableOrder: 1 });
    const selected = makeTask({
      id: 'selected',
      title: '后续任务',
      stableOrder: 2,
      prerequisites: [{ taskId: 'pre', title: '前置任务', status: 'DONE' }],
      incompletePrerequisites: [],
    });
    const { container, rerender } = render(<TaskTree tasks={[prerequisite, selected]} />);
    expect(container.querySelectorAll('.fy-task-tree__dependencies line')).toHaveLength(0);

    rerender(<TaskTree tasks={[prerequisite, selected]} selectedTaskId="selected" />);
    expect(container.querySelectorAll('.fy-task-tree__dependencies line')).toHaveLength(1);
  });

  it('does not expose hidden task titles in privacy mode labels', () => {
    render(<TaskTree tasks={[makeTask()]} privacyMode />);
    expect(screen.queryByText('修复登录超时问题')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^隐私任务/ })).toBeInTheDocument();
  });

  it('supports deterministic keyboard focus and activation for leaves and overflow', () => {
    const tasks = Array.from({ length: 3 }, (_, index) =>
      makeTask({ id: `keyboard-${index}`, title: `键盘任务 ${index}`, stableOrder: index }),
    );
    const onSelectTask = vi.fn();
    const onClusterClick = vi.fn();
    render(
      <TaskTree
        tasks={tasks}
        maximumVisible={2}
        onSelectTask={onSelectTask}
        onClusterClick={onClusterClick}
      />,
    );

    const leaves = screen.getAllByRole('button', { name: /键盘任务/ });
    expect(leaves.map((leaf) => leaf.getAttribute('tabindex'))).toEqual(['0', '0']);
    fireEvent.focus(leaves[0]!);
    expect(screen.getByRole('tooltip')).toHaveTextContent('键盘任务 0');
    fireEvent.keyDown(leaves[0]!, { key: 'Enter' });
    expect(onSelectTask).toHaveBeenCalledWith(expect.objectContaining({ id: 'keyboard-0' }));

    const cluster = screen.getByRole('button', { name: '另有 1 个活跃任务，打开列表' });
    fireEvent.keyDown(cluster, { key: ' ' });
    expect(onClusterClick).toHaveBeenCalledWith([expect.objectContaining({ id: 'keyboard-2' })]);
  });

  it('keeps non-color symbols, outlines and reduced-motion semantics for grayscale use', () => {
    const { container } = render(
      <TaskTree
        reducedMotion
        tasks={[
          makeTask({ id: 'unassigned', title: '无人任务', ownerId: null, ownerName: null }),
          makeTask({ id: 'progress', title: '进行任务', status: 'IN_PROGRESS' }),
          makeTask({ id: 'review', title: '评审任务', status: 'IN_REVIEW' }),
          makeTask({
            id: 'blocked',
            title: '阻塞任务',
            manualBlock: { type: 'technical', reason: '等待修复' },
          }),
        ]}
      />,
    );

    expect(container.querySelector('.fy-task-tree')).toHaveClass('fy-reduced-motion');
    expect(
      container.querySelector('[data-task-id="unassigned"] .fy-task-leaf__status'),
    ).toHaveTextContent('?');
    expect(
      container.querySelector('[data-task-id="progress"] .fy-task-leaf__status'),
    ).toHaveTextContent('▶');
    expect(
      container.querySelector('[data-task-id="review"] .fy-task-leaf__status'),
    ).toHaveTextContent('◇');
    expect(
      container.querySelector('[data-task-id="blocked"] .fy-task-leaf__badge--blocked'),
    ).toBeInTheDocument();
  });

  it('locks the deterministic SVG geometry and visual state-class contract', () => {
    const { container } = render(
      <TaskTree
        tasks={[
          makeTask({ id: 'visual-now', actionLevel: 'NOW', status: 'IN_PROGRESS', importance: 5 }),
          makeTask({ id: 'visual-next', actionLevel: 'NEXT', status: 'IN_REVIEW', importance: 3 }),
          makeTask({
            id: 'visual-later',
            actionLevel: 'LATER',
            status: 'TODO',
            importance: 1,
            ownerId: null,
            ownerName: null,
          }),
        ]}
      />,
    );

    const visualFingerprint = [...container.querySelectorAll<SVGGElement>('[data-task-id]')].map(
      (leaf) => ({
        id: leaf.dataset.taskId,
        size: leaf.dataset.leafSize,
        status: leaf.dataset.taskStatus,
        transform: leaf.getAttribute('transform'),
        classes: [...leaf.classList].sort(),
      }),
    );
    expect(visualFingerprint).toEqual([
      {
        id: 'visual-now',
        size: 'large',
        status: 'IN_PROGRESS',
        transform: 'translate(288 150.32) rotate(-32)',
        classes: ['fy-task-leaf', 'fy-task-leaf--in-progress', 'fy-task-leaf--large'],
      },
      {
        id: 'visual-next',
        size: 'medium',
        status: 'IN_REVIEW',
        transform: 'translate(288 315.12) rotate(-32)',
        classes: ['fy-task-leaf', 'fy-task-leaf--in-review', 'fy-task-leaf--medium'],
      },
      {
        id: 'visual-later',
        size: 'small',
        status: 'TODO',
        transform: 'translate(288 478.32) rotate(-32)',
        classes: [
          'fy-task-leaf',
          'fy-task-leaf--small',
          'fy-task-leaf--todo',
          'fy-task-leaf--unassigned',
        ],
      },
    ]);
  });
});
