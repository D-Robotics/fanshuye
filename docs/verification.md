# MVP verification record

Last verified: 2026-08-27 (Asia/Shanghai)

This record maps every checked OpenSpec task to implementation or executable evidence. A task stays unchecked when its acceptance condition requires a native Windows environment, signing material, or a human exercise that has not actually run.

## Final automated gate

The following commands completed successfully from the repository root:

```powershell
$env:TEST_DATABASE_URL='postgres://fanshuye:fanshuye@127.0.0.1:5432/fanshuye'
pnpm check
pnpm perf:baseline
openspec validate build-fanshuye-desktop-mvp --type change --strict --json
```

`pnpm check` covered Prettier, ESLint, all TypeScript checks, unit/component/integration tests, production web and server builds, a plain-Node import of the compiled server bundle, and the automated MVP-scope guard. Results:

- contracts: 11 passed
- domain: 95 passed
- desktop application, authentication, native bridge and sync controller: 91 passed
- shared UI: 29 passed; the opt-in performance scenario was skipped in the ordinary suite
- server: 47 passed; the opt-in performance scenario was skipped in the ordinary suite
- total ordinary gate: 273 passed, 2 opt-in performance scenarios skipped

Both skipped scenarios then passed through `pnpm perf:baseline`. The final run measured a 0.466 ms UI p95 while aggregating 1,000 total/100 active tasks into 15 leaves, and an 11.147 ms PostgreSQL dependency-query p95 over 1,000 tasks and 999 edges. Node-limit truncation and the 500 ms statement timeout were both observed as designed.

The real-network synchronization test reported 43.039 ms from client A's command submission until client B received the event and refreshed the authoritative projection. After client B disconnected at cursor 4, it recovered sequences 5 and 6 and resumed at cursor 6.

Rust formatting, tests, locked metadata resolution and the full native release build passed using the installed Rust and Windows toolchains:

```powershell
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked
cargo metadata --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --no-deps --format-version 1
pnpm --filter @fanshuye/desktop build:native
```

All 26 native Rust tests passed. The build used Visual Studio Build Tools 2022 17.14.39, MSVC 14.44.35207, Windows SDK 10.0.26100.0, Rust 1.98.0 and WebView2 Runtime 151.0.4129.107. It produced the release executable and the NSIS installer `番薯叶_0.1.0_x64-setup.exe`. The installer inspection correctly reports `NotSigned`; release signing remains a separate unchecked gate.

The compiled release desktop process and the development server were also started simultaneously. While the desktop process was running, `GET http://127.0.0.1:4310/health` returned HTTP 200 with status `ok`; both processes then stopped cleanly. This completes the native/server startup requirement in task 1.2.

OpenSpec strict validation returned `valid: true` with no issues.

## PostgreSQL and operational evidence

PostgreSQL 17.11 is healthy on `127.0.0.1:5432`. Database-backed tests use isolated schemas and cover clean migration, authentication, workspace isolation, semantic commands, idempotency, transaction rollback, conflicts, concurrent claim, dependency cycles, security revocation, real WebSocket delivery, and cursor recovery.

The custom-format backup/restore drill passed with matching source and restored fingerprints and no drill databases or archives left behind. Raw evidence is recorded in `docs/evidence/postgres-backup-restore-drill-2026-08-26.md`.

An independent verifier who did not implement the application followed the documentation from an empty isolated PostgreSQL volume. They completed install, configuration import, migration, seed, server and Web UI startup, observed `/health` as `ok/ready`, loaded the task tree without browser-console errors, and then verified the compiled server with login, workspace lookup, a schema-version-1 snapshot containing seven tasks, and logout. The isolated container, volume, environment file, database, and listeners were removed afterward.

## OpenSpec completion evidence

