CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext NOT NULL UNIQUE,
  display_name varchar(100) NOT NULL CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 100),
  email_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE password_credentials (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  password_hash text NOT NULL CHECK (char_length(password_hash) >= 32),
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE email_verification_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (expires_at > created_at)
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_hash char(64) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  user_agent varchar(500),
  ip_address inet,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (expires_at > created_at)
);

CREATE INDEX sessions_active_user_idx ON sessions(user_id, expires_at) WHERE revoked_at IS NULL;

CREATE TABLE workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(120) NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  timezone varchar(64) NOT NULL DEFAULT 'UTC' CHECK (char_length(btrim(timezone)) > 0),
  graph_version bigint NOT NULL DEFAULT 0 CHECK (graph_version >= 0),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE workspace_memberships (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('ADMIN', 'MEMBER')),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REMOVED')),
  joined_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  removed_at timestamptz,
  PRIMARY KEY (workspace_id, user_id),
  CHECK ((status = 'ACTIVE' AND removed_at IS NULL) OR (status = 'REMOVED' AND removed_at IS NOT NULL))
);

CREATE INDEX workspace_memberships_user_idx ON workspace_memberships(user_id, workspace_id)
  WHERE status = 'ACTIVE';

CREATE TABLE workspace_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email citext NOT NULL,
  role text NOT NULL DEFAULT 'MEMBER' CHECK (role IN ('ADMIN', 'MEMBER')),
  token_hash char(64) NOT NULL UNIQUE,
  invited_by uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (workspace_id, invited_by)
    REFERENCES workspace_memberships(workspace_id, user_id),
  CHECK (expires_at > created_at),
  CHECK (accepted_at IS NULL OR revoked_at IS NULL)
);

CREATE UNIQUE INDEX workspace_invitations_open_email_idx
  ON workspace_invitations(workspace_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE TABLE workspace_sync_state (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  last_sequence bigint NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
  min_retained_sequence bigint NOT NULL DEFAULT 0 CHECK (min_retained_sequence >= 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (min_retained_sequence <= last_sequence)
);

CREATE TABLE task_trees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL UNIQUE REFERENCES workspaces(id) ON DELETE CASCADE,
  name varchar(120) NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (workspace_id, id)
);

CREATE TABLE workstreams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  tree_id uuid NOT NULL,
  name varchar(120) NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (workspace_id, tree_id) REFERENCES task_trees(workspace_id, id) ON DELETE CASCADE,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, name)
);

CREATE TABLE tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  tree_id uuid NOT NULL,
  workstream_id uuid NOT NULL,
  title varchar(240) NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 240),
  description text NOT NULL DEFAULT '' CHECK (octet_length(description) <= 100000),
  definition_of_done text NOT NULL DEFAULT '' CHECK (octet_length(definition_of_done) <= 50000),
  owner_id uuid,
  status text NOT NULL DEFAULT 'TODO' CHECK (status IN ('TODO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE', 'CANCELED')),
  manual_block_type varchar(60),
  manual_block_reason text,
  importance smallint NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
  due_at timestamptz,
  action_override text CHECK (action_override IN ('NOW', 'NEXT', 'LATER')),
  action_override_reason varchar(500),
  action_override_expires_at timestamptz,
  manual_order numeric(20, 6),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  archived_at timestamptz,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (workspace_id, tree_id) REFERENCES task_trees(workspace_id, id),
  FOREIGN KEY (workspace_id, workstream_id) REFERENCES workstreams(workspace_id, id),
  FOREIGN KEY (workspace_id, owner_id) REFERENCES workspace_memberships(workspace_id, user_id),
  FOREIGN KEY (workspace_id, created_by) REFERENCES workspace_memberships(workspace_id, user_id),
  UNIQUE (workspace_id, id),
  CHECK ((manual_block_type IS NULL AND manual_block_reason IS NULL) OR
         (manual_block_type IS NOT NULL AND char_length(btrim(manual_block_type)) > 0 AND
          manual_block_reason IS NOT NULL AND char_length(btrim(manual_block_reason)) > 0)),
  CHECK ((action_override IS NULL AND action_override_reason IS NULL AND action_override_expires_at IS NULL) OR
         (action_override IS NOT NULL AND action_override_reason IS NOT NULL AND
          char_length(btrim(action_override_reason)) > 0 AND action_override_expires_at IS NOT NULL)),
  CHECK ((status IN ('DONE', 'CANCELED') AND archived_at IS NOT NULL) OR
         (status NOT IN ('DONE', 'CANCELED') AND archived_at IS NULL))
);

