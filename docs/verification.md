# MVP verification record

Last verified: 2026-08-26 (Asia/Shanghai)

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

Rust formatting and locked metadata resolution also passed using the installed Rust toolchain:

```powershell
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check
cargo metadata --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --no-deps --format-version 1
```

`cargo check` cannot reach the application crate on this machine: the MSVC Rust target resolves Git's GNU `D:\Git\usr\bin\link.exe`, while Visual Studio Build Tools and the Windows SDK are absent. The failure occurs while linking third-party dependency build scripts, before native application code is compiled. The repository preflight independently reports missing `cl.exe`, the MSVC linker, MSBuild and a Windows SDK; WebView2 151.0.4129.107 and Rust 1.98.0 are present.

OpenSpec strict validation returned `valid: true` with no issues.

## PostgreSQL and operational evidence

PostgreSQL 17.11 is healthy on `127.0.0.1:5432`. Database-backed tests use isolated schemas and cover clean migration, authentication, workspace isolation, semantic commands, idempotency, transaction rollback, conflicts, concurrent claim, dependency cycles, security revocation, real WebSocket delivery, and cursor recovery.

The custom-format backup/restore drill passed with matching source and restored fingerprints and no drill databases or archives left behind. Raw evidence is recorded in `docs/evidence/postgres-backup-restore-drill-2026-08-26.md`.

An independent verifier who did not implement the application followed the documentation from an empty isolated PostgreSQL volume. They completed install, configuration import, migration, seed, server and Web UI startup, observed `/health` as `ok/ready`, loaded the task tree without browser-console errors, and then verified the compiled server with login, workspace lookup, a schema-version-1 snapshot containing seven tasks, and logout. The isolated container, volume, environment file, database, and listeners were removed afterward.

## OpenSpec completion evidence

| OpenSpec task | Evidence                                                                                                                                                                                                        |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.1           | Root pnpm workspace and five implementation packages; full `pnpm check` passed.                                                                                                                                 |
| 1.3           | `compose.yaml`, migration runner and isolated-schema helpers; migration and real PostgreSQL suites passed.                                                                                                      |
| 1.4           | TypeScript, ESLint, Prettier, Rustfmt, precommit and CI configuration; all available checks plus Rust format/metadata passed.                                                                                   |
| 1.5           | Root/server environment examples, Zod configuration and `config.test.ts`; readable missing-secret and production-email failures passed.                                                                         |
| 1.6           | `.github/workflows/ci.yml` runs database/static/test gates and a Windows native build job.                                                                                                                      |
| 1.7           | `architecture.test.ts` locks module/table ownership, read/write exceptions, service imports and dependency ports; the server suite passed.                                                                      |
| 1.8           | `docs/mvp-scope.md` and `check-mvp-scope.mjs`; automated scope review passed.                                                                                                                                   |
| 2.1–2.2       | `0001_initial.sql` plus migration-contract and PostgreSQL integration tests cover UUID entities, constraints, sessions, workspaces, tasks, dependencies, events and sync sequences.                             |
| 2.3           | Auth service, Argon2id parameters, single-use refresh rotation/revocation and production Resend adapter; config/fake-provider/real-PostgreSQL tests prove verification, rollback and secret-safe errors.        |
| 2.4–2.6       | Workspace service and PostgreSQL integration tests cover invitations, roles, removal, isolation and atomic default tree/workstream creation with injected rollback.                                             |
| 2.7           | Idempotent fixed-ID seed contains unowned, in-progress, review, manual-blocked, dependency-blocked, overdue and completed fixtures; independent seed/start passed.                                              |
| 3.1–3.9       | Domain aggregate, state machine, blocking, priority and duplicate search; all 95 domain tests passed, including the full transition matrix and no-op idempotency.                                               |
| 4.1–4.6, 4.9  | Dependency ports, PostgreSQL repository and task projection/service; real-database tests cover validation, bounded recursive queries, direct/indirect/concurrent cycles, blocking and dependency events.        |
| 4.7–4.8       | Dependency completion recalculation and bounded one-level priority propagation are covered by domain and PostgreSQL tests.                                                                                      |
| 5.1           | Shared command/query/response/error/event wire schemas and runtime parsing; all 11 contract tests passed.                                                                                                       |
| 5.2–5.10      | Task service, processed-command replay, semantic commands, audit events, history and external references; PostgreSQL and command-idempotency tests cover replay misuse, concurrency, permissions and safe URLs. |
| 6.1–6.4       | Audit sequence allocator, snapshot/delta service and authenticated workspace-isolated EventHub; PostgreSQL/EventHub/security tests passed.                                                                      |
| 6.5–6.10      | Desktop snapshot/realtime/delta controller, transactional SQLite cache and read-only offline recovery; the 91-test desktop suite passed.                                                                        |
| 6.11          | `realtime-network.integration.test.ts` used two REST/WebSocket clients and PostgreSQL: 43.039 ms visibility, sequences 5/6 recovered after disconnect, cursor advanced 4→6.                                     |
| 8.1–8.8       | Deterministic SVG tree, card, detail/list/form and clustering surfaces; UI and desktop suites cover no-avatar rendering, filtering, privacy and duplicate suggestions.                                          |
| 8.9           | Shared semantic claim/collaborate/takeover commands and permission-aware controls; contract, server, UI and desktop tests passed.                                                                               |
| 8.10          | Direct prerequisite display, selected-task dependency edges, ordered add/remove mutations and transitive client/server cycle errors; component/desktop/PostgreSQL tests passed.                                 |
| 8.11          | One-time completion feedback, active-tree removal and history rendering; desktop and list tests passed.                                                                                                         |
| 8.12          | Deterministic keyboard activation, focus/ARIA labels, forced colors, grayscale-safe symbols and reduced motion; component accessibility tests passed.                                                           |
| 9.1–9.2       | REST/WebSocket/IPC validation, bounds and rate limits plus inert text/safe-link rendering; security and component tests passed.                                                                                 |
| 9.3, 9.7      | Real API/WebSocket security tests cover role change, removal, logout, explicit revoke, malicious Origin/protocol and the documented threat model; high/critical threats are closed.                             |
| 9.4           | Safe structured logging and UUID correlation IDs; logging tests prove credentials, task text and local paths are redacted.                                                                                      |
| 9.5           | Command/conflict/sync/connection/dependency metrics and bounded labels; metrics tests passed.                                                                                                                   |
| 9.6           | Backup/restore script, operations runbook and dated evidence; custom-format restore fingerprint matched and cleanup count was zero.                                                                             |
| 9.8           | Data-collection declaration, dependency/runtime scan and route/network scope guard confirm no keyboard, screenshot, clipboard, microphone, private-chat or code collection.                                     |
| 10.1          | The 95-test domain suite plus command-idempotency tests cover state, orthogonal blocking, priority, override, idempotency and dependency rules.                                                                 |
| 10.2          | Isolated PostgreSQL API scenarios cover permissions, rollback, version/claim conflicts and direct/indirect/concurrent cycles.                                                                                   |
| 10.3          | Desktop sync integration covers two controllers, duplicate/out-of-order events, disconnect, gaps, expired cursors and snapshot rebuild.                                                                         |
| 10.4          | Component/accessibility and structural visual-regression tests cover tree/card/detail/list/privacy/offline surfaces.                                                                                            |
| 10.6          | `pnpm perf:baseline` passed at 1,000 tasks/100 active/999 dependency edges with bounded UI rendering and PostgreSQL traversal.                                                                                  |
| 10.8          | README, server README, operations and Windows validation manuals cover all required areas; an uninvolved verifier completed clean startup and compiled-server smoke tests from the documents.                   |
| 10.10         | Final `check-mvp-scope.mjs` pass confirms no Agent, automatic progress, Git integration, Neo4j, graph deployment, message queue, offline writes or outbox.                                                      |
| 10.11         | OpenSpec strict validation returned `valid: true`; this record maps every checked task to executable or independent evidence, and no developer pilot has started.                                               |

