import { fireEvent, render, screen } from '@testing-library/react';
import { makeTask } from '../test/fixtures';
import { TaskQuickPreview } from './TaskQuickPreview';

describe('TaskQuickPreview', () => {
  it('shows compact read-only task facts and closes explicitly', () => {
    const onClose = vi.fn();
    render(<TaskQuickPreview task={makeTask()} onClose={onClose} />);

    const preview = screen.getByRole('complementary', { name: '任务速览' });
    expect(preview).toHaveTextContent('修复登录超时问题');
    expect(preview).toHaveTextContent('艾达');
    expect(preview).toHaveTextContent('重要度 4');
    expect(preview).toHaveTextContent('关系已标在树上');
    expect(preview.querySelector('input, textarea, select')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '关闭任务速览' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('does not expose private task content in privacy mode', () => {
    const task = makeTask({
      title: '机密发布计划',
      actionReason: '客户尚未公开',
      ownerName: '艾达',
    });
    const { container } = render(<TaskQuickPreview task={task} privacyMode onClose={vi.fn()} />);

    expect(container).toHaveTextContent('任务内容已隐藏');
    expect(container).not.toHaveTextContent('机密发布计划');
    expect(container).not.toHaveTextContent('客户尚未公开');
    expect(container).not.toHaveTextContent('艾达');
  });
});
