import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createTaskApprovalSnapshot,
	evaluateAllPass,
	parseTaskBytes,
	readTaskFileAtomic,
	summarizeTaskFile,
	TASK_SCHEMA_COMPATIBILITY_VERSION,
	validateTaskDocument,
} from "./task-reader";
import {
	fullRequirement,
	fullTaskFile,
	minimalRequirement,
	minimalTaskFile,
} from "../testing/task-fixtures";

const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	tempRoots.push(dir);
	return dir;
}

afterEach(async () => {
	while (tempRoots.length > 0) {
		const dir = tempRoots.pop();
		if (dir) await rm(dir, { recursive: true, force: true });
	}
});

function sha256(bytes: Uint8Array | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

describe("TASK_SCHEMA_COMPATIBILITY_VERSION", () => {
	test("is a non-empty version string", () => {
		expect(typeof TASK_SCHEMA_COMPATIBILITY_VERSION).toBe("string");
		expect(TASK_SCHEMA_COMPATIBILITY_VERSION.length).toBeGreaterThan(0);
	});
});

describe("validateTaskDocument — schema + semantic", () => {
	test("accepts a full-schema task file", () => {
		const doc = fullTaskFile();
		const result = validateTaskDocument(doc);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.document.name).toBe("fixture-task");
			expect(result.document.requirements).toHaveLength(1);
		}
	});

	test("accepts minimal fixtures that only have name, description, requirements", () => {
		const doc = minimalTaskFile(
			{},
			[
				minimalRequirement({ id: "1", passes: true }),
				minimalRequirement({ id: "2", passes: false }),
			],
		);
		const result = validateTaskDocument(doc);
		expect(result.ok).toBe(true);
	});

	test("rejects missing required top-level fields", () => {
		const missingName = validateTaskDocument({
			description: "x",
			requirements: [],
		});
		expect(missingName.ok).toBe(false);
		if (!missingName.ok) {
			expect(missingName.errors.some((e) => /name/i.test(e))).toBe(true);
		}

		const missingReqs = validateTaskDocument({
			name: "x",
			description: "y",
		});
		expect(missingReqs.ok).toBe(false);
		if (!missingReqs.ok) {
			expect(missingReqs.errors.some((e) => /requirements/i.test(e))).toBe(true);
		}
	});

	test("rejects non-object / non-array requirements", () => {
		expect(validateTaskDocument(null).ok).toBe(false);
		expect(validateTaskDocument("string").ok).toBe(false);
		expect(
			validateTaskDocument({ name: "x", description: "y", requirements: "nope" }).ok,
		).toBe(false);
	});

	test("rejects duplicate requirement IDs", () => {
		const doc = fullTaskFile({}, [
			fullRequirement({ id: "1" }),
			fullRequirement({ id: "1", description: "dup" }),
		]);
		const result = validateTaskDocument(doc);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors.some((e) => /duplicate/i.test(e))).toBe(true);
		}
	});

	test("rejects missing dependency references", () => {
		const doc = fullTaskFile({}, [
			fullRequirement({ id: "1" }),
			fullRequirement({ id: "2", dependsOn: ["1", "missing"] }),
		]);
		const result = validateTaskDocument(doc);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors.some((e) => /missing|unknown|depend/i.test(e))).toBe(true);
		}
	});

	test("rejects dependency cycles", () => {
		const doc = fullTaskFile({}, [
			fullRequirement({ id: "1", dependsOn: ["2"] }),
			fullRequirement({ id: "2", dependsOn: ["1"] }),
		]);
		const result = validateTaskDocument(doc);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors.some((e) => /cycle/i.test(e))).toBe(true);
		}
	});

	test("rejects self-dependency as a cycle", () => {
		const doc = fullTaskFile({}, [fullRequirement({ id: "1", dependsOn: ["1"] })]);
		const result = validateTaskDocument(doc);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors.some((e) => /cycle|self/i.test(e))).toBe(true);
		}
	});

	test("rejects empty requirements as neither fresh nor resumable", () => {
		const doc = fullTaskFile({ requirements: [] });
		const result = validateTaskDocument(doc);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors.some((e) => /fresh|resumable|empty|requirement/i.test(e))).toBe(
				true,
			);
		}
	});

	test("accepts fresh state (all requirements incomplete)", () => {
		const doc = fullTaskFile({}, [
			fullRequirement({ id: "1", passes: false }),
			fullRequirement({ id: "2", passes: false, dependsOn: ["1"] }),
		]);
		const result = validateTaskDocument(doc);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.runMode).toBe("fresh");
		}
	});

	test("accepts resumable state (mix of complete and incomplete)", () => {
		const doc = fullTaskFile({}, [
			fullRequirement({ id: "1", passes: true }),
			fullRequirement({
				id: "2",
				passes: false,
				dependsOn: ["1"],
				tdd: {
					test: { description: "t", passes: true },
					implement: { description: "i", passes: false },
					refactor: { description: "r", passes: false },
				},
			}),
		]);
		const result = validateTaskDocument(doc);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.runMode).toBe("resumable");
		}
	});

	test("accepts all-pass as resumable complete", () => {
		const doc = fullTaskFile({}, [
			fullRequirement({
				id: "1",
				passes: true,
				tdd: {
					test: { description: "t", passes: true },
					implement: { description: "i", passes: true },
					refactor: { description: "r", passes: true },
				},
			}),
		]);
		const result = validateTaskDocument(doc);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.runMode).toBe("complete");
		}
	});

	test("rejects impossible state: overall passes true but a TDD phase is false", () => {
		const doc = fullTaskFile({}, [
			fullRequirement({
				id: "1",
				passes: true,
				tdd: {
					test: { description: "t", passes: true },
					implement: { description: "i", passes: false },
					refactor: { description: "r", passes: true },
				},
			}),
		]);
		const result = validateTaskDocument(doc);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors.some((e) => /impossible|inconsistent|passes/i.test(e))).toBe(
				true,
			);
		}
	});

	test("rejects stuck without blockedReason", () => {
		const doc = fullTaskFile({}, [
			fullRequirement({ id: "1", passes: false, stuck: true }),
		]);
		const result = validateTaskDocument(doc);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors.some((e) => /blockedReason|stuck/i.test(e))).toBe(true);
		}
	});

	test("rejects invalidTest without invalidTestReason", () => {
		const doc = fullTaskFile({}, [
			fullRequirement({ id: "1", passes: false, invalidTest: true }),
		]);
		const result = validateTaskDocument(doc);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors.some((e) => /invalidTestReason|invalid/i.test(e))).toBe(true);
		}
	});

	test("preserves unknown top-level and nested fields on the parsed document", () => {
		const doc = fullTaskFile({
			customTop: { nested: true, keep: "me" },
			requirements: [
				fullRequirement({
					id: "1",
					extraField: "stay",
					codeAnalysis: {
						approach: "create",
						customAnalysis: 42,
					},
				}),
			],
		});
		// replace requirements via override properly
		const withUnknown = {
			...fullTaskFile(),
			customTop: { nested: true, keep: "me" },
			requirements: [
				{
					...fullRequirement({ id: "1" }),
					extraField: "stay",
					codeAnalysis: {
						approach: "create",
						customAnalysis: 42,
					},
				},
			],
		};
		const result = validateTaskDocument(withUnknown);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect((result.document as { customTop?: unknown }).customTop).toEqual({
				nested: true,
				keep: "me",
			});
			const req = result.document.requirements[0] as {
				extraField?: string;
				codeAnalysis?: { customAnalysis?: number };
			};
			expect(req.extraField).toBe("stay");
			expect(req.codeAnalysis?.customAnalysis).toBe(42);
		}
		void doc;
	});
});

