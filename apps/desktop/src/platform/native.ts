import type { OverlayMode } from '../overlay-machine';

export const NATIVE_OVERLAY_STATE_EVENT = 'desktop-overlay-state-changed';
export const NATIVE_WINDOW_VISIBILITY_EVENT = 'desktop-window-visibility-changed';
export const NATIVE_AUTH_STATE_EVENT = 'desktop-auth-state-changed';

export type NativeAuthState = 'authenticated' | 'cleared';

export interface NativeAuthStateChange {
  state: NativeAuthState;
  sourceLabel: string;
}

export interface NativeOverlayState {
  mode: OverlayMode;
  visible: boolean;
}

export interface NativeWindowVisibility {
  label: string;
  visible: boolean;
}

export interface NativeMonitorInfo {
  key: string;
  label: string;
  primary: boolean;
}

export interface GlobalShortcutStatus {
  activeShortcut: string | null;
  usingFallback: boolean;
  issue: string | null;
}

export interface DesktopPreferencePatchValues {
  privacyMode: boolean;
  reducedMotion: boolean;
  doNotDisturb: boolean;
  preferredMonitor: string | null;
  selectedWorkspaceId: string | null;
  edge: 'left' | 'right';
}

export interface DesktopPreferences {
  privacyMode: boolean;
  reducedMotion: boolean;
  doNotDisturb: boolean;
  autostart: boolean;
  preferredMonitor: string | null;
  selectedWorkspaceId: string | null;
  edge: 'left' | 'right';
}

export function parseDesktopPreferences(value: unknown): DesktopPreferences | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.privacyMode !== 'boolean' ||
    typeof candidate.reducedMotion !== 'boolean' ||
    typeof candidate.doNotDisturb !== 'boolean' ||
    typeof candidate.autostart !== 'boolean' ||
    (candidate.preferredMonitor !== null && typeof candidate.preferredMonitor !== 'string') ||
    (candidate.selectedWorkspaceId !== null && typeof candidate.selectedWorkspaceId !== 'string') ||
    (candidate.edge !== 'left' && candidate.edge !== 'right')
  ) {
    return null;
  }
  return {
    privacyMode: candidate.privacyMode,
    reducedMotion: candidate.reducedMotion,
    doNotDisturb: candidate.doNotDisturb,
    autostart: candidate.autostart,
    preferredMonitor: candidate.preferredMonitor,
    selectedWorkspaceId: candidate.selectedWorkspaceId,
    edge: candidate.edge,
  };
}

export function desktopPreferencesEqual(
  left: DesktopPreferences,
  right: DesktopPreferences,
): boolean {
  return (
    left.privacyMode === right.privacyMode &&
    left.reducedMotion === right.reducedMotion &&
    left.doNotDisturb === right.doNotDisturb &&
    left.autostart === right.autostart &&
    left.preferredMonitor === right.preferredMonitor &&
    left.selectedWorkspaceId === right.selectedWorkspaceId &&
    left.edge === right.edge
  );
}

export function parseGlobalShortcutStatus(value: unknown): GlobalShortcutStatus | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (
    (candidate.activeShortcut !== null && typeof candidate.activeShortcut !== 'string') ||
    typeof candidate.usingFallback !== 'boolean' ||
    (candidate.issue !== null && typeof candidate.issue !== 'string')
  ) {
    return null;
  }
  return {
    activeShortcut: candidate.activeShortcut,
    usingFallback: candidate.usingFallback,
    issue: candidate.issue,
  };
}

export function hasNativeDesktopRuntime(): boolean {
  return window.__TAURI_INTERNALS__ !== undefined;
}

function isOverlayWebview(): boolean {
  return new URLSearchParams(window.location.search).get('window') === 'overlay';
}

async function invokeNative<T>(command: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!hasNativeDesktopRuntime()) return null;
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(command, args);
}

async function invokeRequiredNative<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (!hasNativeDesktopRuntime()) throw new Error('原生安全能力不可用');
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(command, args);
}

export async function setNativeOverlayMode(mode: OverlayMode): Promise<void> {
  // Both webviews render the same React application. Only the overlay owns
  // native overlay geometry; the main window must never resize it on mount.
  if (!isOverlayWebview()) return;
  await invokeNative('set_overlay_mode', { mode });
}

export async function startNativeOverlayDrag(): Promise<void> {
  if (!isOverlayWebview()) return;
  await invokeNative('start_overlay_drag');
}

export function parseNativeOverlayState(value: unknown): NativeOverlayState | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (
    (candidate.mode !== 'collapsed' &&
      candidate.mode !== 'preview' &&
      candidate.mode !== 'pinned') ||
    typeof candidate.visible !== 'boolean'
  ) {
    return null;
  }
  return { mode: candidate.mode, visible: candidate.visible };
}

export function parseNativeWindowVisibility(value: unknown): NativeWindowVisibility | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.label !== 'string' || typeof candidate.visible !== 'boolean') return null;
  return { label: candidate.label, visible: candidate.visible };
}

export function parseNativeAuthState(value: unknown): NativeAuthStateChange | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).length !== 2 ||
    (candidate.state !== 'authenticated' && candidate.state !== 'cleared') ||
    typeof candidate.sourceLabel !== 'string' ||
    candidate.sourceLabel.trim() === '' ||
    candidate.sourceLabel.length > 64 ||
    [...candidate.sourceLabel].some((character) => /\p{Cc}/u.test(character))
  ) {
    return null;
  }
  return { state: candidate.state, sourceLabel: candidate.sourceLabel };
}

