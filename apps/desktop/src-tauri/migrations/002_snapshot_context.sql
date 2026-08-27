CREATE TABLE IF NOT EXISTS snapshot_context_cache (
  workspace_id TEXT PRIMARY KEY NOT NULL,
  payload_json TEXT NOT NULL
);
