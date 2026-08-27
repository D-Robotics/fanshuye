import { useState } from 'react';
import { hideCurrentWindow, quitApplication } from './platform/native';

export interface DesktopWindowControlsProps {
  placement?: 'login' | 'header';
}

export function DesktopWindowControls({ placement = 'login' }: DesktopWindowControlsProps) {
  const [error, setError] = useState<string | null>(null);

  const run = async (action: () => Promise<void>, failureMessage: string) => {
    setError(null);
    try {
      await action();
    } catch {
      setError(failureMessage);
    }
  };

  return (
    <div className={`fy-window-controls fy-window-controls--${placement}`} aria-label="窗口控制">
      <button
        type="button"
        title="隐藏窗口，可从系统托盘再次打开"
        onClick={() => void run(hideCurrentWindow, '暂时无法收起窗口，请使用系统托盘。')}
      >
        <span aria-hidden="true">—</span>
        收起到托盘
      </button>
      <button
        className="fy-window-controls__quit"
        type="button"
        title="完全退出番薯叶"
        onClick={() => void run(quitApplication, '暂时无法退出，请从系统托盘选择“退出番薯叶”。')}
      >
        <span aria-hidden="true">×</span>
        退出番薯叶
      </button>
      {error !== null && (
        <span className="fy-window-controls__error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
