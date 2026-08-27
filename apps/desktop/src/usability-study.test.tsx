import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { selectVisibleTasks } from '@fanshuye/ui';
import { UsabilityStudyHarness } from './UsabilityStudyHarness';
import {
  USABILITY_STUDY_DATASET_ID,
  USABILITY_STUDY_MAXIMUM_VISIBLE,
  USABILITY_STUDY_TARGETS,
  createUsabilityStudyTasks,
  validateUsabilityStudyDataset,
} from './usability-study-data';

describe('30-task developer usability study prerequisites', () => {
  it('locks a deterministic dataset with all study targets directly visible', () => {
    const first = createUsabilityStudyTasks();
    const second = createUsabilityStudyTasks();
    const layout = selectVisibleTasks(first, USABILITY_STUDY_MAXIMUM_VISIBLE);
    const visibleIds = new Set(layout.visible.map((task) => task.id));

    expect(second).toEqual(first);
    expect(validateUsabilityStudyDataset(first)).toEqual([]);
    expect(first).toHaveLength(30);
    expect(layout.visible).toHaveLength(15);
    expect(layout.overflow).toHaveLength(11);
    expect(Object.values(USABILITY_STUDY_TARGETS).every((taskId) => visibleIds.has(taskId))).toBe(
      true,
    );
  });

  it('records four independent first-attempt trials without claiming human verification', () => {
    let clock = 1_000;
    render(<UsabilityStudyHarness now={() => clock} />);

    expect(screen.getByText('30 任务开发者速览测试')).toBeInTheDocument();
    expect(screen.getByText('通过')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: '参与者代码' }), {
      target: { value: 'DEV-TEST' },
    });
    expect(
      screen.queryByRole('button', { name: /完成桌面端任务树键盘导航/ }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /开始计时：最高行动等级/ }));
    clock = 1_250;
    fireEvent.click(screen.getByRole('button', { name: /完成桌面端任务树键盘导航/ }));
    expect(screen.getByText('测试画布已遮挡')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /开始计时：无人认领任务/ }));
    clock = 1_750;
    fireEvent.click(screen.getByRole('button', { name: /收敛任务命令错误码/ }));

    fireEvent.click(screen.getByRole('button', { name: /开始计时：阻塞任务/ }));
    clock = 2_300;
    fireEvent.click(screen.getByRole('button', { name: /确认 Windows 150% DPI 表现/ }));

    fireEvent.click(screen.getByRole('button', { name: /开始计时：Hover 查看负责人/ }));
    clock = 3_100;
    fireEvent.mouseEnter(screen.getByRole('button', { name: /完成桌面端任务树键盘导航/ }));
    expect(screen.getByRole('tooltip')).toHaveTextContent('负责人林工');
    fireEvent.change(screen.getByRole('textbox', { name: '卡片中的负责人' }), {
      target: { value: '林工' },
    });
    clock = 3_250;
    fireEvent.click(screen.getByRole('button', { name: '提交负责人' }));

    expect(screen.getByText('4 / 4 项在 5 秒内完成')).toBeInTheDocument();
    const table = screen.getByRole('table');
    expect(within(table).getAllByText('pass')).toHaveLength(4);
    expect(within(table).getByText('250 ms')).toBeInTheDocument();
    expect(within(table).getByText('500 ms')).toBeInTheDocument();
    expect(within(table).getByText('550 ms')).toBeInTheDocument();
    expect(within(table).getByText('950 ms')).toBeInTheDocument();

    const raw = screen.getByRole('textbox', { name: /原始结果 JSON/ });
    const evidence = JSON.parse((raw as HTMLTextAreaElement).value) as Record<string, unknown>;
    expect(evidence).toMatchObject({
      datasetId: USABILITY_STUDY_DATASET_ID,
      participantCode: 'DEV-TEST',
      totalTasks: 30,
      strictPass: true,
      evidenceStatus: 'OBSERVER_ATTESTATION_REQUIRED',
    });
  });

  it('enforces the five-second ceiling rather than accepting a late answer', () => {
    vi.useFakeTimers();
    try {
      let clock = 0;
      render(<UsabilityStudyHarness now={() => clock} />);
      fireEvent.change(screen.getByRole('textbox', { name: '参与者代码' }), {
        target: { value: 'DEV-TIMEOUT' },
      });
      fireEvent.click(screen.getByRole('button', { name: /开始计时：最高行动等级/ }));
      clock = 5_001;
      act(() => vi.advanceTimersByTime(50));

      const results = screen.getByRole('table');
      expect(within(results).getByText('timeout')).toBeInTheDocument();
      expect(within(results).getByText('5000 ms')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /开始计时：无人认领任务/ })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
