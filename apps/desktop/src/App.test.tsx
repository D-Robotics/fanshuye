import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import appStyles from './app.css?raw';
import { makeTask } from './test/fixtures';
import {
  App,
  buildDemoTaskFromCreatedPayload,
  buildDependencyMutations,
  parseDemoTaskCreatedPayload,
  resolveEffectivePrivacyMode,
  resolveDemoMode,
  wouldCreateDependencyCycle,
} from './App';

describe('desktop app preferences', () => {
  it('allows native development to opt into the real local service', () => {
    expect(resolveDemoMode('auto', false, undefined, true)).toBe(true);
    expect(resolveDemoMode('auto', false, 'false', true)).toBe(false);
    expect(resolveDemoMode('auto', false, 'true', false)).toBe(true);
    expect(resolveDemoMode('demo', false, 'false', false)).toBe(true);
    expect(resolveDemoMode('production', true, 'true', true)).toBe(false);
  });

  it('fails closed while native privacy preferences are still loading', () => {
    expect(resolveEffectivePrivacyMode(false, false)).toBe(true);
    expect(resolveEffectivePrivacyMode(false, true)).toBe(true);
    expect(resolveEffectivePrivacyMode(true, false)).toBe(false);
    expect(resolveEffectivePrivacyMode(true, true)).toBe(true);
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

  it('validates and reconstructs one demo task identically across native webviews', () => {
    const prerequisite = makeTask({ id: 'before', title: '前置任务', status: 'IN_PROGRESS' });
    const payload = parseDemoTaskCreatedPayload({
      taskId: 'new-task',
      timelineId: 'new-timeline',
      occurredAt: '2026-08-30T07:00:00.000Z',
      actorName: '艾达',
      draft: {
        title: '跨窗口新叶',
        description: '同步到隐藏悬浮窗',
        definitionOfDone: '重新显示时可见',
        importance: 5,
        dueAt: null,
        ownerId: 'member-ada',
        collaboratorIds: ['member-lin'],
        prerequisiteTaskIds: ['before'],
        workstreamId: 'desktop',
      },
    });

    expect(payload).not.toBeNull();
    expect(parseDemoTaskCreatedPayload({ taskId: 'partial' })).toBeNull();
    const task = buildDemoTaskFromCreatedPayload(
      payload!,
      [prerequisite],
      [
        { id: 'member-ada', displayName: '艾达' },
        { id: 'member-lin', displayName: '林工' },
      ],
    );
    expect(task).toMatchObject({
      id: 'new-task',
      title: '跨窗口新叶',
      ownerName: '艾达',
      collaboratorNames: ['林工'],
      prerequisites: [{ taskId: 'before', title: '前置任务', status: 'IN_PROGRESS' }],
    });
  });

  it('uses the compact natural plant on the main task page without zones or an overflow badge', () => {
    const { container } = render(<App />);

    expect(screen.getByRole('region', { name: '团队任务树' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '常驻二叉任务树' })).toBeInTheDocument();
    expect(container.querySelector('.fy-task-tree__zone')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /另有 .*活跃任务/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '拖动悬浮窗' })).not.toBeInTheDocument();
    expect(container.querySelector('.fy-task-plant')).toHaveClass('fy-task-plant--labeled');
  });

  it('turns the compact task form into a right drawer on narrow windows', () => {
    expect(appStyles).toMatch(
      /@media \(max-width: 720px\)[\s\S]*\.fy-modal-backdrop\s*\{[^}]*place-items:\s*stretch end/,
    );
    expect(appStyles).toMatch(
      /\.fy-modal-backdrop > \.fy-task-form\s*\{[^}]*height:\s*100%[^}]*max-height:\s*none[^}]*border-radius:\s*16px 0 0 16px/,
    );
  });

  it('treats the task form as a modal, closes it with Escape, and restores focus', () => {
    render(<App />);
    const trigger = screen.getByRole('button', { name: '+ 新任务' });

    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: '创建任务' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByLabelText('标题 *')).toHaveFocus();

    const submit = screen.getByRole('button', { name: '创建任务' });
    submit.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(screen.getByRole('button', { name: '关闭表单' })).toHaveFocus();

    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('form', { name: '创建任务' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('remounts task form fields when the edit target changes behind the modal', () => {
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: /确认 Windows 150% DPI 表现/ }));
    fireEvent.click(screen.getByRole('button', { name: '编辑详情' }));
    expect(screen.getByLabelText('标题 *')).toHaveValue('确认 Windows 150% DPI 表现');

    fireEvent.click(screen.getByRole('button', { name: /检查任务缓存隐私边界/ }));
    fireEvent.click(screen.getByRole('button', { name: '编辑详情' }));
    expect(screen.getByLabelText('标题 *')).toHaveValue('检查任务缓存隐私边界');
  });

  it('opens a small task preview first and expands full details only on request', () => {
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: /确认 Windows 150% DPI 表现/ }));
    expect(screen.getByRole('complementary', { name: '任务速览' })).toBeInTheDocument();
    expect(screen.queryByRole('complementary', { name: '任务详情' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '完整详情' }));
    expect(screen.getByRole('complementary', { name: '任务详情' })).toBeInTheDocument();
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

    fireEvent.click(screen.getByRole('button', { name: /确认 Windows 150% DPI 表现/ }));
    fireEvent.click(screen.getByRole('button', { name: '编辑详情' }));
    expect(screen.getByRole('form', { name: '编辑任务' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /隐私模式/ }));

    expect(screen.queryByRole('form', { name: '编辑任务' })).not.toBeInTheDocument();
    expect(screen.queryByText('确认 Windows 150% DPI 表现')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: /隐私模式/ }));
    expect(screen.queryByRole('form', { name: '编辑任务' })).not.toBeInTheDocument();
  });

  it('keeps expanded details read-only throughout privacy mode', () => {
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: /确认 Windows 150% DPI 表现/ }));
    fireEvent.click(screen.getByRole('button', { name: '完整详情' }));
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /隐私模式/ }));

    expect(screen.queryByRole('button', { name: '编辑详情' })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: '任务操作' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: /隐私模式/ }));
    expect(screen.queryByRole('form', { name: '编辑任务' })).not.toBeInTheDocument();
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

      fireEvent.click(screen.getByRole('button', { name: /调整悬浮窗移出延迟/ }));
      fireEvent.click(screen.getByRole('button', { name: '完整详情' }));
      fireEvent.click(screen.getByRole('button', { name: '开始处理' }));
      fireEvent.click(screen.getByRole('button', { name: '直接完成' }));

      expect(screen.getByText('任务已完成并移入历史')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /调整悬浮窗移出延迟/ })).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: '列表' }));
      fireEvent.click(screen.getByRole('button', { name: '历史' }));
      expect(screen.getByText('调整悬浮窗移出延迟')).toBeInTheDocument();

      act(() => vi.advanceTimersByTime(1_200));
      expect(screen.queryByText('任务已完成并移入历史')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets a member self-join and request takeover without replacing the owner', () => {
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: /检查任务缓存隐私边界/ }));
    fireEvent.click(screen.getByRole('button', { name: '完整详情' }));
    fireEvent.click(screen.getByRole('button', { name: '加入协作' }));

    expect(screen.queryByRole('button', { name: '加入协作' })).not.toBeInTheDocument();
    expect(screen.getByText('已加入协作，负责人仍为林工')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '请求接手' }));
    expect(screen.getByText('接手请求已发送，负责人仍为林工')).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: '任务详情' })).toHaveTextContent('林工');
  });

  it('keeps the overlay collapsed on hover or tree-background clicks and opens on a leaf', () => {
    window.history.pushState({}, '', '/?window=overlay');
    try {
      render(<App />);
      const plant = screen.getByRole('region', { name: '常驻二叉任务树' });
      fireEvent.mouseEnter(plant);
      fireEvent.mouseLeave(plant);

      expect(screen.queryByRole('complementary', { name: '任务速览' })).not.toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: '打开番薯叶任务树总览' }),
      ).not.toBeInTheDocument();
      fireEvent.click(plant);
      expect(screen.queryByRole('complementary', { name: '任务速览' })).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: /确认 Windows 150% DPI 表现.*点击展开/ }));
      expect(screen.getByRole('complementary', { name: '任务速览' })).toBeInTheDocument();
    } finally {
      window.history.pushState({}, '', '/');
    }
  });

  it('opens the create form from the new leaf bud and grows the submitted task into the tree', async () => {
    window.history.pushState({}, '', '/?window=overlay');
    try {
      render(<App />);

      fireEvent.click(screen.getByRole('button', { name: '新增任务，让任务树长出新叶' }));
      expect(screen.getByRole('form', { name: '创建任务' })).toBeInTheDocument();
      expect(screen.getByLabelText('标题 *')).toHaveFocus();

      fireEvent.change(screen.getByLabelText('标题 *'), {
        target: { value: '实现叶芽新增任务' },
      });
      fireEvent.change(screen.getByLabelText('重要度'), { target: { value: '5' } });
      fireEvent.click(screen.getByRole('button', { name: '创建任务' }));
      expect(screen.queryByRole('form', { name: '创建任务' })).not.toBeInTheDocument();

      fireEvent.keyDown(window, { key: 'Escape' });
      expect(
        await screen.findByRole('button', { name: /实现叶芽新增任务.*点击展开/ }),
      ).toBeInTheDocument();
    } finally {
      window.history.pushState({}, '', '/');
    }
  });

  it('explains when a default-importance task is created below the visible leaf ranking', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '+ 新任务' }));
    fireEvent.change(screen.getByLabelText('标题 *'), {
      target: { value: '默认重要度任务' },
    });
    fireEvent.click(screen.getByRole('button', { name: '创建任务' }));

    expect(screen.getByText('任务已创建，但当前重要度未进入悬浮树可见叶位。')).toBeInTheDocument();
  });

  it('opens and switches a compact task preview while keeping relationships on the tree', () => {
    window.history.pushState({}, '', '/?window=overlay');
    try {
      render(<App />);
      fireEvent.click(screen.getByRole('button', { name: /确认 Windows 150% DPI 表现.*点击展开/ }));

      expect(screen.queryByRole('button', { name: '收起 · Esc' })).not.toBeInTheDocument();
      expect(screen.getByRole('complementary', { name: '任务速览' })).toHaveTextContent(
        '确认 Windows 150% DPI 表现',
      );
      expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
      expect(screen.getByText('后')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: /检查任务缓存隐私边界.*点击展开/ }));
      expect(screen.getByRole('complementary', { name: '任务速览' })).toHaveTextContent(
        '检查任务缓存隐私边界',
      );
      expect(screen.getByText('前')).toBeInTheDocument();

      fireEvent.keyDown(window, { key: 'Escape' });
      expect(screen.queryByRole('complementary', { name: '任务速览' })).not.toBeInTheDocument();
      expect(screen.getByRole('region', { name: '常驻二叉任务树' })).toBeInTheDocument();
    } finally {
      window.history.pushState({}, '', '/');
    }
  });
});