export function parseNativeMonitorList(value: unknown): NativeMonitorInfo[] | null {
  if (!Array.isArray(value)) return null;
  const monitors: NativeMonitorInfo[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) return null;
    const candidate = item as Record<string, unknown>;
    if (
      typeof candidate.key !== 'string' ||
      candidate.key.trim() === '' ||
      typeof candidate.label !== 'string' ||
      candidate.label.trim() === '' ||
      typeof candidate.primary !== 'boolean'
    ) {
      return null;
    }
    monitors.push({
      key: candidate.key,
      label: candidate.label,
      primary: candidate.primary,
    });
  }
  return monitors;
}

export async function getNativeOverlayState(): Promise<NativeOverlayState | null> {
  const value = await invokeNative<unknown>('get_overlay_state');
  return parseNativeOverlayState(value);
}

export async function getNativeWindowVisibility(): Promise<NativeWindowVisibility | null> {
  const value = await invokeNative<unknown>('get_current_window_visibility');
  return parseNativeWindowVisibility(value);
}

export async function listNativeMonitors(): Promise<NativeMonitorInfo[]> {
  const value = await invokeNative<unknown>('list_available_monitors');
  return parseNativeMonitorList(value) ?? [];
}

export async function listenNativeOverlayState(
  listener: (state: NativeOverlayState) => void,
): Promise<() => void> {
  if (!hasNativeDesktopRuntime()) return () => undefined;
  const { listen } = await import('@tauri-apps/api/event');
  return listen<unknown>(NATIVE_OVERLAY_STATE_EVENT, (event) => {
    const state = parseNativeOverlayState(event.payload);
    if (state !== null) listener(state);
  });
}

export async function watchNativeOverlayState(
  listener: (state: NativeOverlayState) => void,
): Promise<() => void> {
  let eventObserved = false;
  const unlisten = await listenNativeOverlayState((state) => {
    eventObserved = true;
    listener(state);
  });
  try {
    const current = await getNativeOverlayState();
    if (!eventObserved && current !== null) listener(current);
    return unlisten;
  } catch (error) {
    unlisten();
    throw error;
  }
}

export async function listenNativeWindowVisibility(
  listener: (state: NativeWindowVisibility) => void,
): Promise<() => void> {
  if (!hasNativeDesktopRuntime()) return () => undefined;
  const { listen } = await import('@tauri-apps/api/event');
  return listen<unknown>(NATIVE_WINDOW_VISIBILITY_EVENT, (event) => {
    const state = parseNativeWindowVisibility(event.payload);
    if (state !== null) listener(state);
  });
}

export async function watchNativeWindowVisibility(
  listener: (state: NativeWindowVisibility) => void,
): Promise<() => void> {
  let eventObserved = false;
  const unlisten = await listenNativeWindowVisibility((state) => {
    eventObserved = true;
    listener(state);
  });
  try {
    const current = await getNativeWindowVisibility();
    if (!eventObserved && current !== null) listener(current);
    return unlisten;
  } catch (error) {
    unlisten();
    throw error;
  }
}

export async function publishNativeAuthState(state: NativeAuthState): Promise<void> {
  await invokeNative('publish_auth_state', { state });
}

export async function listenNativeAuthState(
  listener: (change: NativeAuthStateChange) => void,
): Promise<() => void> {
  if (!hasNativeDesktopRuntime()) return () => undefined;
  const { listen } = await import('@tauri-apps/api/event');
  return listen<unknown>(NATIVE_AUTH_STATE_EVENT, (event) => {
    const change = parseNativeAuthState(event.payload);
    if (change !== null) listener(change);
  });
}

export async function showMainWindow(): Promise<void> {
  await invokeNative('show_main_window');
}

export async function hideCurrentWindow(): Promise<void> {
  await invokeNative('hide_current_window');
}

export async function quitApplication(): Promise<void> {
  await invokeNative('quit_application');
}

export async function loadDesktopPreferences(): Promise<DesktopPreferences | null> {
  return invokeNative<DesktopPreferences>('load_desktop_preferences');
}

export async function patchDesktopPreference<K extends keyof DesktopPreferencePatchValues>(
  key: K,
  value: DesktopPreferencePatchValues[K],
): Promise<DesktopPreferences | null> {
  const result = await invokeNative<unknown>('patch_desktop_preference', { key, value });
  if (result === null) return null;
  const parsed = parseDesktopPreferences(result);
  if (parsed === null) throw new Error('桌面偏好响应格式无效');
  return parsed;
}

export async function setAutostartEnabled(enabled: boolean): Promise<DesktopPreferences | null> {
  const result = await invokeNative<unknown>('set_autostart_enabled', { enabled });
  if (result === null) return null;
  const parsed = parseDesktopPreferences(result);
  if (parsed === null) throw new Error('开机启动响应格式无效');
  return parsed;
}

export async function getGlobalShortcutStatus(): Promise<GlobalShortcutStatus | null> {
  const result = await invokeNative<unknown>('get_global_shortcut_status');
  return parseGlobalShortcutStatus(result);
}

export async function setGlobalShortcut(shortcut: string): Promise<GlobalShortcutStatus | null> {
  await invokeNative('set_global_shortcut', { shortcut });
  return getGlobalShortcutStatus();
}

export async function saveRefreshCredential(accountId: string, credential: string): Promise<void> {
  await invokeRequiredNative('store_refresh_credential', { accountId, credential });
}

export async function readRefreshCredential(accountId: string): Promise<string> {
  return invokeRequiredNative<string>('read_refresh_credential', { accountId });
}

export async function deleteRefreshCredential(accountId: string): Promise<void> {
  await invokeRequiredNative('delete_refresh_credential', { accountId });
}

export async function sendNativeSummaryNotification(
  title: string,
  body: string,
  taskCount: number,
): Promise<void> {
  await invokeNative('show_summary_notification', { title, body, taskCount });
}
