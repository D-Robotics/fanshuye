import appSource from '../App.tsx?raw';
import authEventsRustSource from '../../src-tauri/src/auth_events.rs?raw';
import capabilitySource from '../../src-tauri/capabilities/desktop.json?raw';
import tauriConfigSource from '../../src-tauri/tauri.conf.json?raw';
import libRustSource from '../../src-tauri/src/lib.rs?raw';
import preferencesRustSource from '../../src-tauri/src/preferences.rs?raw';
import windowsRustSource from '../../src-tauri/src/windows.rs?raw';
import nativeSource from './native.ts?raw';
import {
  desktopPreferencesEqual,
  parseNativeAuthState,
  parseNativeMonitorList,
  parseNativeOverlayState,
  parseNativeWindowVisibility,
  parseDesktopPreferences,
  type DesktopPreferences,
} from './native';

const preferences: DesktopPreferences = {
  privacyMode: true,
  reducedMotion: true,
  doNotDisturb: true,
  autostart: false,
  preferredMonitor: 'monitor-1',
  selectedWorkspaceId: '11111111-1111-4111-8111-111111111111',
  edge: 'right',
};

describe('cross-window desktop preference validation', () => {
  it('accepts a complete privacy payload and rejects malformed event data', () => {
    expect(parseDesktopPreferences(preferences)).toEqual(preferences);
    expect(parseDesktopPreferences({ ...preferences, privacyMode: 'yes' })).toBeNull();
    expect(parseDesktopPreferences({ ...preferences, edge: 'top' })).toBeNull();
    expect(parseDesktopPreferences({ privacyMode: true })).toBeNull();
  });

  it('prevents preference event echo loops by comparing every persisted field', () => {
    expect(desktopPreferencesEqual(preferences, { ...preferences })).toBe(true);
    expect(desktopPreferencesEqual(preferences, { ...preferences, privacyMode: false })).toBe(
      false,
    );
    expect(desktopPreferencesEqual(preferences, { ...preferences, preferredMonitor: null })).toBe(
      false,
    );
    expect(
      desktopPreferencesEqual(preferences, { ...preferences, selectedWorkspaceId: null }),
    ).toBe(false);
  });

  it('broadcasts persisted preferences from Rust instead of independently from each webview', () => {
    expect(appSource).not.toContain("emit('desktop-preferences-changed'");
    const saveIndex = preferencesRustSource.indexOf('store.save()');
    const emitIndex = preferencesRustSource.indexOf('app.emit("desktop-preferences-changed"');
    expect(saveIndex).toBeGreaterThanOrEqual(0);
    expect(emitIndex).toBeGreaterThan(saveIndex);
  });

  it('rolls an unconfirmed or unpersisted autostart change back to the authoritative state', () => {
    const commandStart = preferencesRustSource.indexOf('pub fn set_autostart_enabled');
    const commandEnd = preferencesRustSource.indexOf('pub fn show_summary_notification');
    const commandSource = preferencesRustSource.slice(commandStart, commandEnd);
    expect(commandSource).toContain('let restore_previous_state = ||');
    expect(commandSource).toContain('let actual = match manager.is_enabled()');
    expect(commandSource).toContain('if restore_previous_state()');
    expect(commandSource).toContain('match persist_preferences(&app, &preferences)');
    expect(commandSource.indexOf('restore_previous_state()')).toBeLessThan(
      commandSource.indexOf('无法确认开机启动状态，已恢复原设置'),
    );
  });

  it('fails closed on corrupted persisted preferences instead of overwriting other fields', () => {
    expect(preferencesRustSource).toContain('fn try_read_desktop_preferences');
    expect(preferencesRustSource).toContain('桌面偏好已损坏，请先修复或移除偏好文件');
    const readStart = preferencesRustSource.indexOf('fn try_read_desktop_preferences');
    const readEnd = preferencesRustSource.indexOf('pub(crate) fn read_desktop_preferences');
    expect(preferencesRustSource.slice(readStart, readEnd)).toContain(
      'validate_preferences(&preferences)?',
    );
    const patchStart = preferencesRustSource.indexOf('pub fn patch_desktop_preference');
    const patchEnd = preferencesRustSource.indexOf('fn valid_uuid_shape');
    expect(preferencesRustSource.slice(patchStart, patchEnd)).toContain(
      'try_read_desktop_preferences(&app)?',
    );
    const loadStart = appSource.indexOf('void loadDesktopPreferences()');
    const loadEnd = appSource.indexOf('void watchNativeWindowVisibility');
    const loadSource = appSource.slice(loadStart, loadEnd);
    expect(loadSource).toContain('privacyMode: true');
    expect(loadSource).toContain('已进入隐私保护模式且未写入默认值');
  });

  it('removes authenticated task content before waiting for logout revocation', () => {
    const invalidationStart = appSource.indexOf('const requireAuthentication = useCallback');
    const invalidationEnd = appSource.indexOf('const reloadWorkspaceMemberships');
    const invalidationSource = appSource.slice(invalidationStart, invalidationEnd);
    expect(invalidationSource.indexOf('resetAuthenticatedUiState();')).toBeLessThan(
      invalidationSource.indexOf('await authenticationClient.logout();'),
    );

    const logoutStart = appSource.indexOf('const logout = async');
    const logoutEnd = appSource.indexOf('const changeAutostart');
    const logoutSource = appSource.slice(logoutStart, logoutEnd);
    expect(logoutSource.indexOf('resetAuthenticatedUiState();')).toBeLessThan(
      logoutSource.indexOf('await authenticationClient.logout();'),
    );
  });

  it('clears the previous account projection before restoring a sibling login', () => {
    const listenerStart = appSource.indexOf('void listenNativeAuthState');
    const listenerEnd = appSource.indexOf("await listen('toggle-privacy'");
    const listenerSource = appSource.slice(listenerStart, listenerEnd);
    expect(listenerSource.indexOf('resetAuthenticatedUiState();')).toBeLessThan(
      listenerSource.indexOf('await authenticationClient.restore(ACTIVE_NATIVE_SESSION_ACCOUNT)'),
    );
  });

  it('unsubscribes native state listeners when their initial state query fails', () => {
    const overlayWatchStart = nativeSource.indexOf('export async function watchNativeOverlayState');
    const visibilityWatchStart = nativeSource.indexOf(
      'export async function watchNativeWindowVisibility',
    );
    const authPublishStart = nativeSource.indexOf('export async function publishNativeAuthState');
    const overlayWatchSource = nativeSource.slice(overlayWatchStart, visibilityWatchStart);
    const visibilityWatchSource = nativeSource.slice(visibilityWatchStart, authPublishStart);
    expect(overlayWatchSource).toContain('unlisten();');
    expect(overlayWatchSource).toContain('throw error;');
    expect(visibilityWatchSource).toContain('unlisten();');
    expect(visibilityWatchSource).toContain('throw error;');
  });

  it('passes a count to a native notification gate that re-reads shared privacy preferences', () => {
    expect(nativeSource).toContain(
      "invokeNative('show_summary_notification', { title, body, taskCount })",
    );
    expect(preferencesRustSource).toContain(
      'let preferences = try_read_desktop_preferences(&app)?;',
    );
    expect(preferencesRustSource).toContain('if preferences.privacy_mode');
    expect(preferencesRustSource).toContain('format!("{task_count} 项团队任务需要关注")');
    expect(preferencesRustSource).toContain('"番薯叶任务提醒".into()');
  });

  it('validates one native overlay state payload and explicit visibility events', () => {
    expect(parseNativeOverlayState({ mode: 'preview', visible: true })).toEqual({
      mode: 'preview',
      visible: true,
    });
    expect(parseNativeOverlayState({ mode: 'expanded', visible: true })).toBeNull();
    expect(parseNativeOverlayState({ mode: 'preview', visible: 'yes' })).toBeNull();
    expect(parseNativeWindowVisibility({ label: 'overlay', visible: false })).toEqual({
      label: 'overlay',
      visible: false,
    });
    expect(parseNativeWindowVisibility({ label: 2, visible: false })).toBeNull();
    expect(windowsRustSource).toContain('"desktop-overlay-state-changed"');
    expect(windowsRustSource).toContain('"desktop-window-visibility-changed"');
    expect(windowsRustSource).toContain('fn rollback_overlay_transition');
    expect(windowsRustSource).toContain('rollback_overlay_transition(window, &previous_state)');
    const rollbackStart = windowsRustSource.indexOf('fn rollback_overlay_transition');
    const transitionStart = windowsRustSource.indexOf('fn apply_overlay_mode_with_presentation');
    expect(windowsRustSource.slice(rollbackStart, transitionStart)).not.toContain(
      'apply_overlay_mode_with_presentation(',
    );
  });

  it('strictly validates a non-sensitive native auth-state bridge', () => {
    expect(parseNativeAuthState({ state: 'authenticated', sourceLabel: 'main' })).toEqual({
      state: 'authenticated',
      sourceLabel: 'main',
    });
    expect(parseNativeAuthState({ state: 'cleared', sourceLabel: 'overlay' })).toEqual({
      state: 'cleared',
      sourceLabel: 'overlay',
    });
    expect(parseNativeAuthState({ state: 'refreshing', sourceLabel: 'main' })).toBeNull();
    expect(parseNativeAuthState({ state: 'authenticated', sourceLabel: '' })).toBeNull();
    expect(
      parseNativeAuthState({ state: 'authenticated', sourceLabel: 'main', accountId: 'secret' }),
    ).toBeNull();
    expect(authEventsRustSource).toContain('"desktop-auth-state-changed"');
    expect(authEventsRustSource).toContain('source_label: window.label().into()');
    expect(authEventsRustSource).not.toContain('account_id');
    expect(authEventsRustSource).not.toContain('credential:');
    expect(libRustSource).toContain('auth_events::publish_auth_state');
    expect(nativeSource).toContain("invokeNative('publish_auth_state', { state })");
    expect(nativeSource).toContain('export async function listenNativeAuthState');
  });

  it('validates monitor options with stable keys and a primary marker', () => {
    expect(
      parseNativeMonitorList([
        { key: '\\\\.\\DISPLAY1', label: 'DISPLAY1 · 1920×1080 · 100%', primary: true },
        { key: '\\\\.\\DISPLAY2', label: 'DISPLAY2 · 2560×1440 · 150%', primary: false },
      ]),
    ).toHaveLength(2);
    expect(parseNativeMonitorList([{ key: '', label: 'Display', primary: true }])).toBeNull();
    expect(parseNativeMonitorList([{ key: 'display', label: '', primary: true }])).toBeNull();
    expect(parseNativeMonitorList([{ key: 'display', label: 'Display' }])).toBeNull();
  });

  it('keeps side-panel outer bounds frame-free and exposes recovery commands', () => {
    const sidePanelIndex = windowsRustSource.indexOf('fn configure_side_panel');
    const nextFunctionIndex = windowsRustSource.indexOf('fn configure_presentation');
    const sidePanelSource = windowsRustSource.slice(sidePanelIndex, nextFunctionIndex);
    expect(sidePanelSource).toContain('set_decorations(false)');
    expect(nativeSource).toContain("invokeNative<unknown>('get_overlay_state')");
    expect(nativeSource).toContain("invokeNative('start_overlay_drag')");
    expect(nativeSource).toContain("invokeNative<unknown>('get_current_window_visibility')");
    expect(nativeSource).toContain("invokeNative<unknown>('list_available_monitors')");
    expect(nativeSource).toContain('export async function watchNativeWindowVisibility');
    expect(windowsRustSource).toContain('.set_focusable(mode != OverlayMode::Collapsed)');
    expect(windowsRustSource).toContain('if mode.accepts_keyboard_focus()');
    expect(windowsRustSource).toContain('window.set_focus()');
  });

  it('exposes explicit hide and process-exit commands to every main-window state', () => {
    expect(nativeSource).toContain("invokeNative('hide_current_window')");
    expect(nativeSource).toContain("invokeNative('quit_application')");
    expect(libRustSource).toContain('windows::hide_current_window');
    expect(libRustSource).toContain('windows::quit_application');
    expect(windowsRustSource).toContain('pub fn hide_current_window');
    expect(windowsRustSource).toContain('pub fn quit_application');
    const showMainStart = windowsRustSource.indexOf('pub fn show_main(app: &AppHandle)');
    const showMainEnd = windowsRustSource.indexOf('#[tauri::command]\npub fn show_main_window');
    const showMainSource = windowsRustSource.slice(showMainStart, showMainEnd);
    expect(showMainSource.indexOf('overlay.hide()')).toBeLessThan(
      showMainSource.indexOf('window.show()'),
    );
    const hideCurrentStart = windowsRustSource.indexOf('pub fn hide_current_window');
    const overlayEntryStart = windowsRustSource.indexOf('fn show_overlay_entry');
    expect(windowsRustSource.slice(hideCurrentStart, overlayEntryStart)).toContain(
      'show_overlay_entry(window.app_handle())',
    );
    expect(windowsRustSource.slice(overlayEntryStart)).toContain(
      'apply_overlay_mode(&overlay, OverlayMode::Collapsed.as_str())',
    );
    const loginBranchStart = appSource.indexOf(
      "if (!demoMode && authenticationStatus === 'required')",
    );
    const loginBranchEnd = appSource.indexOf("if (!demoMode && workspaceStatus === 'loading')");
    const loginBranch = appSource.slice(loginBranchStart, loginBranchEnd);
    expect(loginBranch).toContain("if (windowKind === 'overlay')");
    expect(loginBranch).toContain('fy-overlay-window--${overlay.mode}');
    expect(loginBranch).not.toContain("if (overlay.mode === 'preview') overlay.open()");
  });

  it('separates production and local-development network policy', () => {
    const config = JSON.parse(tauriConfigSource) as {
      app: { security: { csp: string; devCsp: string } };
    };
    expect(config.app.security.csp).toContain('https://api.fanshuye.app');
    expect(config.app.security.csp).not.toContain('localhost');
    expect(config.app.security.csp).not.toContain('127.0.0.1');
    expect(config.app.security.devCsp).toContain('http://127.0.0.1:4310');
    expect(config.app.security.devCsp).toContain('ws://127.0.0.1:4310');
  });

  it('grants only event listening and the SQLite operations the webviews use', () => {
    const capability = JSON.parse(capabilitySource) as { permissions: string[] };
    expect(capability.permissions).toEqual([
      'core:event:allow-listen',
      'core:event:allow-unlisten',
      'sql:allow-load',
      'sql:allow-select',
      'sql:allow-execute',
    ]);
    expect(libRustSource).toContain('.with_state_flags(persisted_window_state_flags())');
    const flagsSource = libRustSource.slice(
      libRustSource.indexOf('fn persisted_window_state_flags'),
      libRustSource.indexOf('fn fallback_tray_icon'),
    );
    expect(flagsSource).not.toContain('StateFlags::VISIBLE');
  });
});
