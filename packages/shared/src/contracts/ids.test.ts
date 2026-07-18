import { describe, expect, test } from "bun:test";
import { createNormalizedError, errorCodes, NormalizedError } from "../errors/normalized-error";
import { createOperationKey, parseOperationKey } from "../idempotency/operation-key";
import { type CorrelationScope, createCorrelationId } from "../observability/correlation";
import {
	asFeatureId,
	asJobAttemptId,
	asProjectId,
	asReleaseId,
	type FeatureId,
	type JobAttemptId,
	type ProjectId,
	type ReleaseId,
} from "./ids";
import { formatUtcIso, isUtcIso, parseUtcIso } from "./time";

describe("typed identifiers", () => {
	test("create branded ids and serialize cleanly as strings", () => {
		const projectId = asProjectId("proj_01HXYZ");
		const releaseId = asReleaseId("rel_01HXYZ");
		const featureId = asFeatureId("feat_01HXYZ");
		const jobId = asJobAttemptId("job_01HXYZ");

		expect(String(projectId)).toBe("proj_01HXYZ");
		expect(JSON.stringify({ projectId, releaseId, featureId, jobId })).toBe(
			JSON.stringify({
				projectId: "proj_01HXYZ",
				releaseId: "rel_01HXYZ",
				featureId: "feat_01HXYZ",
				jobId: "job_01HXYZ",
			}),
		);

		// Branding is a compile-time distinction; runtime values remain plain strings.
		const _p: ProjectId = projectId;
		const _r: ReleaseId = releaseId;
		const _f: FeatureId = featureId;
		const _j: JobAttemptId = jobId;
		expect(_p).toBe(projectId);
		expect(_r).toBe(releaseId);
		expect(_f).toBe(featureId);
		expect(_j).toBe(jobId);
	});

	test("reject empty identifiers", () => {
		expect(() => asProjectId("")).toThrow(/id/i);
		expect(() => asFeatureId("   ")).toThrow(/id/i);
	});
});

describe("operation keys", () => {
	test("are stable for the same operation identity and prevent cross-entity reuse", () => {
		const a = createOperationKey({
			operation: "approve_and_queue",
			projectId: asProjectId("proj_1"),
			featureId: asFeatureId("feat_1"),
			checksum: "abc",
		});
		const b = createOperationKey({
			operation: "approve_and_queue",
			projectId: asProjectId("proj_1"),
			featureId: asFeatureId("feat_1"),
			checksum: "abc",
		});
		const otherFeature = createOperationKey({
			operation: "approve_and_queue",
			projectId: asProjectId("proj_1"),
			featureId: asFeatureId("feat_2"),
			checksum: "abc",
		});
		const otherOp = createOperationKey({
			operation: "cancel",
			projectId: asProjectId("proj_1"),
			featureId: asFeatureId("feat_1"),
			checksum: "abc",
		});

		expect(a).toBe(b);
		expect(a).not.toBe(otherFeature);
		expect(a).not.toBe(otherOp);
		expect(a.startsWith("approve_and_queue:")).toBe(true);

		const parsed = parseOperationKey(a);
		expect(parsed.operation).toBe("approve_and_queue");
		expect(parsed.projectId).toBe("proj_1");
		expect(parsed.featureId).toBe("feat_1");
	});
});

describe("UTC timestamps", () => {
	test("format and parse ISO-8601 UTC values", () => {
		const d = new Date("2026-07-18T12:34:56.789Z");
		const iso = formatUtcIso(d);
		expect(iso).toBe("2026-07-18T12:34:56.789Z");
		expect(isUtcIso(iso)).toBe(true);
		expect(isUtcIso("2026-07-18T12:34:56+00:00")).toBe(false);
		expect(isUtcIso("2026-07-18 12:34:56")).toBe(false);
		expect(parseUtcIso(iso).getTime()).toBe(d.getTime());
		expect(() => parseUtcIso("not-a-date")).toThrow(/utc|iso/i);
	});
});

describe("correlation metadata", () => {
	test("creates correlation ids that span HTTP, job, process, Git, GitHub, activity, and audit scopes", () => {
		const scopes: CorrelationScope[] = [
			"http",
			"job",
			"process",
			"git",
			"github",
			"activity",
			"audit",
		];
		const root = createCorrelationId();
		expect(root.length).toBeGreaterThan(8);

		for (const scope of scopes) {
			const child = createCorrelationId({ parent: root, scope });
			expect(child).toContain(root);
			expect(child.toLowerCase()).toContain(scope);
		}
	});
});

describe("normalized errors", () => {
	test("omit secrets and expose stable codes with safe next actions", () => {
		const err = createNormalizedError({
			code: errorCodes.UNAUTHORIZED,
			message: "Invalid credentials",
			httpStatus: 401,
			correlationId: "corr_1",
			details: {
				password: "should-not-leak",
				authorization: "Bearer secret",
				reason: "bad_password",
			},
		});

		expect(err).toBeInstanceOf(NormalizedError);
		expect(err.code).toBe("UNAUTHORIZED");
		expect(err.httpStatus).toBe(401);
		expect(err.correlationId).toBe("corr_1");

		const json = err.toJSON();
		const serialized = JSON.stringify(json);
		expect(serialized).not.toContain("should-not-leak");
		expect(serialized).not.toContain("Bearer secret");
		expect(json.details?.reason).toBe("bad_password");
		expect(json.nextAction).toBeTruthy();
	});
});