| OpenSpec task | Evidence                                                                                                                                                                                                                                                                    |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.1           | Root pnpm workspace and five implementation packages; full `pnpm check` passed.                                                                                                                                                                                             |
| 1.2           | Compiled Tauri release shell and development server ran simultaneously; the exact desktop process stayed alive while `/health` returned HTTP 200 `ok`, then both stopped cleanly.                                                                                           |
| 1.3           | `compose.yaml`, migration runner and isolated-schema helpers; migration and real PostgreSQL suites passed.                                                                                                                                                                  |
| 1.4           | TypeScript, ESLint, Prettier, Rustfmt, precommit and CI configuration; all available checks plus Rust format/metadata passed.                                                                                                                                               |
| 1.5           | Root/server environment examples, Zod configuration and `config.test.ts`; readable missing-secret and production-email failures passed.                                                                                                                                     |
| 1.6           | `.github/workflows/ci.yml` runs database/static/test gates and a Windows native build job.                                                                                                                                                                                  |
| 1.7           | `architecture.test.ts` locks module/table ownership, read/write exceptions, service imports and dependency ports; the server suite passed.                                                                                                                                  |
| 1.8           | `docs/mvp-scope.md` and `check-mvp-scope.mjs`; automated scope review passed.                                                                                                                                                                                               |
| 2.1–2.2       | `0001_initial.sql` plus migration-contract and PostgreSQL integration tests cover UUID entities, constraints, sessions, workspaces, tasks, dependencies, events and sync sequences.                                                                                         |
| 2.3           | Auth service, Argon2id parameters, single-use refresh rotation/revocation and production Resend adapter; config/fake-provider/real-PostgreSQL tests prove verification, rollback and secret-safe errors.                                                                    |
| 2.4–2.6       | Workspace service and PostgreSQL integration tests cover invitations, roles, removal, isolation and atomic default tree/workstream creation with injected rollback.                                                                                                         |
| 2.7           | Idempotent fixed-ID seed contains unowned, in-progress, review, manual-blocked, dependency-blocked, overdue and completed fixtures; independent seed/start passed.                                                                                                          |
| 3.1–3.9       | Domain aggregate, state machine, blocking, priority and duplicate search; all 95 domain tests passed, including the full transition matrix and no-op idempotency.                                                                                                           |
| 4.1–4.6, 4.9  | Dependency ports, PostgreSQL repository and task projection/service; real-database tests cover validation, bounded recursive queries, direct/indirect/concurrent cycles, blocking and dependency events.                                                                    |
| 4.7–4.8       | Dependency completion recalculation and bounded one-level priority propagation are covered by domain and PostgreSQL tests.                                                                                                                                                  |
| 5.1           | Shared command/query/response/error/event wire schemas and runtime parsing; all 11 contract tests passed.                                                                                                                                                                   |
| 5.2–5.10      | Task service, processed-command replay, semantic commands, audit events, history and external references; PostgreSQL and command-idempotency tests cover replay misuse, concurrency, permissions and safe URLs.                                                             |
| 6.1–6.4       | Audit sequence allocator, snapshot/delta service and authenticated workspace-isolated EventHub; PostgreSQL/EventHub/security tests passed.                                                                                                                                  |
| 6.5–6.10      | Desktop snapshot/realtime/delta controller, transactional SQLite cache and read-only offline recovery; the 91-test desktop suite passed.                                                                                                                                    |
| 6.11          | `realtime-network.integration.test.ts` used two REST/WebSocket clients and PostgreSQL: 43.039 ms visibility, sequences 5/6 recovered after disconnect, cursor advanced 4→6.                                                                                                 |
| 7.8           | A continuous 30-minute hidden native run produced 125 post-warmup samples: 0.0048% average CPU, 0.0269% P95 CPU, 26.559 MB working-set growth and zero established TCP connections; evidence SHA-256 is `a196b73a435bcf70567ad5bae98e3de9a71a7e22d9212516307995cc8f09b98f`. |
| 8.1–8.8       | Deterministic SVG tree, card, detail/list/form and clustering surfaces; UI and desktop suites cover no-avatar rendering, filtering, privacy and duplicate suggestions.                                                                                                      |
| 8.9           | Shared semantic claim/collaborate/takeover commands and permission-aware controls; contract, server, UI and desktop tests passed.                                                                                                                                           |
| 8.10          | Direct prerequisite display, selected-task dependency edges, ordered add/remove mutations and transitive client/server cycle errors; component/desktop/PostgreSQL tests passed.                                                                                             |
| 8.11          | One-time completion feedback, active-tree removal and history rendering; desktop and list tests passed.                                                                                                                                                                     |
| 8.12          | Deterministic keyboard activation, focus/ARIA labels, forced colors, grayscale-safe symbols and reduced motion; component accessibility tests passed.                                                                                                                       |
| 9.1–9.2       | REST/WebSocket/IPC validation, bounds and rate limits plus inert text/safe-link rendering; security and component tests passed.                                                                                                                                             |
| 9.3, 9.7      | Real API/WebSocket security tests cover role change, removal, logout, explicit revoke, malicious Origin/protocol and the documented threat model; high/critical threats are closed.                                                                                         |
| 9.4           | Safe structured logging and UUID correlation IDs; logging tests prove credentials, task text and local paths are redacted.                                                                                                                                                  |
| 9.5           | Command/conflict/sync/connection/dependency metrics and bounded labels; metrics tests passed.                                                                                                                                                                               |
| 9.6           | Backup/restore script, operations runbook and dated evidence; custom-format restore fingerprint matched and cleanup count was zero.                                                                                                                                         |
| 9.8           | Data-collection declaration, dependency/runtime scan and route/network scope guard confirm no keyboard, screenshot, clipboard, microphone, private-chat or code collection.                                                                                                 |
| 10.1          | The 95-test domain suite plus command-idempotency tests cover state, orthogonal blocking, priority, override, idempotency and dependency rules.                                                                                                                             |
| 10.2          | Isolated PostgreSQL API scenarios cover permissions, rollback, version/claim conflicts and direct/indirect/concurrent cycles.                                                                                                                                               |
| 10.3          | Desktop sync integration covers two controllers, duplicate/out-of-order events, disconnect, gaps, expired cursors and snapshot rebuild.                                                                                                                                     |
| 10.4          | Component/accessibility and structural visual-regression tests cover tree/card/detail/list/privacy/offline surfaces.                                                                                                                                                        |
| 10.6          | `pnpm perf:baseline` passed at 1,000 tasks/100 active/999 dependency edges with bounded UI rendering and PostgreSQL traversal.                                                                                                                                              |
| 10.8          | README, server README, operations and Windows validation manuals cover all required areas; an uninvolved verifier completed clean startup and compiled-server smoke tests from the documents.                                                                               |
| 10.10         | Final `check-mvp-scope.mjs` pass confirms no Agent, automatic progress, Git integration, Neo4j, graph deployment, message queue, offline writes or outbox.                                                                                                                  |
| 10.11         | OpenSpec strict validation returned `valid: true`; this record maps every checked task to executable or independent evidence, and no developer pilot has started.                                                                                                           |

