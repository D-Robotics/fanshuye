import {
  SyncStatusBanner,
  TaskDetailPanel,
  TaskForm,
  TaskList,
  TaskPlantOverlay,
  TaskTree,
  isTaskActive,
  type ManualBlock,
  type MemberSummary,
  type SyncViewState,
  type TaskCommandRequest,
  type TaskDraft,
  type TaskItem,
} from '@fanshuye/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DesktopAuthenticationClient } from './auth/client';
import { LoginPanel } from './auth/LoginPanel';
import { ACTIVE_NATIVE_SESSION_ACCOUNT, createRuntimeSecureSession } from './auth/secure-session';
import {
  WorkspaceAuthenticationRequiredError,
  chooseInitialWorkspace,
  listAuthenticatedWorkspaces,
  type DesktopWorkspaceSummary,
} from './auth/workspaces';
import { createDemoTasks, DEMO_MEMBERS } from './demo-data';
import { DesktopWindowControls } from './DesktopWindowControls';
import { notifyTaskAttention } from './notifications';
import { useOverlayMachine } from './overlay-machine';
import { UsabilityStudyHarness } from './UsabilityStudyHarness';
import {
  desktopPreferencesEqual,
  getGlobalShortcutStatus,
  hasNativeDesktopRuntime,
  listenNativeAuthState,
  listNativeMonitors,
  loadDesktopPreferences,
  parseDesktopPreferences,
  patchDesktopPreference,
  publishNativeAuthState,
  setAutostartEnabled,
  setGlobalShortcut,
  showMainWindow,
  watchNativeOverlayState,
  watchNativeWindowVisibility,
  type DesktopPreferences,
  type DesktopPreferencePatchValues,
  type GlobalShortcutStatus,
  type NativeMonitorInfo,
} from './platform/native';
import { createConfirmedCache } from './sync/cache';
import { DesktopSyncController } from './sync/controller';
import { HttpSyncTransport } from './sync/http-transport';
import {
  ServerTaskCommandSchema,
  buildCreateTaskInput,
  buildServerTaskCommand,
  buildUpdateTaskCommand,
} from './sync/server-adapter';

type WindowKind = 'overlay' | 'main';
type ViewKind = 'tree' | 'list';
type AuthenticationStatus = 'restoring' | 'authenticated' | 'required';
type WorkspaceStatus = 'loading' | 'ready' | 'select' | 'empty' | 'error';

const DEFAULT_MEMBER_ID = import.meta.env.VITE_CURRENT_MEMBER_ID ?? 'member-ada';
const API_URL =
  import.meta.env.VITE_API_URL ??
  (import.meta.env.DEV ? 'http://127.0.0.1:4310' : 'https://api.fanshuye.app');
const WS_URL =
  import.meta.env.VITE_WS_URL ??
  (import.meta.env.DEV ? 'ws://127.0.0.1:4310' : 'wss://api.fanshuye.app');
const RUNTIME_SECURE_SESSION = createRuntimeSecureSession();
const DEFAULT_PREFERENCES: DesktopPreferences = {
  privacyMode: false,
  reducedMotion: false,
  doNotDisturb: false,
  autostart: false,
  preferredMonitor: null,
  selectedWorkspaceId: null,
  edge: 'right',
};

function getWindowKind(): WindowKind {
  return new URLSearchParams(window.location.search).get('window') === 'overlay'
    ? 'overlay'
    : 'main';
}

export function wouldCreateDependencyCycle(
  tasks: readonly TaskItem[],
  dependentTaskId: string,
  prerequisiteTaskId: string,
): boolean {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const pending = [prerequisiteTaskId];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const currentId = pending.pop()!;
    if (currentId === dependentTaskId) return true;
    if (visited.has(currentId)) continue;
    visited.add(currentId);
    for (const prerequisite of byId.get(currentId)?.prerequisites ?? []) {
      pending.push(prerequisite.taskId);
    }
  }
  return false;
}

export function buildDependencyMutations(
  existingPrerequisiteIds: readonly string[],
  requestedPrerequisiteIds: readonly string[],
): Array<{
  type: 'AddDependency' | 'RemoveDependency';
  prerequisiteTaskId: string;
}> {
  return [
    ...existingPrerequisiteIds
      .filter((id) => !requestedPrerequisiteIds.includes(id))
      .map((prerequisiteTaskId) => ({
        type: 'RemoveDependency' as const,
        prerequisiteTaskId,
      })),
    ...requestedPrerequisiteIds
      .filter((id) => !existingPrerequisiteIds.includes(id))
      .map((prerequisiteTaskId) => ({
        type: 'AddDependency' as const,
        prerequisiteTaskId,
      })),
  ];
}

function updateDemoTask(
  task: TaskItem,
  request: TaskCommandRequest,
  currentMemberId: string,
  currentMemberName: string,
): TaskItem {
  let status = task.status;
  let ownerId = task.ownerId;
  let ownerName = task.ownerName;
  let collaboratorIds = task.collaboratorIds;
  let collaboratorNames = task.collaboratorNames;
  let manualBlock = task.manualBlock;
  let archivedAt = task.archivedAt;
  switch (request.name) {
    case 'claim-and-start':
      ownerId = currentMemberId;
      ownerName = currentMemberName;
      status = 'IN_PROGRESS';
      break;
    case 'start':
      status = 'IN_PROGRESS';
      break;
    case 'join':
      if (!collaboratorIds.includes(currentMemberId)) {
        collaboratorIds = [...collaboratorIds, currentMemberId];
        collaboratorNames = [...collaboratorNames, currentMemberName];
      }
      break;
    case 'request-transfer':
    case 'transfer':
      break;
    case 'pause':
      status = 'TODO';
      break;
    case 'release':
      status = 'TODO';
      ownerId = null;
      ownerName = null;
      break;
    case 'block': {
      const requestedType = request.payload?.type;
      const requestedReason = request.payload?.reason;
      manualBlock = {
        type:
          typeof requestedType === 'string' &&
          ['technical', 'decision', 'resource', 'external', 'other'].includes(requestedType)
            ? (requestedType as ManualBlock['type'])
            : 'other',
        reason:
          typeof requestedReason === 'string' && requestedReason.trim().length > 0
            ? requestedReason.trim()
            : '等待团队确认',
      };
      break;
    }
    case 'unblock':
      manualBlock = null;
      break;
    case 'request-review':
      status = 'IN_REVIEW';
      break;
    case 'request-changes':
      status = 'IN_PROGRESS';
      break;
    case 'complete':
      status = 'DONE';
      archivedAt = new Date().toISOString();
      break;
    case 'cancel':
      status = 'CANCELED';
      archivedAt = new Date().toISOString();
      break;
    case 'reopen':
      status = 'TODO';
      archivedAt = null;
      break;
  }
  return {
    ...task,
    status,
    ownerId,
    ownerName,
    collaboratorIds,
    collaboratorNames,
    manualBlock,
    archivedAt,
    version: task.version + 1,
    updatedAt: new Date().toISOString(),
    timeline: [
      {
        id: crypto.randomUUID(),
        text: `执行操作：${request.name}`,
        actorName: currentMemberName,
        occurredAt: new Date().toISOString(),
      },
      ...task.timeline,
    ],
  };
}