CREATE INDEX tasks_active_workspace_idx ON tasks(workspace_id, status, due_at, id)
  WHERE archived_at IS NULL;
CREATE INDEX tasks_owner_idx ON tasks(workspace_id, owner_id) WHERE archived_at IS NULL;
CREATE INDEX tasks_title_search_idx ON tasks(workspace_id, lower(title) text_pattern_ops)
  WHERE archived_at IS NULL;

CREATE TABLE task_collaborators (
  workspace_id uuid NOT NULL,
  task_id uuid NOT NULL,
  user_id uuid NOT NULL,
  added_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (task_id, user_id),
  FOREIGN KEY (workspace_id, task_id) REFERENCES tasks(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, user_id) REFERENCES workspace_memberships(workspace_id, user_id),
  FOREIGN KEY (workspace_id, added_by) REFERENCES workspace_memberships(workspace_id, user_id)
);

CREATE INDEX task_collaborators_workspace_idx ON task_collaborators(workspace_id, user_id);

CREATE TABLE task_dependencies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  prerequisite_task_id uuid NOT NULL,
  dependent_task_id uuid NOT NULL,
  relation_type text NOT NULL DEFAULT 'BLOCKS' CHECK (relation_type = 'BLOCKS'),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (workspace_id, prerequisite_task_id) REFERENCES tasks(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, dependent_task_id) REFERENCES tasks(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, created_by) REFERENCES workspace_memberships(workspace_id, user_id),
  UNIQUE (workspace_id, prerequisite_task_id, dependent_task_id),
  CHECK (prerequisite_task_id <> dependent_task_id)
);

CREATE INDEX task_dependencies_prerequisite_idx
  ON task_dependencies(workspace_id, prerequisite_task_id);
CREATE INDEX task_dependencies_dependent_idx
  ON task_dependencies(workspace_id, dependent_task_id);

CREATE TABLE task_external_references (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  task_id uuid NOT NULL,
  reference_type varchar(40) NOT NULL CHECK (char_length(btrim(reference_type)) BETWEEN 1 AND 40),
  display_name varchar(160) NOT NULL CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 160),
  url varchar(2048) NOT NULL CHECK (url ~ '^https?://'),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (workspace_id, task_id) REFERENCES tasks(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, created_by) REFERENCES workspace_memberships(workspace_id, user_id),
  UNIQUE (task_id, url)
);

CREATE TABLE task_events (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workspace_sequence bigint NOT NULL CHECK (workspace_sequence > 0),
  aggregate_type varchar(40) NOT NULL DEFAULT 'Task',
  aggregate_id uuid NOT NULL,
  aggregate_version integer NOT NULL CHECK (aggregate_version >= 0),
  event_type varchar(100) NOT NULL CHECK (char_length(btrim(event_type)) > 0),
  schema_version smallint NOT NULL DEFAULT 1 CHECK (schema_version >= 1),
  actor_type text NOT NULL CHECK (actor_type IN ('human', 'integration', 'agent', 'system')),
  actor_id uuid REFERENCES users(id),
  command_id uuid NOT NULL,
  correlation_id uuid,
  causation_id uuid,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (workspace_id, workspace_sequence)
);

CREATE INDEX task_events_aggregate_idx ON task_events(workspace_id, aggregate_id, workspace_sequence DESC);
CREATE INDEX task_events_occurred_idx ON task_events(workspace_id, occurred_at DESC);

CREATE TABLE processed_commands (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  command_id uuid NOT NULL,
  actor_id uuid NOT NULL REFERENCES users(id),
  command_type varchar(100) NOT NULL,
  response_status smallint NOT NULL CHECK (response_status BETWEEN 200 AND 299),
  response_body jsonb NOT NULL CHECK (jsonb_typeof(response_body) = 'object'),
  processed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT (clock_timestamp() + interval '90 days'),
  PRIMARY KEY (workspace_id, command_id),
  UNIQUE (actor_id, command_id)
);

CREATE INDEX processed_commands_expiry_idx ON processed_commands(expires_at);

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER workspaces_set_updated_at BEFORE UPDATE ON workspaces
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER tasks_set_updated_at BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION reject_task_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'task_events is append-only';
END;
$$;

CREATE TRIGGER task_events_append_only
  BEFORE UPDATE OR DELETE ON task_events
  FOR EACH ROW EXECUTE FUNCTION reject_task_event_mutation();
