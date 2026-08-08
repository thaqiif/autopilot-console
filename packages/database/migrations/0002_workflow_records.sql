-- Workflow records for Autopilot Console Phase 1
-- Immutable development attempts, process ownership, progress, bounded logs,
-- activity, audit, failure, worker, scheduling, idempotency, and outbox.

CREATE TYPE job_attempt_status AS ENUM (
	'QUEUED',
	'RUNNING',
	'CANCEL_REQUESTED',
	'SUCCEEDED',
	'FAILED',
	'INTERRUPTED',
	'CANCELLED'
);

CREATE TYPE outbox_status AS ENUM ('pending', 'claimed', 'completed', 'failed');
CREATE TYPE schedule_status AS ENUM ('pending', 'claimed', 'completed', 'failed', 'cancelled');
CREATE TYPE diagnostic_stream AS ENUM ('stdout', 'stderr');
CREATE TYPE audit_actor_type AS ENUM (
	'administrator',
	'api_system',
	'worker',
	'autopilot_process',
	'github_poller',
	'reconciliation'
);

CREATE TABLE worker_registrations (
	id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
	worker_id TEXT NOT NULL,
	hostname TEXT NOT NULL,
	capacity INTEGER NOT NULL DEFAULT 4 CHECK (capacity > 0),
	active_jobs INTEGER NOT NULL DEFAULT 0 CHECK (active_jobs >= 0),
	registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	stopped_at TIMESTAMPTZ,
	CONSTRAINT worker_registrations_worker_id_unique UNIQUE (worker_id)
);

