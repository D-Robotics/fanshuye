import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('threat-model security boundaries', () => {
  it('keeps credentials and offline writes out of the rebuildable SQLite projection', async () => {
    const cacheSources = await Promise.all([
      readWorkspaceFile('../../desktop/src/sync/cache.ts'),
      readWorkspaceFile('../../desktop/src-tauri/migrations/001_confirmed_cache.sql'),
      readWorkspaceFile('../../desktop/src-tauri/migrations/002_snapshot_context.sql'),
    ]);
    const cacheBoundary = cacheSources.join('\n');

    expect(cacheBoundary).not.toMatch(
      /refresh[_A-Z-]?token|access[_A-Z-]?token|password|credential|client[_A-Z-]?secret/i,
    );
    expect(cacheBoundary).not.toMatch(/outbox|pending[_A-Z-]?command|unsent[_A-Z-]?mutation/i);
  });

  it('uses the operating-system keyring for refresh credentials and a fixed desktop CSP', async () => {
    const credentials = await readWorkspaceFile('../../desktop/src-tauri/src/credentials.rs');
    expect(credentials).toContain('keyring::Entry');
    expect(credentials).not.toMatch(/sqlite|localStorage/i);

    const configuration = JSON.parse(
      await readWorkspaceFile('../../desktop/src-tauri/tauri.conf.json'),
    ) as { app: { security: { csp: string } } };
    const csp = configuration.app.security.csp;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toMatch(/(?:^|[ ;])\*(?:[ ;]|$)/);
    expect(csp).not.toMatch(/(?:^|\s)https:(?:\s|;|$)/);
    expect(csp).not.toMatch(/(?:^|\s)wss:(?:\s|;|$)/);
    expect(csp).toContain('https://api.fanshuye.app');
    expect(csp).toContain('wss://api.fanshuye.app');
  });
});

function readWorkspaceFile(relativePath: string): Promise<string> {
  return readFile(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
}