## Implemented native surface awaiting executable evidence

The remaining tasks have not been abandoned. Their repository-side implementation and validation harnesses now include:

- strict production/development CSP separation, a minimal event/SQLite capability file, `main` and `overlay` windows, and transparent/side-panel presentations;
- tray, single instance, visibility commands, rollback-safe configurable shortcuts, authoritative autostart settings and startup-focus protection;
- native/React overlay state synchronization, delayed hover/collapse, pin/Escape behavior, non-focusable preview and focusable pinned mode;
- work-area-aware placement, persisted monitor/edge choice, monitor unplug recovery and deterministic 100/125/150/200% DPI geometry tests;
- a fixed Windows Credential Manager slot containing a versioned account/refresh envelope, in-memory access credentials, Web Lock rotation, login/workspace selection, 401/WS revocation handling and immediate authenticated-UI clearing;
- native summary notifications, privacy-safe count-only notification content, do-not-disturb, reduced motion, cross-window authoritative preferences and hidden-window animation/polling suspension;
- transparent production icon assets (`icon.svg`, PNG sizes and a multi-frame ICO), native preflight, 20-case E2E evidence validation, signed-installer inspection, six-case release validation, a 30-minute process-tree residency measurement and a 30-task human-study harness.

Automated coverage proves the pure geometry, state machines, validation, rollback policy, browser/native boundary and UI behavior. It cannot prove Windows APIs actually accepted a shortcut, autostart entry, notification, credential, focus transition or monitor movement. These tasks therefore remain unchecked because this machine lacks MSVC C++ Build Tools and the Windows SDK, so no native executable can be built. No signing certificate, previous signed release, clean Windows test machine or observed developer participant is available.

The evidence validators were run against their untouched templates and correctly failed closed: all 20 native cases and all 6 release cases remain `not_run`, with no local evidence files or signing trust anchor. The native matrix includes an explicit Windows Credential Manager/isolation case, requires case-specific notes, rejects text files and false media extensions, and accepts resource evidence only when it is a passing 30-minute measurement JSON. The usability prerequisite suite passed 3/3, but its result deliberately remains `OBSERVER_ATTESTATION_REQUIRED`.

Remaining gates are therefore:

- simultaneous native Tauri shell and server startup (1.2)
- native Windows behavior and resource validation (7.1–7.8)
- the Windows native E2E matrix (10.5)
- signed installer install/upgrade/uninstall validation (10.7)
- a timed human 30-task developer usability study (10.9)

These gates must remain unchecked until their actual native or human evidence exists.