export interface AppProps {
  runtimeMode?: 'auto' | 'demo' | 'production';
}

export function resolveDemoMode(
  runtimeMode: NonNullable<AppProps['runtimeMode']>,
  usabilityStudyMode: boolean,
  configuredDemoMode: string | undefined,
  isDevelopment: boolean,
): boolean {
  if (runtimeMode === 'demo') return true;
  if (runtimeMode === 'production') return false;
  return (
    usabilityStudyMode ||
    configuredDemoMode === 'true' ||
    (isDevelopment && configuredDemoMode !== 'false')
  );
}

export function App({ runtimeMode = 'auto' }: AppProps = {}) {
  const windowKind = getWindowKind();
  const usabilityStudyMode =
    new URLSearchParams(window.location.search).get('usability') === '30-task';
  const demoMode = resolveDemoMode(
    runtimeMode,
    usabilityStudyMode,
    import.meta.env.VITE_DEMO_MODE,
    import.meta.env.DEV,
  );
  const [tasks, setTasks] = useState<TaskItem[]>(() => (demoMode ? createDemoTasks() : []));
  const [members, setMembers] = useState<MemberSummary[]>(demoMode ? DEMO_MEMBERS : []);
  const [syncStatus, setSyncStatus] = useState<SyncViewState['status']>(
    demoMode ? 'online' : 'recovering',
  );
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(
    demoMode ? new Date().toISOString() : null,
  );
  const [syncMessage, setSyncMessage] = useState<string | null>(demoMode ? '本地交互预览' : null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<ViewKind>('tree');
  const [listScope, setListScope] = useState<ReadonlySet<string> | null>(null);
  const [editingTask, setEditingTask] = useState<TaskItem | 'new' | null>(null);
  const [taskFormError, setTaskFormError] = useState<string | null>(null);
  const [onlyMine, setOnlyMine] = useState(false);
  const [authenticationStatus, setAuthenticationStatus] = useState<AuthenticationStatus>(
    demoMode ? 'authenticated' : 'restoring',
  );
  const [authenticationNotice, setAuthenticationNotice] = useState<string | null>(null);
  const [currentMemberId, setCurrentMemberId] = useState(DEFAULT_MEMBER_ID);
  const [workspaceStatus, setWorkspaceStatus] = useState<WorkspaceStatus>(
    demoMode ? 'ready' : 'loading',
  );
  const [availableWorkspaces, setAvailableWorkspaces] = useState<DesktopWorkspaceSummary[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(
    demoMode ? 'demo-workspace' : null,
  );
  const [workspaceMessage, setWorkspaceMessage] = useState<string | null>(null);
  const [workspaceDiscoveryAttempt, setWorkspaceDiscoveryAttempt] = useState(0);
  const [preferences, setPreferences] = useState(DEFAULT_PREFERENCES);
  const [preferencesReady, setPreferencesReady] = useState(
    () => window.__TAURI_INTERNALS__ === undefined,
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [nativeMonitors, setNativeMonitors] = useState<NativeMonitorInfo[]>([]);
  const [shortcutStatus, setShortcutStatus] = useState<GlobalShortcutStatus | null>(null);
  const [desktopSettingPending, setDesktopSettingPending] = useState<string | null>(null);
  const [desktopSettingMessage, setDesktopSettingMessage] = useState<string | null>(null);
  const [completionNotice, setCompletionNotice] = useState(false);
  const [windowVisible, setWindowVisible] = useState(() => !document.hidden);
  const controllerRef = useRef<DesktopSyncController | null>(null);
  const windowVisibleRef = useRef(windowVisible);
  const notificationBaselineRef = useRef<Map<string, number> | null>(null);
  const authenticationInvalidationRef = useRef<Promise<void> | null>(null);
  const authenticationClient = useMemo(
    () => new DesktopAuthenticationClient(API_URL, RUNTIME_SECURE_SESSION),
    [],
  );
  const overlay = useOverlayMachine(windowKind === 'overlay' ? 'collapsed' : 'pinned');
  const synchronizeNativeOverlayMode = overlay.synchronizeNativeMode;
  const applyWindowVisibility = useCallback((visible: boolean) => {
    windowVisibleRef.current = visible;
    setWindowVisible(visible);
    document.documentElement.toggleAttribute('data-window-hidden', !visible);
    void controllerRef.current?.setWindowVisible(visible);
  }, []);
  const resetAuthenticatedUiState = useCallback(() => {
    controllerRef.current?.stop();
    controllerRef.current = null;
    notificationBaselineRef.current = null;
    setTasks([]);
    setMembers([]);
    setSelectedId(null);
    setEditingTask(null);
    setTaskFormError(null);
    setListScope(null);
    setView('tree');
    setOnlyMine(false);
    setCompletionNotice(false);
    setLastSyncedAt(null);
    setSyncStatus('recovering');
    setSyncMessage(null);
    setSelectedWorkspaceId(null);
    setAvailableWorkspaces([]);
    setWorkspaceStatus('loading');
    setWorkspaceMessage(null);
    setCurrentMemberId(DEFAULT_MEMBER_ID);
    setSettingsOpen(false);
  }, []);
  const requireAuthentication = useCallback(
    (notice = '登录会话已失效，请重新登录。') => {
      if (authenticationInvalidationRef.current !== null) return;
      // Remove potentially sensitive task content from the screen immediately.
      // Credential deletion and best-effort server revocation can finish in the background.
      resetAuthenticatedUiState();
      setAuthenticationNotice(notice);
      setAuthenticationStatus('required');
      const invalidation = (async () => {
        try {
          await authenticationClient.logout();
        } catch {
          RUNTIME_SECURE_SESSION.clearEphemeral();
        }
        await publishNativeAuthState('cleared').catch(() => undefined);
      })().finally(() => {
        if (authenticationInvalidationRef.current === invalidation) {
          authenticationInvalidationRef.current = null;
        }
      });
      authenticationInvalidationRef.current = invalidation;
    },
    [authenticationClient, resetAuthenticatedUiState],
  );
  const reloadWorkspaceMemberships = useCallback(() => {
    controllerRef.current?.stop();
    controllerRef.current = null;
    setTasks([]);
    setMembers([]);
    setSelectedId(null);
    setEditingTask(null);
    setTaskFormError(null);
    setListScope(null);
    setSelectedWorkspaceId(null);
    setWorkspaceStatus('loading');
    setWorkspaceDiscoveryAttempt((attempt) => attempt + 1);
  }, []);
  const commitDesktopPreference = useCallback(
    async <K extends keyof DesktopPreferencePatchValues>(
      key: K,
      value: DesktopPreferencePatchValues[K],
    ) => {
      if (!hasNativeDesktopRuntime()) {
        setPreferences((current) => ({ ...current, [key]: value }));
        return;
      }
      setDesktopSettingPending(key);
      setDesktopSettingMessage(null);
      try {
        const saved = await patchDesktopPreference(key, value);
        if (saved !== null) setPreferences(saved);
      } catch (error) {
        setDesktopSettingMessage(error instanceof Error ? error.message : '桌面偏好保存失败');
      } finally {
        setDesktopSettingPending((current) => (current === key ? null : current));
      }
    },
    [],
  );

  const selected = tasks.find((task) => task.id === selectedId) ?? null;
  const activeTasks = useMemo(() => tasks.filter(isTaskActive), [tasks]);
  const myTaskIds = useMemo(
    () =>
      new Set(
        activeTasks
          .filter(
            (task) =>
              task.ownerId === currentMemberId || task.collaboratorIds.includes(currentMemberId),
          )
          .map((task) => task.id),
      ),
    [activeTasks, currentMemberId],
  );

  useEffect(() => {
    if (window.__TAURI_INTERNALS__ === undefined) return;
    let disposed = false;
    void loadDesktopPreferences()
      .then((saved) => {
        if (!disposed && saved !== null) setPreferences(saved);
      })
      .catch(() => {
        if (!disposed) {
          // A damaged preference file must never silently disable privacy.
          // Keep the disk untouched and render only privacy-safe content.
          setPreferences({
            ...DEFAULT_PREFERENCES,
            privacyMode: true,
            reducedMotion: true,
            doNotDisturb: true,
          });
          setDesktopSettingMessage('无法读取桌面偏好，已进入隐私保护模式且未写入默认值。');
        }
      })
      .finally(() => {
        if (!disposed) setPreferencesReady(true);
      });
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    if (window.__TAURI_INTERNALS__ === undefined) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void watchNativeWindowVisibility((state) => {
      if (state.label === windowKind) applyWindowVisibility(state.visible);
    })
      .then((cleanup) => {
        if (disposed) cleanup();
        else unlisten = cleanup;
      })
      .catch(() => {
        if (!disposed) setSyncMessage('无法监听窗口显示状态，请重新启动番薯叶。');
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [applyWindowVisibility, windowKind]);

  useEffect(() => {
    if (windowKind !== 'overlay' || window.__TAURI_INTERNALS__ === undefined) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void watchNativeOverlayState((state) => {
      synchronizeNativeOverlayMode(state.mode);
    })
      .then((cleanup) => {
        if (disposed) cleanup();
        else unlisten = cleanup;
      })
      .catch(() => {
        if (!disposed) setSyncMessage('无法同步悬浮窗状态，请重新启动番薯叶。');
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [synchronizeNativeOverlayMode, windowKind]);

  useEffect(() => {
    if (demoMode || window.__TAURI_INTERNALS__ === undefined) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listenNativeAuthState((change) => {
      if (change.sourceLabel === windowKind) return;
      void (async () => {
        if (change.state === 'cleared') {
          RUNTIME_SECURE_SESSION.clearEphemeral();
          resetAuthenticatedUiState();
          setAuthenticationNotice('已在另一个番薯叶窗口退出登录。');
          setAuthenticationStatus('required');
          return;
        }

        // The fixed keyring slot may now belong to a different account. Never
        // retain the previous account's projection while restoring it.
        resetAuthenticatedUiState();
        setAuthenticationStatus('restoring');
        try {
          await authenticationClient.restore(ACTIVE_NATIVE_SESSION_ACCOUNT);
          const accountId = RUNTIME_SECURE_SESSION.getAccountId();
          if (accountId === null) throw new Error('登录会话已失效，请重新登录。');
          if (!disposed) {
            setCurrentMemberId(accountId);
            setAuthenticationNotice(null);
            setAuthenticationStatus('authenticated');
          }
        } catch {
          if (!disposed) {
            setAuthenticationNotice('无法同步另一个窗口的登录，请重新登录。');
            setAuthenticationStatus('required');
          }
        }
      })();
    })
      .then((cleanup) => {
        if (disposed) cleanup();
        else unlisten = cleanup;
      })
      .catch(() => {
        if (!disposed) setSyncMessage('无法监听多窗口登录状态，请重新启动番薯叶。');
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [authenticationClient, demoMode, resetAuthenticatedUiState, windowKind]);

  useEffect(() => {
    if (window.__TAURI_INTERNALS__ === undefined) return;
    const unlisteners: Array<() => void> = [];
    void import('@tauri-apps/api/event').then(async ({ listen }) => {
      unlisteners.push(
        await listen('toggle-privacy', () => {
          void commitDesktopPreference('privacyMode', !preferences.privacyMode);
        }),
      );
      unlisteners.push(
        await listen<unknown>('desktop-preferences-changed', (event) => {
          const incoming = parseDesktopPreferences(event.payload);
          if (incoming === null) return;
          setPreferences((current) =>
            desktopPreferencesEqual(current, incoming) ? current : incoming,
          );
        }),
      );
    });
    return () => {
      for (const unlisten of unlisteners) unlisten();
    };
  }, [commitDesktopPreference, preferences.privacyMode]);

  useEffect(() => {
    if (!settingsOpen || !hasNativeDesktopRuntime()) return;
    let disposed = false;
    void Promise.all([listNativeMonitors(), getGlobalShortcutStatus()])
      .then(([monitors, shortcut]) => {
        if (disposed) return;
        setNativeMonitors(monitors);
        setShortcutStatus(shortcut);
      })
      .catch((error: unknown) => {
        if (!disposed) {
          setDesktopSettingMessage(
            error instanceof Error ? error.message : '无法读取 Windows 桌面设置',
          );
        }
      });
    return () => {
      disposed = true;
    };
  }, [settingsOpen]);

  useEffect(() => {
    if (demoMode) return;
    let disposed = false;
    void (async () => {
      try {
        const existingAccessCredential = await RUNTIME_SECURE_SESSION.getAccessCredential();
        if (existingAccessCredential === null) {
          await authenticationClient.restore(ACTIVE_NATIVE_SESSION_ACCOUNT);
        }
        const authenticatedMemberId = RUNTIME_SECURE_SESSION.getAccountId();
        if (authenticatedMemberId === null) throw new Error('登录会话已失效，请重新登录。');
        if (!disposed) {
          setCurrentMemberId(authenticatedMemberId);
          setAuthenticationNotice(null);
          setAuthenticationStatus('authenticated');
        }
      } catch {
        if (!disposed) setAuthenticationStatus('required');
      }
    })();
    return () => {
      disposed = true;
    };
  }, [authenticationClient, demoMode]);

  useEffect(() => {
    if (demoMode || authenticationStatus !== 'authenticated' || !preferencesReady) return;
    let disposed = false;
    void Promise.resolve()
      .then(() => {
        if (disposed) return [];
        setWorkspaceStatus('loading');
        setWorkspaceMessage(null);
        setSelectedWorkspaceId(null);
        return listAuthenticatedWorkspaces(API_URL, () =>
          authenticationClient.getValidAccessCredential(),
        );
      })
      .then((workspaces) => {
        if (disposed) return;
        setAvailableWorkspaces(workspaces);
        if (workspaces.length === 0) {
          setWorkspaceStatus('empty');
          return;
        }
        const configuredWorkspaceId = import.meta.env.VITE_WORKSPACE_ID;
        const preferredWorkspaceId =
          configuredWorkspaceId ?? preferences.selectedWorkspaceId ?? undefined;
        const initialWorkspaceId = chooseInitialWorkspace(workspaces, preferredWorkspaceId);
        if (initialWorkspaceId !== null) {
          setSelectedWorkspaceId(initialWorkspaceId);
          if (preferences.selectedWorkspaceId !== initialWorkspaceId) {
            void commitDesktopPreference('selectedWorkspaceId', initialWorkspaceId);
          }
          setWorkspaceStatus('ready');
          return;
        }
        if (preferredWorkspaceId !== undefined) {
          setWorkspaceMessage('上次选择的团队空间不可用，请重新选择。');
          if (configuredWorkspaceId === undefined) {
            void commitDesktopPreference('selectedWorkspaceId', null);
          }
        }
        setWorkspaceStatus('select');
      })
      .catch((error: unknown) => {
        if (disposed) return;
        if (error instanceof WorkspaceAuthenticationRequiredError) {
          requireAuthentication();
          return;
        }
        setWorkspaceMessage(error instanceof Error ? error.message : '无法读取团队空间。');
        setWorkspaceStatus('error');
      });
    return () => {
      disposed = true;
    };
  }, [
    authenticationClient,
    authenticationStatus,
    commitDesktopPreference,
    demoMode,
    preferences.selectedWorkspaceId,
    preferencesReady,
    requireAuthentication,
    workspaceDiscoveryAttempt,
  ]);

  useEffect(() => {
    if (demoMode || authenticationStatus !== 'authenticated' || selectedWorkspaceId === null) {
      return;
    }
    let disposed = false;
    let unsubscribe: (() => void) | null = null;
    let controller: DesktopSyncController | null = null;
    void (async () => {
      try {
        const cache = await createConfirmedCache();
        if (disposed) return;
        const transport = new HttpSyncTransport(
          API_URL,
          WS_URL,
          () => authenticationClient.getValidAccessCredential(),
          undefined,
          {
            refreshAccessCredential: () => authenticationClient.refresh(),
            onAuthenticationRequired: () => requireAuthentication(),
            onWorkspaceAccessChanged: reloadWorkspaceMemberships,
          },
        );
        controller = new DesktopSyncController(transport, cache);
        controllerRef.current = controller;
        void controller.setWindowVisible(windowVisibleRef.current);
        unsubscribe = controller.subscribe((current) => {
          if (disposed) return;
          setSyncStatus(current.status);
          setSyncMessage(current.message);
          if (current.snapshot !== null) {
            setTasks(current.snapshot.tasks);
            setMembers(current.snapshot.members);
            setLastSyncedAt(current.snapshot.capturedAt);
          }
        });
        if (disposed) {
          unsubscribe();
          controller.stop();
          return;
        }
        await controller.start(selectedWorkspaceId);
      } catch {
        if (!disposed) {
          setSyncStatus('offline');
          setSyncMessage('无法打开本地确认缓存，桌面同步已安全停止。');
        }
      }
    })();
    const onOnline = () => {
      if (windowVisibleRef.current) void controllerRef.current?.reconnect();
    };
    const onOffline = () => controllerRef.current?.markDisconnected();
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      disposed = true;
      unsubscribe?.();
      controller?.stop();
      if (controllerRef.current === controller) controllerRef.current = null;
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [
    authenticationClient,
    authenticationStatus,
    demoMode,
    reloadWorkspaceMemberships,
    requireAuthentication,
    selectedWorkspaceId,
  ]);

  useEffect(() => {
    const updateVisibility = () => {
      applyWindowVisibility(!document.hidden);
    };
    if (window.__TAURI_INTERNALS__ !== undefined) return;
    updateVisibility();
    document.addEventListener('visibilitychange', updateVisibility);
    return () => {
      document.removeEventListener('visibilitychange', updateVisibility);
      document.documentElement.removeAttribute('data-window-hidden');
    };
  }, [applyWindowVisibility]);

  useEffect(() => {
    document.documentElement.toggleAttribute('data-reduced-motion', preferences.reducedMotion);
    return () => document.documentElement.removeAttribute('data-reduced-motion');
  }, [preferences.reducedMotion]);

  useEffect(() => {
    const nextBaseline = new Map(activeTasks.map((task) => [task.id, task.version]));
    const previousBaseline = notificationBaselineRef.current;
    notificationBaselineRef.current = nextBaseline;
    if (previousBaseline === null || windowKind !== 'overlay') return;

    const changedAttentionTasks = activeTasks.filter(
      (task) =>
        previousBaseline.get(task.id) !== task.version &&
        (task.actionLevel === 'NOW' ||
          task.ownerId === null ||
          task.manualBlock !== null ||
          task.incompletePrerequisites.length > 0),
    );
    const firstChanged = changedAttentionTasks[0];
    if (firstChanged === undefined) return;
    void notifyTaskAttention(
      { taskTitle: firstChanged.title, taskCount: changedAttentionTasks.length },
      {
        privacyMode: preferences.privacyMode,
        quietHoursEnabled: preferences.doNotDisturb,
      },
    );
  }, [activeTasks, preferences.doNotDisturb, preferences.privacyMode, windowKind]);

  const runCommand = async (request: TaskCommandRequest) => {
    if (syncStatus !== 'online') return;
    if (demoMode) {
      const currentTask = tasks.find((task) => task.id === request.taskId);
      const currentMemberName =
        members.find((member) => member.id === currentMemberId)?.displayName ?? '当前成员';
      setTasks((current) =>
        current.map((task) =>
          task.id === request.taskId
            ? updateDemoTask(task, request, currentMemberId, currentMemberName)
            : task,
        ),
      );
      if (request.name === 'join') {
        setSyncMessage(`已加入协作，负责人仍为${currentTask?.ownerName ?? '原负责人'}`);
      }
      if (request.name === 'request-transfer') {
        setSyncMessage(`接手请求已发送，负责人仍为${currentTask?.ownerName ?? '原负责人'}`);
      }
      if (request.name === 'complete') {
        setCompletionNotice(true);
        window.setTimeout(() => setCompletionNotice(false), 1200);
        setSelectedId(null);
      }
      return;
    }
    try {
      const command = buildServerTaskCommand(request, crypto.randomUUID(), currentMemberId);
      const result = await controllerRef.current?.execute(request.taskId, command);
      if (request.name === 'join') {
        setSyncMessage(`已加入协作，负责人仍为${result?.task.ownerName ?? '原负责人'}`);
      }
      if (request.name === 'request-transfer') {
        setSyncMessage(`接手请求已发送，负责人仍为${result?.task.ownerName ?? '原负责人'}`);
      }
      if (request.name === 'complete') {
        setCompletionNotice(true);
        window.setTimeout(() => setCompletionNotice(false), 1200);
        setSelectedId(null);
      }
    } catch (error) {
      setSyncMessage(error instanceof Error ? error.message : '任务命令执行失败');
    }
  };

  const saveDraft = async (draft: TaskDraft) => {
    const existing = editingTask === 'new' ? null : editingTask;
    if (demoMode) {
      const owner = members.find((member) => member.id === draft.ownerId) ?? null;
      const collaboratorNames = draft.collaboratorIds
        .map((id) => members.find((member) => member.id === id)?.displayName)
        .filter((name): name is string => name !== undefined);
      if (existing === null) {
        const id = crypto.randomUUID();
        setTasks((current) => {
          const prerequisites = draft.prerequisiteTaskIds
            .map((prerequisiteId) => current.find((task) => task.id === prerequisiteId))
            .filter((task): task is TaskItem => task !== undefined)
            .map((task) => ({ taskId: task.id, title: task.title, status: task.status }));
          return [
            ...current,
            {
              id,
              title: draft.title,
              description: draft.description,
              definitionOfDone: draft.definitionOfDone,
              status: 'TODO',
              actionLevel: 'NEXT',
              actionReason: '新建任务，等待服务端行动等级计算',
              importance: draft.importance,
              workstreamId: draft.workstreamId,
              workstreamName:
                current.find((task) => task.workstreamId === draft.workstreamId)?.workstreamName ??
                '默认工作流',
              ownerId: draft.ownerId,
              ownerName: owner?.displayName ?? null,
              collaboratorIds: draft.collaboratorIds,
              collaboratorNames,
              dueAt: draft.dueAt,
              manualBlock: null,
              prerequisites,
              incompletePrerequisites: prerequisites.filter((task) => task.status !== 'DONE'),
              dependents: [],
              externalReferences: [],
              timeline: [
                {
                  id: crypto.randomUUID(),
                  text: '创建任务',
                  actorName: '艾达',
                  occurredAt: new Date().toISOString(),
                },
              ],
              version: 1,
              stableOrder: current.length,
              updatedAt: new Date().toISOString(),
              archivedAt: null,
            },
          ];
        });
      } else {
        setTasks((current) => {
          const prerequisites = draft.prerequisiteTaskIds
            .map((prerequisiteId) => current.find((task) => task.id === prerequisiteId))
            .filter((task): task is TaskItem => task !== undefined)
            .map((task) => ({ taskId: task.id, title: task.title, status: task.status }));
          return current.map((task) =>
            task.id === existing.id
              ? {
                  ...task,
                  title: draft.title,
                  description: draft.description,
                  definitionOfDone: draft.definitionOfDone,
                  importance: draft.importance,
                  dueAt: draft.dueAt,
                  ownerId: draft.ownerId,
                  ownerName: owner?.displayName ?? null,
                  collaboratorIds: draft.collaboratorIds,
                  collaboratorNames,
                  workstreamId: draft.workstreamId,
                  prerequisites,
                  incompletePrerequisites: prerequisites.filter(
                    (prerequisite) => prerequisite.status !== 'DONE',
                  ),
                  version: task.version + 1,
                  updatedAt: new Date().toISOString(),
                }
              : task,
          );
        });
      }
      setTaskFormError(null);
      setEditingTask(null);
      return;
    }

    try {
      const controller = controllerRef.current;
      if (controller === null) return;
      if (existing === null) {
        let result = await controller.create(buildCreateTaskInput(draft, crypto.randomUUID()));
        for (const prerequisiteTaskId of draft.prerequisiteTaskIds) {
          result = await controller.execute(
            result.task.id,
            ServerTaskCommandSchema.parse({
              type: 'AddDependency',
              commandId: crypto.randomUUID(),
              expectedVersion: result.task.version,
              prerequisiteTaskId,
            }),
          );
        }
      } else {
        let result = await controller.execute(
          existing.id,
          buildUpdateTaskCommand(draft, existing.version, crypto.randomUUID()),
        );
        if (draft.importance !== existing.importance) {
          result = await controller.execute(
            existing.id,
            ServerTaskCommandSchema.parse({
              type: 'SetImportance',
              commandId: crypto.randomUUID(),
              expectedVersion: result.task.version,
              importance: draft.importance,
            }),
          );
        }
        if (draft.ownerId !== null && draft.ownerId !== existing.ownerId) {
          result = await controller.execute(
            existing.id,
            ServerTaskCommandSchema.parse({
              type: 'TransferOwner',
              commandId: crypto.randomUUID(),
              expectedVersion: result.task.version,
              ownerId: draft.ownerId,
            }),
          );
        }
        const collaboratorCommands = [
          ...draft.collaboratorIds
            .filter((id) => !existing.collaboratorIds.includes(id))
            .map((userId) => ({ type: 'AddCollaborator' as const, userId })),
          ...existing.collaboratorIds
            .filter((id) => !draft.collaboratorIds.includes(id))
            .map((userId) => ({ type: 'RemoveCollaborator' as const, userId })),
        ];
        for (const collaboratorCommand of collaboratorCommands) {
          result = await controller.execute(
            existing.id,
            ServerTaskCommandSchema.parse({
              ...collaboratorCommand,
              commandId: crypto.randomUUID(),
              expectedVersion: result.task.version,
            }),
          );
        }
        const existingPrerequisiteIds = existing.prerequisites.map(
          (prerequisite) => prerequisite.taskId,
        );
        const dependencyCommands = buildDependencyMutations(
          existingPrerequisiteIds,
          draft.prerequisiteTaskIds,
        );
        for (const dependencyCommand of dependencyCommands) {
          result = await controller.execute(
            existing.id,
            ServerTaskCommandSchema.parse({
              ...dependencyCommand,
              commandId: crypto.randomUUID(),
              expectedVersion: result.task.version,
            }),
          );
        }
      }
      setTaskFormError(null);
      setEditingTask(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : '保存任务失败';
      setTaskFormError(message);
      setSyncMessage(message);
    }
  };

  const login = async (email: string, password: string) => {
    await authenticationClient.login(email, password);
    const authenticatedMemberId = RUNTIME_SECURE_SESSION.getAccountId();
    if (authenticatedMemberId === null) throw new Error('登录会话格式无效，请重新登录。');
    setCurrentMemberId(authenticatedMemberId);
    setAuthenticationNotice(null);
    setWorkspaceStatus('loading');
    setWorkspaceDiscoveryAttempt((attempt) => attempt + 1);
    setSyncStatus('recovering');
    setSyncMessage('正在同步团队任务');
    setAuthenticationStatus('authenticated');
    await publishNativeAuthState('authenticated').catch(() => undefined);
  };

  const logout = async () => {
    // Hide the authenticated workspace before waiting for the network revoke.
    resetAuthenticatedUiState();
    setAuthenticationNotice(null);
    setAuthenticationStatus('required');
    try {
      await authenticationClient.logout();
    } catch (error) {
      setAuthenticationNotice(error instanceof Error ? error.message : '本机会话清理未完全完成。');
    } finally {
      await publishNativeAuthState('cleared').catch(() => undefined);
    }
  };

  const changeAutostart = async (enabled: boolean) => {
    setDesktopSettingPending('autostart');
    setDesktopSettingMessage(null);
    try {
      const saved = await setAutostartEnabled(enabled);
      if (saved !== null) setPreferences(saved);
      else setPreferences((current) => ({ ...current, autostart: enabled }));
    } catch (error) {
      setDesktopSettingMessage(
        error instanceof Error ? error.message : 'Windows 未能更新开机启动设置',
      );
    } finally {
      setDesktopSettingPending((current) => (current === 'autostart' ? null : current));
    }
  };

  const changeGlobalShortcut = async (shortcut: string) => {
    setDesktopSettingPending('globalShortcut');
    setDesktopSettingMessage(null);
    try {
      const status = await setGlobalShortcut(shortcut);
      setShortcutStatus(status);
      if (status?.issue !== null && status?.issue !== undefined) {
        setDesktopSettingMessage('该快捷键不可用，番薯叶已保留原快捷键。');
      }
    } catch (error) {
      setDesktopSettingMessage(error instanceof Error ? error.message : '全局快捷键更新失败');
      const current = await getGlobalShortcutStatus().catch(() => null);
      if (current !== null) setShortcutStatus(current);
    } finally {
      setDesktopSettingPending((current) => (current === 'globalShortcut' ? null : current));
    }
  };

  const syncView: SyncViewState = {
    status: syncStatus,
    lastSyncedAt,
    ...(syncMessage === null ? {} : { message: syncMessage }),
  };

  if (usabilityStudyMode) return <UsabilityStudyHarness />;

  if (windowKind === 'overlay' && overlay.mode === 'collapsed') {
    return (
      <main className="fy-overlay-collapsed">
        <TaskPlantOverlay
          tasks={activeTasks}
          privacyMode={preferences.privacyMode}
          reducedMotion={preferences.reducedMotion}
          onOpen={overlay.open}
          onSelectTask={(task) => {
            setSelectedId(task.id);
            overlay.open();
          }}
        />
      </main>
    );
  }

  if (!demoMode && authenticationStatus === 'restoring') {
    return (
      <main className="fy-login-shell">
        {windowKind === 'main' && <DesktopWindowControls />}
        <section className="fy-login-panel" role="status" aria-live="polite">
          <div className="fy-login-panel__mark" aria-hidden="true">
            叶
          </div>
          <h1>正在恢复安全会话</h1>
          <p>番薯叶正在从 Windows 安全凭据存储恢复登录。</p>
        </section>
      </main>
    );
  }

  if (!demoMode && authenticationStatus === 'required') {
    const loginPanel = (
      <LoginPanel
        onLogin={login}
        notice={authenticationNotice}
        windowControls={windowKind === 'main' ? <DesktopWindowControls /> : null}
      />
    );
    if (windowKind === 'overlay') {
      return (
        <main
          className={`fy-overlay-window fy-overlay-window--${overlay.mode}`}
          onClickCapture={() => {
            if (overlay.mode === 'preview') overlay.open();
          }}
        >
          <div className="fy-overlay-shell">
            {loginPanel}
            {overlay.mode === 'pinned' && (
              <button className="fy-unpin-button" type="button" onClick={overlay.close}>
                收起 · Esc
              </button>
            )}
          </div>
        </main>
      );
    }
    return loginPanel;
  }

  if (!demoMode && workspaceStatus === 'loading') {
    return (
      <main className="fy-login-shell">
        {windowKind === 'main' && <DesktopWindowControls />}
        <section className="fy-login-panel" role="status" aria-live="polite">
          <div className="fy-login-panel__mark" aria-hidden="true">
            叶
          </div>
          <h1>正在载入团队空间</h1>
          <p>正在读取你有权访问的任务树。</p>
        </section>
      </main>
    );
  }

  if (!demoMode && workspaceStatus === 'error') {
    return (
      <main className="fy-login-shell">
        {windowKind === 'main' && <DesktopWindowControls />}
        <section className="fy-login-panel" role="alert">
          <h1>团队空间暂时不可用</h1>
          <p>{workspaceMessage ?? '请检查网络后重试。'}</p>
          <button
            className="fy-button fy-button--primary"
            type="button"
            onClick={() => setWorkspaceDiscoveryAttempt((attempt) => attempt + 1)}
          >
            重新读取
          </button>
        </section>
      </main>
    );
  }

  if (!demoMode && workspaceStatus === 'empty') {
    return (
      <main className="fy-login-shell">
        {windowKind === 'main' && <DesktopWindowControls />}
        <section className="fy-login-panel" role="status">
          <h1>还没有可用的团队空间</h1>
          <p>请让团队管理员邀请你，或先在管理端创建团队空间。</p>
          <button className="fy-button" type="button" onClick={() => void logout()}>
            退出登录
          </button>
        </section>
      </main>
    );
  }

  if (!demoMode && workspaceStatus === 'select') {
    return (
      <main className="fy-login-shell">
        {windowKind === 'main' && <DesktopWindowControls />}
        <section className="fy-login-panel" aria-labelledby="workspace-picker-title">
          <span className="fy-eyebrow">选择任务树</span>
          <h1 id="workspace-picker-title">进入哪个团队空间？</h1>
          {workspaceMessage !== null && <p>{workspaceMessage}</p>}
          <div className="fy-workspace-list">
            {availableWorkspaces.map((workspace) => (
              <button
                type="button"
                key={workspace.id}
                onClick={() => {
                  setSelectedWorkspaceId(workspace.id);
                  void commitDesktopPreference('selectedWorkspaceId', workspace.id);
                  setWorkspaceStatus('ready');
                }}
              >
                <strong>{workspace.name}</strong>
                <small>
                  {workspace.tree.name} · {workspace.role === 'ADMIN' ? '管理员' : '成员'}
                </small>
              </button>
            ))}
          </div>
          <button className="fy-button" type="button" onClick={() => void logout()}>
            退出登录
          </button>
        </section>
      </main>
    );
  }

  const content = (
    <>
      <header className="fy-app-header">
        <button
          className="fy-brand"
          type="button"
          onClick={() => setView('tree')}
          aria-label="番薯叶首页"
        >
          <span className="fy-brand__mark" aria-hidden="true">
            叶
          </span>
          <span>
            <strong>番薯叶</strong>
            <small>开发组任务态势</small>
          </span>
        </button>
        <nav aria-label="主要视图">
          <button
            type="button"
            aria-current={view === 'tree' ? 'page' : undefined}
            onClick={() => {
              setListScope(null);
              setView('tree');
            }}
          >
            任务树
          </button>
          <button
            type="button"
            aria-current={view === 'list' ? 'page' : undefined}
            onClick={() => {
              setListScope(null);
              setView('list');
            }}
          >
            列表
          </button>
        </nav>
        <div className="fy-app-header__actions">
          <SyncStatusBanner state={syncView} />
          <label className="fy-my-toggle">
            <input
              type="checkbox"
              checked={onlyMine}
              onChange={(event) => setOnlyMine(event.currentTarget.checked)}
            />
            <span>我的任务</span>
          </label>
          <button
            className="fy-header-button fy-header-button--primary"
            type="button"
            disabled={syncStatus !== 'online'}
            onClick={() => {
              setTaskFormError(null);
              setEditingTask('new');
            }}
          >
            + 新任务
          </button>
          <button
            className="fy-header-button"
            type="button"
            aria-expanded={settingsOpen}
            onClick={() => {
              if (!settingsOpen) setDesktopSettingMessage(null);
              setSettingsOpen((value) => !value);
            }}
          >
            设置
          </button>
          {windowKind === 'overlay' && (
            <button
              className="fy-header-button"
              type="button"
              onClick={() => void showMainWindow()}
            >
              完整面板
            </button>
          )}
          {windowKind === 'main' && <DesktopWindowControls placement="header" />}
        </div>
      </header>

      {settingsOpen && (
        <aside className="fy-settings-popover" aria-label="桌面偏好">
          <label>
            <input
              type="checkbox"
              checked={preferences.privacyMode}
              disabled={desktopSettingPending !== null}
              onChange={(event) =>
                void commitDesktopPreference('privacyMode', event.currentTarget.checked)
              }
            />
            <span>
              <strong>隐私模式</strong>
              <small>隐藏任务标题与人员文字</small>
            </span>
          </label>
          <label>
            <input
              type="checkbox"
              checked={preferences.doNotDisturb}
              disabled={desktopSettingPending !== null}
              onChange={(event) =>
                void commitDesktopPreference('doNotDisturb', event.currentTarget.checked)
              }
            />
            <span>
              <strong>勿扰时段</strong>
              <small>22:00–08:00 静默系统任务通知</small>
            </span>
          </label>
          <label>
            <input
              type="checkbox"
              checked={preferences.reducedMotion}
              disabled={desktopSettingPending !== null}
              onChange={(event) =>
                void commitDesktopPreference('reducedMotion', event.currentTarget.checked)
              }
            />
            <span>
              <strong>减少动画</strong>
              <small>使用静态叶脉和完成反馈</small>
            </span>
          </label>
          <label>
            <input
              type="checkbox"
              checked={preferences.autostart}
              disabled={desktopSettingPending !== null}
              onChange={(event) => void changeAutostart(event.currentTarget.checked)}
            />
            <span>
              <strong>开机启动</strong>
              <small>登录 Windows 后恢复托盘入口</small>
            </span>
          </label>
          <label className="fy-settings-field">
            <span>
              <strong>悬浮边缘</strong>
              <small>任务树靠屏幕哪一侧停靠</small>
            </span>
            <select
              aria-label="悬浮边缘"
              value={preferences.edge}
              disabled={desktopSettingPending !== null}
              onChange={(event) =>
                void commitDesktopPreference(
                  'edge',
                  event.currentTarget.value === 'left' ? 'left' : 'right',
                )
              }
            >
              <option value="right">右侧</option>
              <option value="left">左侧</option>
            </select>
          </label>
          {hasNativeDesktopRuntime() && (
            <>
              <label className="fy-settings-field">
                <span>
                  <strong>首选显示器</strong>
                  <small>拔插后会自动回到可见工作区</small>
                </span>
                <select
                  aria-label="首选显示器"
                  value={preferences.preferredMonitor ?? ''}
                  disabled={desktopSettingPending !== null}
                  onChange={(event) =>
                    void commitDesktopPreference(
                      'preferredMonitor',
                      event.currentTarget.value || null,
                    )
                  }
                >
                  <option value="">自动选择</option>
                  {nativeMonitors.map((monitor) => (
                    <option value={monitor.key} key={monitor.key}>
                      {monitor.label}
                      {monitor.primary ? ' · 主显示器' : ''}
                    </option>
                  ))}
                </select>
              </label>
              <label className="fy-settings-field">
                <span>
                  <strong>全局快捷键</strong>
                  <small>从编辑器中直接显示任务树速览</small>
                </span>
                <select
                  aria-label="全局快捷键"
                  value={shortcutStatus?.activeShortcut ?? ''}
                  disabled={desktopSettingPending !== null}
                  onChange={(event) => void changeGlobalShortcut(event.currentTarget.value)}
                >
                  {shortcutStatus?.activeShortcut === null && <option value="">当前不可用</option>}
                  <option value="Control+Alt+Space">Ctrl + Alt + Space</option>
                  <option value="Control+Shift+Space">Ctrl + Shift + Space</option>
                  <option value="Alt+Shift+Space">Alt + Shift + Space</option>
                </select>
              </label>
            </>
          )}
          {desktopSettingMessage !== null && (
            <div className="fy-inline-alert" role="status">
              {desktopSettingMessage}
            </div>
          )}
          {!demoMode && (
            <button className="fy-header-button" type="button" onClick={() => void logout()}>
              安全退出登录
            </button>
          )}
        </aside>
      )}

      <div className={`fy-app-body${selected !== null ? ' fy-app-body--detail' : ''}`}>
        <section className="fy-app-content">
          {view === 'tree' ? (
            <TaskTree
              tasks={tasks}
              maximumVisible={windowKind === 'overlay' ? 12 : 15}
              privacyMode={preferences.privacyMode}
              reducedMotion={preferences.reducedMotion}
              {...(selectedId === null ? {} : { selectedTaskId: selectedId })}
              {...(onlyMine ? { onlyMyTaskIds: myTaskIds } : {})}
              onSelectTask={(task) => {
                setSelectedId(task.id);
                if (windowKind === 'overlay') overlay.open();
              }}
              onClusterClick={(overflowTasks) => {
                setListScope(new Set(overflowTasks.map((task) => task.id)));
                setView('list');
                if (windowKind === 'overlay') overlay.open();
              }}
            />
          ) : (
            <TaskList
              tasks={tasks}
              currentMemberId={currentMemberId}
              privacyMode={preferences.privacyMode}
              {...(listScope === null ? {} : { initialTaskIds: listScope })}
              onSelectTask={(task) => setSelectedId(task.id)}
            />
          )}
        </section>
        {selected !== null && (
          <div className="fy-app-detail-drawer">
            <TaskDetailPanel
              task={selected}
              online={syncStatus === 'online'}
              currentMemberId={currentMemberId}
              privacyMode={preferences.privacyMode}
              {...(syncStatus === 'conflict' && syncMessage !== null
                ? { conflictMessage: syncMessage }
                : {})}
              onClose={() => setSelectedId(null)}
              onEdit={(task) => {
                setTaskFormError(null);
                setEditingTask(task);
              }}
              onCommand={(request) => void runCommand(request)}
            />
          </div>
        )}
      </div>

      {editingTask !== null && !preferences.privacyMode && (
        <div
          className="fy-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setTaskFormError(null);
              setEditingTask(null);
            }
          }}
        >
          <TaskForm
            {...(editingTask === 'new' ? {} : { task: editingTask })}
            tasks={tasks}
            members={members}
            online={syncStatus === 'online'}
            {...(taskFormError === null ? {} : { submissionError: taskFormError })}
            onCancel={() => {
              setTaskFormError(null);
              setEditingTask(null);
            }}
            onSubmit={(draft) => void saveDraft(draft)}
            validateDependency={(candidateTaskId) => {
              if (editingTask === 'new') return null;
              if (wouldCreateDependencyCycle(tasks, editingTask.id, candidateTaskId)) {
                return '这个依赖会形成直接或间接环，请调整方向。';
              }
              return null;
            }}
          />
        </div>
      )}

      {completionNotice && (
        <div
          className={`fy-completion-feedback${preferences.reducedMotion ? ' fy-completion-feedback--static' : ''}`}
          role="status"
        >
          <span aria-hidden="true">◆</span>
          任务已完成并移入历史
        </div>
      )}
    </>
  );

  if (windowKind === 'overlay') {
    return (
      <main
        className={`fy-overlay-window fy-overlay-window--${overlay.mode}`}
        onClickCapture={() => {
          if (overlay.mode === 'preview') overlay.open();
        }}
      >
        <div className="fy-overlay-shell">
          {content}
          {overlay.mode === 'pinned' && (
            <button className="fy-unpin-button" type="button" onClick={overlay.close}>
              收起 · Esc
            </button>
          )}
        </div>
      </main>
    );
  }

  return (
    <main className={`fy-main-window${preferences.reducedMotion ? ' fy-reduced-motion' : ''}`}>
      {content}
    </main>
  );
}
