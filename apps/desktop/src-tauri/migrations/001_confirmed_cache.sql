PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sync_meta (
  workspace_id TEXT PRIMARY KEY NOT NULL,
  cursor INTEGER NOT NULL CHECK (cursor >= 0),
  captured_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_cache (
  workspace_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 0),
  payload_json TEXT NOT NULL,
  PRIMARY KEY (workspace_id, task_id)
);

CREATE TABLE IF NOT EXISTS member_cache (
  workspace_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  PRIMARY KEY (workspace_id, member_id)
);

CREATE TABLE IF NOT EXISTS dependency_cache (
  workspace_id TEXT NOT NULL,
  prerequisite_task_id TEXT NOT NULL,
  dependent_task_id TEXT NOT NULL,
  PRIMARY KEY (workspace_id, prerequisite_task_id, dependent_task_id),
  CHECK (prerequisite_task_id <> dependent_task_id)
);

CREATE INDEX IF NOT EXISTS task_cache_workspace_version_idx
  ON task_cache (workspace_id, version);

CREATE INDEX IF NOT EXISTS dependency_cache_dependent_idx
  ON dependency_cache (workspace_id, dependent_task_id);
