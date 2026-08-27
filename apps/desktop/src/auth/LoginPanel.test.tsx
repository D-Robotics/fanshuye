import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LoginPanel } from './LoginPanel';

describe('LoginPanel', () => {
  it('normalizes the verified email, submits once, and erases the password afterward', async () => {
    const user = userEvent.setup();
    const onLogin = vi.fn(() => Promise.resolve());
    render(<LoginPanel onLogin={onLogin} />);

    await user.type(screen.getByLabelText('邮箱'), '  DEV@Example.COM ');
    await user.type(screen.getByLabelText('密码'), 'correct horse battery staple');
    await user.click(screen.getByRole('button', { name: '登录' }));

    await waitFor(() =>
      expect(onLogin).toHaveBeenCalledWith('dev@example.com', 'correct horse battery staple'),
    );
    expect(screen.getByLabelText('密码')).toHaveValue('');
  });

  it('renders only a safe authentication error and still clears the password', async () => {
    const secret = 'password-that-must-not-remain';
    const onLogin = vi.fn(() => Promise.reject(new Error('登录会话已失效，请重新登录。')));
    render(<LoginPanel onLogin={onLogin} />);

    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'dev@example.com' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: secret } });
    fireEvent.submit(screen.getByRole('button', { name: '登录' }).closest('form')!);

    expect(await screen.findByRole('alert')).toHaveTextContent('登录会话已失效，请重新登录。');
    expect(document.body).not.toHaveTextContent(secret);
    expect(screen.getByLabelText('密码')).toHaveValue('');
  });

  it('keeps explicit desktop window controls available before login', () => {
    render(
      <LoginPanel
        onLogin={() => Promise.resolve()}
        windowControls={
          <div aria-label="窗口控制">
            <button type="button">收起到托盘</button>
            <button type="button">退出番薯叶</button>
          </div>
        }
      />,
    );

    expect(screen.getByRole('button', { name: '收起到托盘' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '退出番薯叶' })).toBeInTheDocument();
  });
});
