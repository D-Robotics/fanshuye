/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_WS_URL?: string;
  readonly VITE_WORKSPACE_ID?: string;
  readonly VITE_DEMO_MODE?: string;
  readonly VITE_ACCESS_TOKEN?: string;
  readonly VITE_CURRENT_MEMBER_ID?: string;
}

interface Window {
  __TAURI_INTERNALS__?: unknown;
}
