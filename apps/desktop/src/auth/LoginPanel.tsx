import { useState, type FormEvent } from 'react';
import type { ReactNode } from 'react';

export interface LoginPanelProps {
  onLogin: (email: string, password: string) => Promise<void>;
  notice?: string | null;
  windowControls?: ReactNode;
}

export function LoginPanel({ onLogin, notice = null, windowControls = null }: LoginPanelProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const normalizedEmail = email.trim().toLocaleLowerCase('en-US');
    if (normalizedEmail.length === 0 || password.length === 0) {
      setError('请输入已验证邮箱和密码。');
      return;
    }

    setPending(true);
    setError(null);
    try {
      await onLogin(normalizedEmail, password);
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : '登录暂时不可用，请稍后重试。');
    } finally {
      // A password must not remain in React state after an authentication attempt.
      setPassword('');
      setPending(false);
    }
  };

  return (
    <main className="fy-login-shell">
      {windowControls}
      <section className="fy-login-panel" aria-labelledby="fanshuye-login-title">
        <div className="fy-login-panel__mark" aria-hidden="true">
          叶
        </div>
        <span className="fy-eyebrow">开发团队任务态势</span>
        <h1 id="fanshuye-login-title">登录番薯叶</h1>
        <p>使用团队中已经验证的邮箱。刷新凭据只会交给 Windows 安全凭据存储。</p>
        {notice !== null && (
          <div className="fy-inline-alert" role="status">
            {notice}
          </div>
        )}

        <form onSubmit={(event) => void submit(event)} autoComplete="off">
          <label>
            <span>邮箱</span>
            <input
              type="email"
              inputMode="email"
              autoCapitalize="none"
              autoCorrect="off"
              autoComplete="off"
              value={email}
              disabled={pending}
              maxLength={320}
              required
              onChange={(event) => setEmail(event.currentTarget.value)}
            />
          </label>
          <label>
            <span>密码</span>
            <input
              type="password"
              autoComplete="off"
              value={password}
              disabled={pending}
              maxLength={1_024}
              required
              onChange={(event) => setPassword(event.currentTarget.value)}
            />
          </label>
          {error !== null && (
            <div className="fy-inline-alert fy-inline-alert--danger" role="alert">
              {error}
            </div>
          )}
          <button className="fy-button fy-button--primary" type="submit" disabled={pending}>
            {pending ? '正在建立安全会话…' : '登录'}
          </button>
        </form>
      </section>
    </main>
  );
}
