/**
 * Hono API application boundary (requirement 21 / 22).
 *
 * Wires correlation, authentication (default-deny), CSRF, and error handling,
 * then mounts the public auth/health routes and protected mutation routes.
 * Domain service factories are injected so the boundary stays testable.
 */

import { Hono } from "hono";
import type { Queryable } from "../../../packages/database/src/client";
import type {
	FeatureService,
	ProjectService,
	ReleaseService,
	TaskApprovalService,
} from "../../../packages/domain/src/index";
import type { NodeEnv } from "../../../packages/shared/src/index";
import type { SessionService } from "./auth/session-service";
import "./types";
import { createHealthService, type HealthProbe } from "./health/health-service";
import { authenticationMiddleware } from "./middleware/authentication";
import { correlationMiddleware } from "./middleware/correlation";
import { csrfMiddleware } from "./middleware/csrf";
import { buildFailure } from "./middleware/error-handler";
import { createActivityRoutes } from "./routes/activity";
import { createAttentionRoutes } from "./routes/attention";
import { createAuthRoutes } from "./routes/auth";
import { createEventRoutes } from "./routes/events";
import { createFeatureReadRoutes } from "./routes/feature-reads";
import { createFeatureRoutes } from "./routes/features";
import { createHealthRoutes } from "./routes/health";
import { createJobActionRoutes } from "./routes/job-actions";
import { createOverviewRoutes } from "./routes/overview";
import { createPrActionRoutes } from "./routes/pr-actions";
import { createProjectReadRoutes } from "./routes/project-reads";
import { createProjectRoutes } from "./routes/projects";
import { createReleaseReadRoutes } from "./routes/release-reads";
import { createReleaseRoutes } from "./routes/releases";
import { createTaskArtifactRoutes } from "./routes/task-artifacts";
import { type CsrfProtector, createCsrfProtector } from "./security/csrf-protector";

export interface DomainAdapters {
	sql: Queryable;
	projectService: ProjectService;
	releaseService: ReleaseService;
	featureService: FeatureService;
	taskApprovalService: TaskApprovalService;
	cancelHandler?: (
		attempt: import("../../../packages/database/src/index").DevelopmentAttemptRow,
		feature: import("../../../packages/database/src/index").FeatureRow,
		reason: string,
		operationId: string,
	) => Promise<{ kind: string; attemptId?: string; reason?: string }>;
	retryHandler: (request: {
		featureId: string;
		projectId: string;
		taskApprovalId: string;
		branchName: string;
		operationKey: string;
		reason: string;
		actorId: string;
	}) => Promise<{
		kind: string;
		attempt?: import("../../../packages/database/src/index").DevelopmentAttemptRow;
		reason?: string;
	}>;
}

export interface ApiAppOptions {
	sessionService: SessionService;
	nodeEnv?: NodeEnv;
	now?: () => Date;
	healthProbes?: {
		database: HealthProbe;
		worker: HealthProbe;
		autopilot: HealthProbe;
		github: HealthProbe;
	};
	/** Session-bound CSRF protector; shared with the test harness when provided. */
	csrf?: CsrfProtector;
	/** Browser origins allowed to submit mutations; defaults to the request origin. */
	trustedOrigins?: readonly string[];
	/** Domain service factories for mutation routes. */
	adapters?: DomainAdapters;
}

export interface ApiApp {
	app: Hono;
	csrf: CsrfProtector;
}

export function createApiApp(options: ApiAppOptions): ApiApp {
	const nodeEnv = options.nodeEnv ?? "development";
	const now = options.now ?? (() => new Date());
	const csrf = options.csrf ?? createCsrfProtector();

	const app = new Hono();

	app.use("*", correlationMiddleware());
	app.use("*", authenticationMiddleware({ sessionService: options.sessionService }));
	app.use("*", csrfMiddleware({ csrf, trustedOrigins: options.trustedOrigins }));

	app.onError((err, c) => {
		const correlationId = c.get("correlationId") ?? "";
		const body = buildFailure(err, correlationId, nodeEnv);
		return c.json(body, body.error.httpStatus as 400 | 401 | 403 | 404 | 409 | 429 | 500);
	});

	const probes = options.healthProbes;
	const health = createHealthService({ now, ...(probes ?? defaultProbes()) });

	app.route("/", createHealthRoutes({ health, now }));
	app.route("/", createAuthRoutes({ sessionService: options.sessionService, nodeEnv, csrf }));

	const adapters = options.adapters;
	if (adapters) {
		app.route(
			"/",
			createProjectRoutes({ projectService: adapters.projectService, sql: adapters.sql, now }),
		);
		app.route("/", createReleaseRoutes({ releaseService: adapters.releaseService }));
		app.route("/", createFeatureRoutes({ featureService: adapters.featureService }));
		app.route(
			"/",
			createTaskArtifactRoutes({
				taskApprovalService: adapters.taskApprovalService,
				sql: adapters.sql,
			}),
		);
		app.route(
			"/",
			createJobActionRoutes({
				sql: adapters.sql,
				cancelHandler: adapters.cancelHandler,
				retryHandler: adapters.retryHandler,
			}),
		);
		app.route("/", createPrActionRoutes({ sql: adapters.sql }));
	} else {
		// Boundary scaffold fallback when no adapters injected.
		app.get("/api/projects", (c) => c.json({ ok: true as const, data: [] }));
		app.post("/api/projects", async (c) => {
			const body = (await c.req.json().catch(() => ({}))) as { name?: string };
			return c.json({ ok: true as const, data: { id: "pending", name: body.name ?? "" } }, 201);
		});
	}

	// Always mount read routes (they only need sql)
	const sql = adapters?.sql;
	if (sql) {
		app.route("/", createOverviewRoutes({ sql }));
		app.route("/", createAttentionRoutes({ sql }));
		app.route("/", createActivityRoutes({ sql }));
		app.route("/", createProjectReadRoutes({ sql }));
		app.route("/", createReleaseReadRoutes({ sql }));
		app.route("/", createFeatureReadRoutes({ sql }));
		app.route("/", createEventRoutes({ sql }));
	}

	return { app, csrf };
}

function defaultProbes(): {
	database: HealthProbe;
	worker: HealthProbe;
	autopilot: HealthProbe;
	github: HealthProbe;
} {
	const ok = (name: string): HealthProbe => ({
		name,
		check: async () => ({ ok: true, detail: { available: true } }),
	});
	return {
		database: ok("database"),
		worker: ok("worker"),
		autopilot: ok("autopilot"),
		github: ok("github"),
	};
}