## Implemented native surface awaiting observational evidence

The remaining tasks have not been abandoned. Their repository-side implementation and validation harnesses now include:

- strict production/development CSP separation, a minimal event/SQLite capability file, `main` and `overlay` windows, and transparent/side-panel presentations;
- tray, single instance, visibility commands, rollback-safe configurable shortcuts, authoritative autostart settings and startup-focus protection;
- native/React overlay state synchronization, delayed hover/collapse, click-capable preview without active focus, and focusable pin/Escape behavior;
- work-area-aware placement, persisted monitor/edge choice, monitor unplug recovery and deterministic 100/125/150/200% DPI geometry tests;
- a fixed Windows Credential Manager slot containing a versioned account/refresh envelope, in-memory access credentials, Web Lock rotation, login/workspace selection, 401/WS revocation handling and immediate authenticated-UI clearing;
- native summary notifications, privacy-safe count-only notification content, do-not-disturb, reduced motion, cross-window authoritative preferences and hidden-window animation/polling suspension;
- transparent production icon assets (`icon.svg`, PNG sizes and a multi-frame ICO), native preflight, 20-case E2E evidence validation, signed-installer inspection, six-case release validation, a 30-minute process-tree residency measurement and a 30-task human-study harness.

Automated coverage proves the pure geometry, state machines, validation, rollback policy, browser/native boundary and UI behavior, and the installed native toolchain proves that the Windows application and NSIS bundle compile. On 2026-08-27 the 0.1.1 candidate also passed a real Windows 11 smoke run on the available 2880×1800, 200% DPI display: hover delay, click-to-pin, Escape, global shortcut, single instance, restart, explicit hide/exit, main/overlay mutual exclusion and the forced side-panel presentation. The run exposed and fixed two production-only defects: the always-on-top overlay covered the main-window exit controls, and the unauthenticated preview bypassed the overlay click-to-pin shell. Detailed observations are in `docs/evidence/windows-local-smoke-2026-08-27.json`.

The installer now uses current-user mode for the developer pilot. This corporate host blocks unsigned NSIS setup executables before process creation with Win32 error 1223 even though it permits the standalone unsigned application executable. A fail-closed Authenticode signing command now requires an external signer subject, an installed code-signing certificate/private key, an HTTPS timestamp, successful `signtool` verification and a trusted timestamp. No suitable certificate is installed, so the unavailable physical display/DPI/network cases and signed installation lifecycle remain open.

The 30-minute hidden-process evidence is recorded in `docs/evidence/windows-hidden-residency-2026-08-27.json` and independently recomputed from its raw samples before task 7.8 was checked. The sampler now prevents automatic system sleep and fails closed on missing samples or excessive gaps after an earlier interrupted attempt exposed that risk. The full native evidence manifest and all 6 release cases remain incomplete because the other physical observations and signing trust anchor do not yet exist. The native matrix includes an explicit Windows Credential Manager/isolation case, requires case-specific notes, rejects text files and false media extensions, and accepts resource evidence only when it is a passing 30-minute measurement JSON. The usability prerequisite suite passed 3/3, but its result deliberately remains `OBSERVER_ATTESTATION_REQUIRED`.

Remaining gates are therefore:

- the Windows native E2E matrix (10.5)
- signed installer install/upgrade/uninstall validation (10.7)
- a timed human 30-task developer usability study (10.9)

These gates must remain unchecked until their actual native or human evidence exists.