describe("parseTaskBytes", () => {
	test("parses valid JSON bytes and validates", () => {
		const raw = `${JSON.stringify(fullTaskFile(), null, 2)}\n`;
		const result = parseTaskBytes(Buffer.from(raw, "utf8"));
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.checksum).toBe(sha256(raw));
			expect(result.sourceBytes.byteLength).toBe(Buffer.byteLength(raw, "utf8"));
		}
	});

	test("rejects partial / malformed JSON", () => {
		const partial = Buffer.from('{"name":"x","description":"y","requirements":[', "utf8");
		const result = parseTaskBytes(partial);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors.some((e) => /json|parse|malformed|partial/i.test(e))).toBe(
				true,
			);
		}
	});

	test("rejects empty bytes", () => {
		const result = parseTaskBytes(Buffer.alloc(0));
		expect(result.ok).toBe(false);
	});

	test("checksum is over exact source bytes, not re-serialized JSON", () => {
		// Two semantically equal docs with different whitespace must differ in checksum.
		const compact = JSON.stringify(fullTaskFile());
		const pretty = `${JSON.stringify(fullTaskFile(), null, 2)}\n`;
		const a = parseTaskBytes(Buffer.from(compact, "utf8"));
		const b = parseTaskBytes(Buffer.from(pretty, "utf8"));
		expect(a.ok && b.ok).toBe(true);
		if (a.ok && b.ok) {
			expect(a.checksum).not.toBe(b.checksum);
			expect(a.checksum).toBe(sha256(compact));
			expect(b.checksum).toBe(sha256(pretty));
		}
	});
});

