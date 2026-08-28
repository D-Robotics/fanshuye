import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { makeTask } from './test/fixtures';
import { App, buildDependencyMutations, resolveDemoMode, wouldCreateDependencyCycle } from './App';

describe('desktop app preferences', () => {
  it('allows native development to opt into the real local service', () => {
    expect(resolveDemoMode('auto', false, undefined, true)).toBe(true);
    expect(resolveDemoMode('auto', false, 'false', true)).toBe(false);
    expect(resolveDemoMode('auto', false, 'true', false)).toBe(true);
    expect(resolveDemoMode('demo', false, 'false', false)).toBe(true);
    expect(resolveDemoMode('production', true, 'true', true)).toBe(false);
  });

  it('connects the production shell to the safe login panel when restore is unavailable', async () => {
    render(<App runtimeMode="production" />);

    expect(await screen.findByRole('heading', { name: '登录番薯叶' })).toBeInTheDocument();
    expect(screen.getByLabelText('邮箱')).toBeInTheDocument();
    expect(screen.getByLabelText('密码')).toHaveAttribute('type', 'password');
  });

  it('detects direct and transitive dependency cycles before submission', () => {
    const tasks = [
      makeTask({ id: 'a', prerequisites: [] }),
      makeTask({
        id: 'b',
        prerequisites: [{ taskId: 'a', title: 'A', status: 'IN_PROGRESS' }],
      }),
      makeTask({
        id: 'c',
        prerequisites: [{ taskId: 'b', title: 'B', status: 'IN_PROGRESS' }],
      }),
      makeTask({ id: 'independent', prerequisites: [] }),
    ];

    expect(wouldCreateDependencyCycle(tasks, 'a', 'b')).toBe(true);
    expect(wouldCreateDependencyCycle(tasks, 'a', 'c')).toBe(true);
    expect(wouldCreateDependencyCycle(tasks, 'a', 'independent')).toBe(false);
  });

  it('removes obsolete dependencies before adding newly selected prerequisites', () => {
    expect(buildDependencyMutations(['keep', 'remove'], ['keep', 'add'])).toEqual([
      { type: 'RemoveDependency', prerequisiteTaskId: 'remove' },
      { type: 'AddDependency', prerequisiteTaskId: 'add' },
    ]);
  });

  it('switches to privacy mode without retaining task titles on the tree', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: '设置' }));
    await user.click(screen.getByRole('checkbox', { name: /隐私模式/ }));

    expect(screen.getAllByRole('button', { name: /^隐私任务/ }).length).toBeGreaterThan(0);
    expect(screen.queryByText('修复刷新令牌竞争条件')).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: '团队任务树' })).toBeInTheDocument();
  });

  it('clears list search and owner filters when privacy mode is enabled', async () => {
    const user = userEvent.setup();
    const secretTitle = '完成桌面端任务树键盘导航';
    const secretOwner = '林工';
    const { container } = render(<App />);

    await user.click(screen.getByRole('button', { name: '列表' }));
    await user.type(screen.getByRole('searchbox'), secretTitle);
    await user.selectOptions(screen.getByRole('combobox', { name: '负责人' }), 'member-lin');
    expect(screen.getByRole('searchbox')).toHaveValue(secretTitle);

    await user.click(screen.getByRole('button', { name: '设置' }));
    await user.click(screen.getByRole('checkbox', { name: /隐私模式/ }));

    expect(screen.getByRole('searchbox')).toBeDisabled();
    expect(screen.getByRole('searchbox')).toHaveValue('');
    expect(screen.queryByRole('combobox', { name: '负责人' })).not.toBeInTheDocument();
    expect(container.innerHTML).not.toContain(secretTitle);
    expect(container.innerHTML).not.toContain(secretOwner);
  });

  it('applies reduced motion to the whole desktop document', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<App />);

    await user.click(screen.getByRole('button', { name: '设置' }));
    await user.click(screen.getByRole('checkbox', { name: /减少动画/ }));

    expect(document.documentElement).toHaveAttribute('data-reduced-motion');
    expect(screen.getByRole('region', { name: '团队任务树' })).toHaveClass('fy-reduced-motion');
    unmount();
    expect(document.documentElement).not.toHaveAttribute('data-reduced-motion');
  });

  it('removes an open task form from the rendered document when privacy mode turns on', () => {
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: /修复刷新令牌竞争条件/ }));
    fireEvent.click(screen.getByRole('button', { name: '编辑详情' }));
    expect(screen.getByRole('form', { name: '编辑任务' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /隐私模式/ }));

    expect(screen.queryByRole('form', { name: '编辑任务' })).not.toBeInTheDocument();
    expect(screen.queryByText('修复刷新令牌竞争条件')).not.toBeInTheDocument();
  });

  it('marks the document hidden so CSS and runtime activity gates can pause', () => {
    let hidden = false;
    const hiddenState = vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    const { unmount } = render(<App />);

    hidden = true;
    fireEvent(document, new Event('visibilitychange'));
    expect(document.documentElement).toHaveAttribute('data-window-hidden');

    hidden = false;
    fireEvent(document, new Event('visibilitychange'));
    expect(document.documentElement).not.toHaveAttribute('data-window-hidden');

    unmount();
    hiddenState.mockRestore();
  });

  it('shows completion feedback once and moves the task from the tree into history', () => {
    vi.useFakeTimers();
    try {
      render(<App />);

      fireEvent.click(screen.getByRole('button', { name: /修复刷新令牌竞争条件/ }));
      fireEvent.click(screen.getByRole('button', { name: '认领并开始' }));
      fireEvent.click(screen.getByRole('button', { name: '直接完成' }));

      expect(screen.getByText('任务已完成并移入历史')).toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: /修复刷新令牌竞争条件/ }),
      ).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: '列表' }));
      fireEvent.click(screen.getByRole('button', { name: '历史' }));
      expect(screen.getByText('修复刷新令牌竞争条件')).toBeInTheDocument();

      act(() => vi.advanceTimersByTime(1_200));
      expect(screen.queryByText('任务已完成并移入历史')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets a member self-join and request takeover without replacing the owner', () => {
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: /完成桌面端任务树键盘导航/ }));
    fireEvent.click(screen.getByRole('button', { name: '加入协作' }));

    expect(screen.queryByRole('button', { name: '加入协作' })).not.toBeInTheDocument();
    expect(screen.getByText('已加入协作，负责人仍为林工')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '请求接手' }));
    expect(screen.getByText('接手请求已发送，负责人仍为林工')).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: '任务详情' })).toHaveTextContent('林工');
  });

  it('keeps the overlay collapsed on hover and opens only after a plant click', () => {
    window.history.pushState({}, '', '/?window=overlay');
    try {
      render(<App />);
      const plant = screen.getByRole('region', { name: '常驻二叉任务树' });
      fireEvent.mouseEnter(plant);
      fireEvent.mouseLeave(plant);

      expect(screen.queryByRole('button', { name: '收起 · Esc' })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: '打开番薯叶任务树总览' }));
      expect(screen.getByRole('button', { name: '收起 · Esc' })).toBeInTheDocument();
    } finally {
      window.history.pushState({}, '', '/');
    }
  });

  it('opens a collapsed task leaf directly in the matching detail panel', () => {
    window.history.pushState({}, '', '/?window=overlay');
    try {
      render(<App />);
      fireEvent.click(screen.getByRole('button', { name: /确认 Windows 150% DPI 表现.*点击展开/ }));

      expect(screen.getByRole('button', { name: '收起 · Esc' })).toBeInTheDocument();
      expect(screen.getByRole('complementary', { name: '任务详情' })).toHaveTextContent(
        '确认 Windows 150% DPI 表现',
      );
    } finally {
      window.history.pushState({}, '', '/');
    }
  });
});