CREATE TABLE development_job_attempts (
	id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
	project_id UUID NOT NULL REFERENCES projects (id),
	feature_id UUID NOT NULL REFERENCES features (id),
	task_approval_id UUID NOT NULL REFERENCES task_approvals (id),
	branch_name TEXT NOT NULL,
	operation_key TEXT NOT NULL,
	status job_attempt_status NOT NULL DEFAULT 'QUEUED',
	predecessor_attempt_id UUID REFERENCES development_job_attempts (id),
	worker_registration_id UUID REFERENCES worker_registrations (id),
	process_pid INTEGER,
	process_start_identity TEXT,
	lease_expires_at TIMESTAMPTZ,
	heartbeat_at TIMESTAMPTZ,
	enqueued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	started_at TIMESTAMPTZ,
	ended_at TIMESTAMPTZ,
	exit_code INTEGER,
	cancellation_requested_at TIMESTAMPTZ,
	cancellation_reason TEXT,
	structured_result JSONB,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- At most one claimed/running/cancel-requested attempt per project
CREATE UNIQUE INDEX development_job_attempts_one_active_per_project
	ON development_job_attempts (project_id)
	WHERE status IN ('RUNNING', 'CANCEL_REQUESTED');

-- Stable operation key uniqueness for active (non-terminal) attempts prevents double-queue
CREATE UNIQUE INDEX development_job_attempts_active_operation_key
	ON development_job_attempts (operation_key)
	WHERE status IN ('QUEUED', 'RUNNING', 'CANCEL_REQUESTED');

CREATE INDEX development_job_attempts_project_id_idx ON development_job_attempts (project_id);
CREATE INDEX development_job_attempts_feature_id_idx ON development_job_attempts (feature_id);
CREATE INDEX development_job_attempts_status_enqueued_idx
	ON development_job_attempts (status, enqueued_at);

CREATE OR REPLACE FUNCTION enforce_attempt_hierarchy()
RETURNS TRIGGER AS $$
DECLARE
	feature_project UUID;
	approval_project UUID;
	approval_feature UUID;
BEGIN
	SELECT project_id INTO feature_project FROM features WHERE id = NEW.feature_id;
	IF feature_project IS NULL THEN
		RAISE EXCEPTION 'feature % does not exist', NEW.feature_id;
	END IF;
	IF feature_project <> NEW.project_id THEN
		RAISE EXCEPTION 'development_job_attempt project_id % does not match feature project_id %',
			NEW.project_id, feature_project;
	END IF;

	SELECT project_id, feature_id INTO approval_project, approval_feature
	FROM task_approvals WHERE id = NEW.task_approval_id;
	IF approval_project IS NULL THEN
		RAISE EXCEPTION 'task_approval % does not exist', NEW.task_approval_id;
	END IF;
	IF approval_project <> NEW.project_id OR approval_feature <> NEW.feature_id THEN
		RAISE EXCEPTION 'development_job_attempt hierarchy mismatch for task_approval %',
			NEW.task_approval_id;
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER development_job_attempts_hierarchy_check
	BEFORE INSERT OR UPDATE OF project_id, feature_id, task_approval_id
	ON development_job_attempts
	FOR EACH ROW EXECUTE FUNCTION enforce_attempt_hierarchy();

CREATE TABLE progress_snapshots (
	id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
	project_id UUID NOT NULL REFERENCES projects (id),
	feature_id UUID NOT NULL REFERENCES features (id),
	attempt_id UUID NOT NULL REFERENCES development_job_attempts (id),
	source_version BIGINT NOT NULL,
	summary JSONB NOT NULL,
	requirements JSONB NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT progress_snapshots_attempt_version_unique UNIQUE (attempt_id, source_version)
);

CREATE INDEX progress_snapshots_attempt_id_idx ON progress_snapshots (attempt_id);
CREATE INDEX progress_snapshots_project_id_idx ON progress_snapshots (project_id);

CREATE OR REPLACE FUNCTION enforce_progress_snapshot_hierarchy()
RETURNS TRIGGER AS $$
DECLARE
	attempt_project UUID;
	attempt_feature UUID;
BEGIN
	SELECT project_id, feature_id INTO attempt_project, attempt_feature
	FROM development_job_attempts WHERE id = NEW.attempt_id;
	IF attempt_project IS NULL THEN
		RAISE EXCEPTION 'development_job_attempt % does not exist', NEW.attempt_id;
	END IF;
	IF attempt_project <> NEW.project_id OR attempt_feature <> NEW.feature_id THEN
		RAISE EXCEPTION 'progress_snapshot hierarchy mismatch for attempt %', NEW.attempt_id;
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER progress_snapshots_hierarchy_check
	BEFORE INSERT OR UPDATE OF project_id, feature_id, attempt_id
	ON progress_snapshots
	FOR EACH ROW EXECUTE FUNCTION enforce_progress_snapshot_hierarchy();

CREATE OR REPLACE FUNCTION prevent_progress_snapshot_mutation()
RETURNS TRIGGER AS $$
BEGIN
	RAISE EXCEPTION 'progress_snapshots are append-only and immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER progress_snapshots_immutable
	BEFORE UPDATE OR DELETE ON progress_snapshots
	FOR EACH ROW EXECUTE FUNCTION prevent_progress_snapshot_mutation();

CREATE TABLE diagnostic_log_chunks (
	id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
	project_id UUID NOT NULL REFERENCES projects (id),
	attempt_id UUID NOT NULL REFERENCES development_job_attempts (id),
	sequence BIGINT NOT NULL,
	stream diagnostic_stream NOT NULL,
	body TEXT NOT NULL,
	truncated BOOLEAN NOT NULL DEFAULT false,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT diagnostic_log_chunks_attempt_sequence_unique UNIQUE (attempt_id, sequence)
);

CREATE INDEX diagnostic_log_chunks_attempt_id_idx ON diagnostic_log_chunks (attempt_id);

CREATE OR REPLACE FUNCTION enforce_diagnostic_log_hierarchy()
RETURNS TRIGGER AS $$
DECLARE
	attempt_project UUID;
BEGIN
	SELECT project_id INTO attempt_project FROM development_job_attempts WHERE id = NEW.attempt_id;
	IF attempt_project IS NULL THEN
		RAISE EXCEPTION 'development_job_attempt % does not exist', NEW.attempt_id;
	END IF;
	IF attempt_project <> NEW.project_id THEN
		RAISE EXCEPTION 'diagnostic_log_chunk project_id % does not match attempt project_id %',
			NEW.project_id, attempt_project;
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER diagnostic_log_chunks_hierarchy_check
	BEFORE INSERT OR UPDATE OF project_id, attempt_id
	ON diagnostic_log_chunks
	FOR EACH ROW EXECUTE FUNCTION enforce_diagnostic_log_hierarchy();

CREATE OR REPLACE FUNCTION prevent_diagnostic_log_mutation()
RETURNS TRIGGER AS $$
BEGIN
	RAISE EXCEPTION 'diagnostic_log_chunks are append-only and immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER diagnostic_log_chunks_immutable
	BEFORE UPDATE OR DELETE ON diagnostic_log_chunks
	FOR EACH ROW EXECUTE FUNCTION prevent_diagnostic_log_mutation();

CREATE TABLE failure_records (
	id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
	project_id UUID NOT NULL REFERENCES projects (id),
	feature_id UUID NOT NULL REFERENCES features (id),
	attempt_id UUID REFERENCES development_job_attempts (id),
	category TEXT NOT NULL,
	summary TEXT NOT NULL,
	recommended_action TEXT NOT NULL,
	details JSONB NOT NULL DEFAULT '{}'::jsonb,
	occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX failure_records_project_id_idx ON failure_records (project_id);
CREATE INDEX failure_records_attempt_id_idx ON failure_records (attempt_id);

CREATE OR REPLACE FUNCTION enforce_failure_hierarchy()
RETURNS TRIGGER AS $$
DECLARE
	feature_project UUID;
	attempt_project UUID;
BEGIN
	SELECT project_id INTO feature_project FROM features WHERE id = NEW.feature_id;
	IF feature_project IS NULL THEN
		RAISE EXCEPTION 'feature % does not exist', NEW.feature_id;
	END IF;
	IF feature_project <> NEW.project_id THEN
		RAISE EXCEPTION 'failure_record project_id % does not match feature project_id %',
			NEW.project_id, feature_project;
	END IF;
	IF NEW.attempt_id IS NOT NULL THEN
		SELECT project_id INTO attempt_project FROM development_job_attempts WHERE id = NEW.attempt_id;
		IF attempt_project IS NULL OR attempt_project <> NEW.project_id THEN
			RAISE EXCEPTION 'failure_record hierarchy mismatch for attempt %', NEW.attempt_id;
		END IF;
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER failure_records_hierarchy_check
	BEFORE INSERT OR UPDATE OF project_id, feature_id, attempt_id
	ON failure_records
	FOR EACH ROW EXECUTE FUNCTION enforce_failure_hierarchy();

CREATE OR REPLACE FUNCTION prevent_failure_mutation()
RETURNS TRIGGER AS $$
BEGIN
	RAISE EXCEPTION 'failure_records are append-only and immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER failure_records_immutable
	BEFORE UPDATE OR DELETE ON failure_records
	FOR EACH ROW EXECUTE FUNCTION prevent_failure_mutation();

CREATE TABLE activity_events (
	id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
	project_id UUID REFERENCES projects (id),
	feature_id UUID REFERENCES features (id),
	attempt_id UUID REFERENCES development_job_attempts (id),
	type TEXT NOT NULL,
	summary TEXT NOT NULL,
	source TEXT NOT NULL,
	metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
	occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX activity_events_project_occurred_idx
	ON activity_events (project_id, occurred_at DESC);
CREATE INDEX activity_events_occurred_idx ON activity_events (occurred_at DESC);

CREATE OR REPLACE FUNCTION enforce_activity_hierarchy()
RETURNS TRIGGER AS $$
DECLARE
	feature_project UUID;
	attempt_project UUID;
BEGIN
	IF NEW.feature_id IS NOT NULL AND NEW.project_id IS NOT NULL THEN
		SELECT project_id INTO feature_project FROM features WHERE id = NEW.feature_id;
		IF feature_project IS NULL OR feature_project <> NEW.project_id THEN
			RAISE EXCEPTION 'activity_event hierarchy mismatch for feature %', NEW.feature_id;
		END IF;
	END IF;
	IF NEW.attempt_id IS NOT NULL AND NEW.project_id IS NOT NULL THEN
		SELECT project_id INTO attempt_project FROM development_job_attempts WHERE id = NEW.attempt_id;
		IF attempt_project IS NULL OR attempt_project <> NEW.project_id THEN
			RAISE EXCEPTION 'activity_event hierarchy mismatch for attempt %', NEW.attempt_id;
		END IF;
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER activity_events_hierarchy_check
	BEFORE INSERT OR UPDATE OF project_id, feature_id, attempt_id
	ON activity_events
	FOR EACH ROW EXECUTE FUNCTION enforce_activity_hierarchy();

CREATE OR REPLACE FUNCTION prevent_activity_mutation()
RETURNS TRIGGER AS $$
BEGIN
	RAISE EXCEPTION 'activity_events are append-only and immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER activity_events_immutable
	BEFORE UPDATE OR DELETE ON activity_events
	FOR EACH ROW EXECUTE FUNCTION prevent_activity_mutation();

CREATE TABLE audit_events (
	id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
	actor_type audit_actor_type NOT NULL,
	actor_id TEXT NOT NULL,
	action TEXT NOT NULL,
	target_type TEXT NOT NULL,
	target_id TEXT NOT NULL,
	project_id UUID REFERENCES projects (id),
	feature_id UUID REFERENCES features (id),
	attempt_id UUID REFERENCES development_job_attempts (id),
	correlation_id TEXT,
	result TEXT NOT NULL,
	prior_values JSONB,
	next_values JSONB,
	occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX audit_events_project_occurred_idx ON audit_events (project_id, occurred_at DESC);
CREATE INDEX audit_events_target_idx ON audit_events (target_type, target_id);
CREATE INDEX audit_events_correlation_idx ON audit_events (correlation_id);

CREATE OR REPLACE FUNCTION prevent_audit_mutation()
RETURNS TRIGGER AS $$
BEGIN
	RAISE EXCEPTION 'audit_events are append-only and immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_events_immutable
	BEFORE UPDATE OR DELETE ON audit_events
	FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();

CREATE TABLE scheduled_reconciliation_jobs (
	id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
	kind TEXT NOT NULL,
	project_id UUID REFERENCES projects (id),
	feature_id UUID REFERENCES features (id),
	status schedule_status NOT NULL DEFAULT 'pending',
	not_before TIMESTAMPTZ NOT NULL DEFAULT now(),
	payload JSONB NOT NULL DEFAULT '{}'::jsonb,
	claimed_by TEXT,
	claimed_at TIMESTAMPTZ,
	completed_at TIMESTAMPTZ,
	last_error TEXT,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX scheduled_reconciliation_jobs_claim_idx
	ON scheduled_reconciliation_jobs (status, not_before)
	WHERE status = 'pending';

CREATE TABLE outbox_intents (
	id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
	project_id UUID NOT NULL REFERENCES projects (id),
	feature_id UUID REFERENCES features (id),
	attempt_id UUID REFERENCES development_job_attempts (id),
	kind TEXT NOT NULL,
	dedupe_key TEXT NOT NULL,
	status outbox_status NOT NULL DEFAULT 'pending',
	payload JSONB NOT NULL DEFAULT '{}'::jsonb,
	claimed_by TEXT,
	claimed_at TIMESTAMPTZ,
	completed_at TIMESTAMPTZ,
	last_error TEXT,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Active (pending/claimed) intents unique by dedupe_key
CREATE UNIQUE INDEX outbox_intents_active_dedupe_uidx
	ON outbox_intents (dedupe_key)
	WHERE status IN ('pending', 'claimed');

CREATE INDEX outbox_intents_claim_idx
	ON outbox_intents (status, created_at)
	WHERE status = 'pending';

CREATE TABLE idempotency_records (
	id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
	operation_key TEXT NOT NULL,
	project_id UUID NOT NULL REFERENCES projects (id),
	feature_id UUID REFERENCES features (id),
	attempt_id UUID REFERENCES development_job_attempts (id),
	result JSONB NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT idempotency_records_operation_key_unique UNIQUE (operation_key)
);

CREATE INDEX idempotency_records_project_id_idx ON idempotency_records (project_id);

INSERT INTO schema_migrations (version) VALUES ('0002_workflow_records')
ON CONFLICT (version) DO NOTHING;