describe("createTaskApprovalSnapshot", () => {
	test("stores exact requirements, checksum, schema version, and relative path", () => {
		const relativePath = "docs/tasks/feature.json";
		const raw = `${JSON.stringify(fullTaskFile(), null, 2)}\n`;
		const parsed = parseTaskBytes(Buffer.from(raw, "utf8"));
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;

		const snapshot = createTaskApprovalSnapshot({
			parsed,
			relativePath,
		});

		expect(snapshot.checksum).toBe(parsed.checksum);
		expect(snapshot.schemaCompatibilityVersion).toBe(TASK_SCHEMA_COMPATIBILITY_VERSION);
		expect(snapshot.relativePath).toBe(relativePath);
		expect(snapshot.requirements).toEqual(parsed.document.requirements);
		// Deep clone — mutating snapshot must not mutate parsed document.
		const reqs = snapshot.requirements as Array<Record<string, unknown>>;
		reqs[0] = { ...reqs[0], description: "mutated" };
		expect(
			(parsed.document.requirements[0] as { description: string }).description,
		).not.toBe("mutated");
	});

	test("preserves unknown fields inside the immutable requirements snapshot", () => {
		const doc = {
			...fullTaskFile(),
			requirements: [
				{
					...fullRequirement({ id: "1" }),
					vendorMeta: { keep: true },
				},
			],
		};
		const raw = JSON.stringify(doc);
		const parsed = parseTaskBytes(Buffer.from(raw, "utf8"));
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		const snapshot = createTaskApprovalSnapshot({
			parsed,
			relativePath: "tasks/a.json",
		});
		expect((snapshot.requirements[0] as { vendorMeta?: unknown }).vendorMeta).toEqual({
			keep: true,
		});
	});
});

describe("display/validate does not rewrite source file", () => {
	test("readTaskFileAtomic leaves bytes, mode, and mtime unchanged", async () => {
		const dir = await makeTempDir("task-norewrite-");
		const relative = "docs/tasks/feature.json";
		const absolute = join(dir, relative);
		await mkdir(join(dir, "docs", "tasks"), { recursive: true });
		const content = `${JSON.stringify(fullTaskFile(), null, 2)}\n`;
		await writeFile(absolute, content, { mode: 0o644 });
		await chmod(absolute, 0o644);

		const before = await stat(absolute);
		const beforeBytes = await readFile(absolute);

		const result = await readTaskFileAtomic({
			absolutePath: absolute,
			relativePath: relative,
		});
		expect(result.ok).toBe(true);

		const after = await stat(absolute);
		const afterBytes = await readFile(absolute);

		expect(afterBytes.equals(beforeBytes)).toBe(true);
		expect(after.mode).toBe(before.mode);
		expect(after.mtimeMs).toBe(before.mtimeMs);
		expect(after.size).toBe(before.size);
		// realpath still the same file
		expect(await realpath(absolute)).toBe(beforeBytes ? await realpath(absolute) : "");
	});
});

describe("readTaskFileAtomic — partial JSON tolerance", () => {
	test("returns last valid snapshot when current bytes are partial", async () => {
		const dir = await makeTempDir("task-partial-");
		const absolute = join(dir, "task.json");
		const good = `${JSON.stringify(fullTaskFile(), null, 2)}\n`;
		await writeFile(absolute, good);

		const first = await readTaskFileAtomic({
			absolutePath: absolute,
			relativePath: "task.json",
		});
		expect(first.ok).toBe(true);
		if (!first.ok) return;

		// Simulate atomic-replace mid-write: truncated JSON
		await writeFile(absolute, good.slice(0, 20));

		const second = await readTaskFileAtomic({
			absolutePath: absolute,
			relativePath: "task.json",
			previousSnapshot: first.snapshot,
			maxRetries: 2,
			retryDelayMs: 0,
		});

		// Must not accept partial JSON as valid progress.
		expect(second.ok).toBe(false);
		if (!second.ok) {
			expect(second.lastValidSnapshot?.checksum).toBe(first.snapshot.checksum);
			expect(second.diagnostic).toMatch(/partial|malformed|json|retry/i);
		}
	});

	test("recovers when a transient partial write becomes valid within retries", async () => {
		const dir = await makeTempDir("task-retry-");
		const absolute = join(dir, "task.json");
		const good = `${JSON.stringify(fullTaskFile(), null, 2)}\n`;
		await writeFile(absolute, good.slice(0, 10));

		let attempts = 0;
		const result = await readTaskFileAtomic({
			absolutePath: absolute,
			relativePath: "task.json",
			maxRetries: 3,
			retryDelayMs: 0,
			// Inject a clock-free side effect: after first read, restore good bytes.
			onBeforeRead: async () => {
				attempts += 1;
				if (attempts >= 2) {
					await writeFile(absolute, good);
				}
			},
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.snapshot.checksum).toBe(sha256(good));
		}
		expect(attempts).toBeGreaterThanOrEqual(2);
	});
});

