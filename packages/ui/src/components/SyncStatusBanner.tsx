import type { SyncViewState } from '../types';

export interface SyncStatusBannerProps {
  state: SyncViewState;
}

const statusText: Record<SyncViewState['status'], string> = {
  online: '已同步',
  reconnecting: '正在重连',
  offline: '离线只读',
  recovering: '正在恢复同步',
  conflict: '需要处理冲突',
};

export function SyncStatusBanner({ state }: SyncStatusBannerProps) {
  const lastSynced =
    state.lastSyncedAt === null
      ? '尚无可用缓存'
      : `最后同步 ${new Intl.DateTimeFormat('zh-CN', {
          month: 'numeric',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        }).format(new Date(state.lastSyncedAt))}`;

  return (
    <div
      className={`fy-sync-status fy-sync-status--${state.status}`}
      role={state.status === 'online' ? 'status' : 'alert'}
      aria-live="polite"
    >
      <span className="fy-sync-status__symbol" aria-hidden="true" />
      <strong>{statusText[state.status]}</strong>
      {state.status !== 'online' && <span>{lastSynced}</span>}
      {state.message !== undefined && <span>{state.message}</span>}
    </div>
  );
}
