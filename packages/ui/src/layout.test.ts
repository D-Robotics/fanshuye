import { buildTaskTreeLayout, selectVisibleTasks } from './layout';
import { makeTask } from './test/fixtures';

describe('task tree layout', () => {
  it('keeps deterministic slots for the same task facts', () => {
    const tasks = [
      makeTask({ id: 'b', stableOrder: 2 }),
      makeTask({ id: 'a', stableOrder: 1 }),
      makeTask({ id: 'c', actionLevel: 'NEXT', stableOrder: 1 }),
    ];

    const first = buildTaskTreeLayout(tasks);
    const second = buildTaskTreeLayout([...tasks].reverse());

    expect(first.leaves.map(({ task, x, y }) => ({ id: task.id, x, y }))).toEqual(
      second.leaves.map(({ task, x, y }) => ({ id: task.id, x, y })),
    );
  });

  it('prioritizes higher action levels and aggregates overflow', () => {
    const tasks = Array.from({ length: 18 }, (_, index) =>
      makeTask({
        id: `task-${index.toString().padStart(2, '0')}`,
        actionLevel: index < 3 ? 'NOW' : index < 9 ? 'NEXT' : 'LATER',
        stableOrder: index,
      }),
    );

    const result = selectVisibleTasks(tasks, 12);

    expect(result.visible).toHaveLength(12);
    expect(result.overflow).toHaveLength(6);
    expect(result.visible.slice(0, 3).every((task) => task.actionLevel === 'NOW')).toBe(true);
  });
});