describe("summarizeTaskFile + evaluateAllPass", () => {
	test("summary exposes goals, non-goals, counts, blocked reasons, and tdd status", () => {
		const doc = fullTaskFile(
			{
				goals: ["g1", "g2"],
				nonGoals: ["ng1"],
			},
			[
				fullRequirement({
					id: "1",
					passes: true,
					tdd: {
						test: { description: "t", passes: true },
						implement: { description: "i", passes: true },
						refactor: { description: "r", passes: true },
					},
				}),
				fullRequirement({
					id: "2",
					passes: false,
					dependsOn: ["1"],
					stuck: true,
					blockedReason: "flaky db",
					tdd: {
						test: { description: "t", passes: true },
						implement: { description: "i", passes: false },
						refactor: { description: "r", passes: false },
					},
				}),
				fullRequirement({
					id: "3",
					passes: false,
					invalidTest: true,
					invalidTestReason: "passed early",
				}),
			],
		);
		const parsed = parseTaskBytes(Buffer.from(JSON.stringify(doc), "utf8"));
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;

		const summary = summarizeTaskFile(parsed.document);
		expect(summary.goals).toEqual(["g1", "g2"]);
		expect(summary.nonGoals).toEqual(["ng1"]);
		expect(summary.total).toBe(3);
		expect(summary.passed).toBe(1);
		expect(summary.stuck).toBe(1);
		expect(summary.invalidTest).toBe(1);
		expect(summary.pending).toBe(1);
		expect(summary.allPass).toBe(false);
		expect(summary.blockedReasons).toEqual(
			expect.arrayContaining([{ id: "2", reason: "flaky db" }]),
		);

		const req2 = summary.requirements.find((r) => r.id === "2");
		expect(req2).toBeDefined();
		expect(req2?.dependsOn).toEqual(["1"]);
		expect(req2?.acceptance).toEqual(["Acceptance for 2"]);
		expect(req2?.tdd).toEqual({
			test: true,
			implement: false,
			refactor: false,
		});
	});

	test("evaluateAllPass is true only when every requirement passes", () => {
		const all = fullTaskFile({}, [
			fullRequirement({
				id: "1",
				passes: true,
				tdd: {
					test: { description: "t", passes: true },
					implement: { description: "i", passes: true },
					refactor: { description: "r", passes: true },
				},
			}),
			fullRequirement({
				id: "2",
				passes: true,
				dependsOn: ["1"],
				tdd: {
					test: { description: "t", passes: true },
					implement: { description: "i", passes: true },
					refactor: { description: "r", passes: true },
				},
			}),
		]);
		const mixed = fullTaskFile({}, [
			fullRequirement({ id: "1", passes: true }),
			fullRequirement({ id: "2", passes: false }),
		]);
		const allParsed = parseTaskBytes(Buffer.from(JSON.stringify(all), "utf8"));
		const mixedParsed = parseTaskBytes(Buffer.from(JSON.stringify(mixed), "utf8"));
		expect(allParsed.ok && mixedParsed.ok).toBe(true);
		if (allParsed.ok && mixedParsed.ok) {
			expect(evaluateAllPass(allParsed.document)).toBe(true);
			expect(evaluateAllPass(mixedParsed.document)).toBe(false);
			expect(summarizeTaskFile(allParsed.document).allPass).toBe(true);
		}
	});

	test("installed autopilot-multi fixtures validate or fail predictably", async () => {
		const fixturesDir = "/opt/autopilot-multi/tests/fixtures";
		const cases: Array<{ file: string; expectOk: boolean }> = [
			{ file: "with-dependencies.json", expectOk: true },
			{ file: "all-complete.json", expectOk: true },
			{ file: "incomplete.json", expectOk: true },
			{ file: "mixed-stuck.json", expectOk: true },
			{ file: "tasks-simple.json", expectOk: true },
			// empty requirements cannot be fresh/resumable for Console approval
			{ file: "empty.json", expectOk: false },
		];
		for (const c of cases) {
			const bytes = await readFile(join(fixturesDir, c.file));
			const result = parseTaskBytes(bytes);
			expect(result.ok).toBe(c.expectOk);
		}

		// Full example with full schema
		const example = await readFile("/opt/autopilot-multi/examples/tasks-user-auth.json");
		const exampleResult = parseTaskBytes(example);
		expect(exampleResult.ok).toBe(true);
	});
});
