-- Core entities for Autopilot Console Phase 1
-- Workspace, admin, sessions, projects, releases, features,
-- immutable task approvals, and pull-request identity.

CREATE TABLE IF NOT EXISTS schema_migrations (
	version TEXT PRIMARY KEY,
	applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE workspaces (
	id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
	name TEXT NOT NULL DEFAULT 'default',
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Exactly one implicit workspace is enforced by a unique constant key.
CREATE UNIQUE INDEX workspaces_singleton ON workspaces ((true));

CREATE TABLE admin_accounts (
	id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
	username TEXT NOT NULL,
	password_hash TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT admin_accounts_username_unique UNIQUE (username)
);

CREATE TABLE sessions (
	id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
	admin_account_id UUID NOT NULL REFERENCES admin_accounts (id) ON DELETE CASCADE,
	token_hash TEXT NOT NULL,
	expires_at TIMESTAMPTZ NOT NULL,
	revoked_at TIMESTAMPTZ,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT sessions_token_hash_unique UNIQUE (token_hash)
);

CREATE TYPE project_status AS ENUM ('active', 'archived');
CREATE TYPE release_status AS ENUM ('PLANNED', 'IN_DEVELOPMENT', 'DEVELOPMENT_MERGED');
CREATE TYPE feature_state AS ENUM (
	'PLANNED',
	'TASKS_REVIEW',
	'QUEUED',
	'DEVELOPING',
	'DEVELOPMENT_FAILED',
	'DEVELOPMENT_INTERRUPTED',
	'DEVELOPMENT_CANCELLED',
	'DEVELOPMENT_COMPLETE',
	'PR_CREATING',
	'PR_CREATION_FAILED',
	'CI_RUNNING',
	'CI_FAILED',
	'PR_REVIEW',
	'PR_CHANGES_REQUESTED',
	'DEVELOPMENT_MERGED',
	'BLOCKED'
);
CREATE TYPE pull_request_observed_state AS ENUM ('open', 'closed', 'merged');

CREATE TABLE projects (
	id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
	workspace_id UUID NOT NULL REFERENCES workspaces (id),
	name TEXT NOT NULL,
	slug TEXT NOT NULL,
	description TEXT,
	github_owner TEXT NOT NULL,
	github_repo TEXT NOT NULL,
	canonical_path TEXT NOT NULL,
	development_branch TEXT NOT NULL,
	validation_status TEXT,
	last_validated_at TIMESTAMPTZ,
	status project_status NOT NULL DEFAULT 'active',
	archived_at TIMESTAMPTZ,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Partial unique indexes: uniqueness only among active projects
CREATE UNIQUE INDEX projects_active_name_uidx ON projects (name) WHERE status = 'active';
CREATE UNIQUE INDEX projects_active_slug_uidx ON projects (slug) WHERE status = 'active';
CREATE UNIQUE INDEX projects_active_github_uidx ON projects (github_owner, github_repo) WHERE status = 'active';
CREATE UNIQUE INDEX projects_active_path_uidx ON projects (canonical_path) WHERE status = 'active';

CREATE TABLE releases (
	id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
	project_id UUID NOT NULL REFERENCES projects (id),
	name TEXT NOT NULL,
	version TEXT NOT NULL,
	description TEXT,
	sort_order INTEGER NOT NULL DEFAULT 0,
	status release_status NOT NULL DEFAULT 'PLANNED',
	archived_at TIMESTAMPTZ,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT releases_project_name_version_unique UNIQUE (project_id, name, version)
);

CREATE INDEX releases_project_id_idx ON releases (project_id);

CREATE TABLE features (
	id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
	project_id UUID NOT NULL REFERENCES projects (id),
	release_id UUID NOT NULL REFERENCES releases (id),
	slug TEXT NOT NULL,
	title TEXT NOT NULL,
	summary TEXT,
	state feature_state NOT NULL DEFAULT 'PLANNED',
	branch_name TEXT NOT NULL,
	task_path TEXT,
	row_version INTEGER NOT NULL DEFAULT 1,
	archived_at TIMESTAMPTZ,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT features_project_slug_unique UNIQUE (project_id, slug)
);

CREATE INDEX features_project_id_idx ON features (project_id);
CREATE INDEX features_release_id_idx ON features (release_id);

-- Enforce that feature.release_id belongs to the same project as feature.project_id
CREATE OR REPLACE FUNCTION enforce_feature_release_project()
RETURNS TRIGGER AS $$
DECLARE
	release_project UUID;
BEGIN
	SELECT project_id INTO release_project FROM releases WHERE id = NEW.release_id;
	IF release_project IS NULL THEN
		RAISE EXCEPTION 'release % does not exist', NEW.release_id;
	END IF;
	IF release_project <> NEW.project_id THEN
		RAISE EXCEPTION 'feature project_id % does not match release project_id %', NEW.project_id, release_project;
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER features_release_project_check
	BEFORE INSERT OR UPDATE OF project_id, release_id ON features
	FOR EACH ROW EXECUTE FUNCTION enforce_feature_release_project();

CREATE TABLE task_approvals (
	id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
	project_id UUID NOT NULL REFERENCES projects (id),
	feature_id UUID NOT NULL REFERENCES features (id),
	relative_task_path TEXT NOT NULL,
	checksum TEXT NOT NULL,
	schema_compatibility_version TEXT NOT NULL,
	requirements_snapshot JSONB NOT NULL,
	approved_by_admin_id UUID NOT NULL REFERENCES admin_accounts (id),
	approved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	invalidated_at TIMESTAMPTZ,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	-- Immutability of identity/snapshot columns enforced by trigger
	CONSTRAINT task_approvals_checksum_nonempty CHECK (char_length(checksum) > 0)
);

CREATE INDEX task_approvals_feature_id_idx ON task_approvals (feature_id);
CREATE INDEX task_approvals_project_id_idx ON task_approvals (project_id);

CREATE OR REPLACE FUNCTION enforce_task_approval_hierarchy()
RETURNS TRIGGER AS $$
DECLARE
	feature_project UUID;
BEGIN
	SELECT project_id INTO feature_project FROM features WHERE id = NEW.feature_id;
	IF feature_project IS NULL THEN
		RAISE EXCEPTION 'feature % does not exist', NEW.feature_id;
	END IF;
	IF feature_project <> NEW.project_id THEN
		RAISE EXCEPTION 'task_approval project_id % does not match feature project_id %', NEW.project_id, feature_project;
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER task_approvals_hierarchy_check
	BEFORE INSERT OR UPDATE OF project_id, feature_id ON task_approvals
	FOR EACH ROW EXECUTE FUNCTION enforce_task_approval_hierarchy();

CREATE OR REPLACE FUNCTION prevent_task_approval_mutation()
RETURNS TRIGGER AS $$
BEGIN
	IF TG_OP = 'UPDATE' THEN
		IF NEW.checksum IS DISTINCT FROM OLD.checksum
			OR NEW.requirements_snapshot IS DISTINCT FROM OLD.requirements_snapshot
			OR NEW.relative_task_path IS DISTINCT FROM OLD.relative_task_path
			OR NEW.schema_compatibility_version IS DISTINCT FROM OLD.schema_compatibility_version
			OR NEW.project_id IS DISTINCT FROM OLD.project_id
			OR NEW.feature_id IS DISTINCT FROM OLD.feature_id
			OR NEW.approved_by_admin_id IS DISTINCT FROM OLD.approved_by_admin_id
			OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
		THEN
			RAISE EXCEPTION 'task_approvals snapshot and identity columns are immutable';
		END IF;
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER task_approvals_immutable
	BEFORE UPDATE ON task_approvals
	FOR EACH ROW EXECUTE FUNCTION prevent_task_approval_mutation();

CREATE TABLE pull_requests (
	id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
	project_id UUID NOT NULL REFERENCES projects (id),
	feature_id UUID NOT NULL REFERENCES features (id),
	-- Immutable identity
	repository_owner TEXT NOT NULL,
	repository_name TEXT NOT NULL,
	number INTEGER NOT NULL,
	url TEXT NOT NULL,
	head_branch TEXT NOT NULL,
	base_branch TEXT NOT NULL,
	original_head_sha TEXT NOT NULL,
	-- Mutable observations
	observed_head_sha TEXT,
	observed_state pull_request_observed_state,
	merge_commit_sha TEXT,
	last_observed_at TIMESTAMPTZ,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT pull_requests_repo_number_unique UNIQUE (repository_owner, repository_name, number)
);

CREATE INDEX pull_requests_feature_id_idx ON pull_requests (feature_id);
CREATE INDEX pull_requests_project_id_idx ON pull_requests (project_id);

CREATE OR REPLACE FUNCTION enforce_pull_request_hierarchy()
RETURNS TRIGGER AS $$
DECLARE
	feature_project UUID;
BEGIN
	SELECT project_id INTO feature_project FROM features WHERE id = NEW.feature_id;
	IF feature_project IS NULL THEN
		RAISE EXCEPTION 'feature % does not exist', NEW.feature_id;
	END IF;
	IF feature_project <> NEW.project_id THEN
		RAISE EXCEPTION 'pull_request project_id % does not match feature project_id %', NEW.project_id, feature_project;
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER pull_requests_hierarchy_check
	BEFORE INSERT OR UPDATE OF project_id, feature_id ON pull_requests
	FOR EACH ROW EXECUTE FUNCTION enforce_pull_request_hierarchy();

CREATE OR REPLACE FUNCTION prevent_pull_request_identity_mutation()
RETURNS TRIGGER AS $$
BEGIN
	IF TG_OP = 'UPDATE' THEN
		IF NEW.repository_owner IS DISTINCT FROM OLD.repository_owner
			OR NEW.repository_name IS DISTINCT FROM OLD.repository_name
			OR NEW.number IS DISTINCT FROM OLD.number
			OR NEW.url IS DISTINCT FROM OLD.url
			OR NEW.head_branch IS DISTINCT FROM OLD.head_branch
			OR NEW.base_branch IS DISTINCT FROM OLD.base_branch
			OR NEW.original_head_sha IS DISTINCT FROM OLD.original_head_sha
			OR NEW.project_id IS DISTINCT FROM OLD.project_id
			OR NEW.feature_id IS DISTINCT FROM OLD.feature_id
		THEN
			RAISE EXCEPTION 'pull_requests identity columns are immutable';
		END IF;
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER pull_requests_identity_immutable
	BEFORE UPDATE ON pull_requests
	FOR EACH ROW EXECUTE FUNCTION prevent_pull_request_identity_mutation();

INSERT INTO schema_migrations (version) VALUES ('0001_core_entities')
ON CONFLICT (version) DO NOTHING;
