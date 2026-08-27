import { render, screen } from '@testing-library/react';
import { SyncStatusBanner } from './SyncStatusBanner';

describe('SyncStatusBanner', () => {
  it.each([
    ['offline', '离线只读'],
    ['reconnecting', '正在重连'],
    ['recovering', '正在恢复同步'],
    ['conflict', '需要处理冲突'],
  ] as const)('renders the %s state as a non-color alert', (status, label) => {
    render(
      <SyncStatusBanner
        state={{
          status,
          lastSyncedAt: '2030-01-02T03:04:00.000Z',
          message: '正在显示服务端确认的缓存',
        }}
      />,
    );

    const alert = screen.getByRole('alert');
    expect(alert).toHaveClass(`fy-sync-status--${status}`);
    expect(alert).toHaveTextContent(label);
    expect(alert).toHaveTextContent('最后同步');
    expect(alert).toHaveTextContent('正在显示服务端确认的缓存');
  });

  it('does not mislabel an online state as an alert', () => {
    render(<SyncStatusBanner state={{ status: 'online', lastSyncedAt: null }} />);
    expect(screen.getByRole('status')).toHaveTextContent('已同步');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
