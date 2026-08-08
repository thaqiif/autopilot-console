import { describe, expect, test } from "bun:test";
import type { CorrelationScope } from "../observability/correlation";
import { childCorrelation, createCorrelationId } from "../observability/correlation";

describe("createCorrelationId", () => {
	test("generates a correlation id without parent or scope", () => {
		const id = createCorrelationId();
		expect(id).toMatch(/^corr_[0-9a-f]{12}$/);
	});

	test("generates unique ids across calls", () => {
		const ids = new Set<string>();
		for (let i = 0; i < 100; i++) {
			ids.add(createCorrelationId());
		}
		expect(ids.size).toBe(100);
	});

	test("embeds scope in the correlation id", () => {
		const id = createCorrelationId({ scope: "http" });
		expect(id).toMatch(/^http:[0-9a-f]{12}$/);
	});

	test("embeds parent in the correlation id", () => {
		const parent = "corr_abcdef123456";
		const id = createCorrelationId({ parent });
		expect(id).toMatch(/^corr_abcdef123456\/[0-9a-f]{12}$/);
	});

	test("embeds both parent and scope", () => {
		const parent = "corr_abcdef123456/http:123456789abc";
		const id = createCorrelationId({ parent, scope: "job" });
		expect(id).toMatch(/^corr_abcdef123456\/http:123456789abc\/job:[0-9a-f]{12}$/);
	});

	test("handles all scope types", () => {
		const scopes: CorrelationScope[] = [
			"http",
			"job",
			"process",
			"git",
			"github",
			"activity",
			"audit",
		];
		for (const scope of scopes) {
			const id = createCorrelationId({ scope });
			expect(id).toMatch(new RegExp(`^${scope}:[0-9a-f]{12}$`));
		}
	});
});

describe("childCorrelation", () => {
	test("creates a child correlation context with scope", () => {
		const parent = {
			correlationId: "corr_abc123",
			projectId: "proj-1",
			featureId: "feat-1",
		};
		const child = childCorrelation(parent, "job");
		expect(child.correlationId).toMatch(/^corr_abc123\/job:[0-9a-f]{12}$/);
		expect(child.scope).toBe("job");
		expect(child.projectId).toBe("proj-1");
		expect(child.featureId).toBe("feat-1");
	});

	test("overrides extra fields in child context", () => {
		const parent = {
			correlationId: "corr_abc123",
			projectId: "proj-1",
		};
		const child = childCorrelation(parent, "job", { projectId: "proj-2", featureId: "feat-2" });
		expect(child.projectId).toBe("proj-2");
		expect(child.featureId).toBe("feat-2");
	});

	test("parent context remains unmodified", () => {
		const parent = {
			correlationId: "corr_abc123",
			scope: "http" as CorrelationScope,
		};
		childCorrelation(parent, "job");
		expect(parent.correlationId).toBe("corr_abc123");
		expect(parent.scope).toBe("http");
	});

	test("chains scopes across multiple levels", () => {
		const root = { correlationId: createCorrelationId({ scope: "http" }) };
		const job = childCorrelation(root, "job");
		const process = childCorrelation(job, "process");
		const activity = childCorrelation(process, "activity");

		expect(root.correlationId).toMatch(/^http:/);
		expect(job.correlationId).toContain("/job:");
		expect(process.correlationId).toContain("/process:");
		expect(activity.correlationId).toContain("/activity:");
	});
});
