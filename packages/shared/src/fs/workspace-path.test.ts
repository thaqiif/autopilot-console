import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNormalizedError, errorCodes } from "../errors/normalized-error";
import {
	type CanonicalWorkspacePath,
	canonicalizeWorkspacePath,
	isPathInsideRoot,
} from "./workspace-path";

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

describe("canonicalizeWorkspacePath", () => {
	test("accepts an existing directory under a configured root via realpath", async () => {
		const root = await makeTempDir("ws-root-");
		const project = join(root, "proj-a");
		await mkdir(project);
		const roots = [await realpath(root)];

		const result = await canonicalizeWorkspacePath(project, roots);
		expect(String(result)).toBe(await realpath(project));
		const branded: CanonicalWorkspacePath = result;
		expect(String(branded)).toBe(String(result));
	});

	test("rejects a path that does not exist", async () => {
		const root = await makeTempDir("ws-root-");
		const roots = [await realpath(root)];
		await expect(
			canonicalizeWorkspacePath(join(root, "missing-project"), roots),
		).rejects.toMatchObject({
			code: errorCodes.VALIDATION_FAILED,
		});
	});

	test("rejects empty allowlist and empty candidate", async () => {
		await expect(canonicalizeWorkspacePath("/tmp/x", [])).rejects.toMatchObject({
			code: errorCodes.VALIDATION_FAILED,
		});
		const root = await makeTempDir("ws-root-");
		const roots = [await realpath(root)];
		await expect(canonicalizeWorkspacePath("   ", roots)).rejects.toMatchObject({
			code: errorCodes.VALIDATION_FAILED,
		});
	});

	test("rejects path equal to a configured root when root equality is disallowed", async () => {
		const root = await makeTempDir("ws-root-");
		const roots = [await realpath(root)];
		await expect(
			canonicalizeWorkspacePath(root, roots, { allowRootEquality: false }),
		).rejects.toMatchObject({
			code: errorCodes.VALIDATION_FAILED,
			message: expect.stringMatching(/root/i),
		});
	});

	test("accepts path equal to root only when allowRootEquality is true", async () => {
		const root = await makeTempDir("ws-root-");
		const rootReal = await realpath(root);
		const result = await canonicalizeWorkspacePath(root, [rootReal], {
			allowRootEquality: true,
		});
		expect(String(result)).toBe(rootReal);
	});

	test("uses default root-equality policy and ignores blank or inaccessible roots", async () => {
		const root = await makeTempDir("ws-root-");
		const project = join(root, "project");
		await mkdir(project);

		const result = await canonicalizeWorkspacePath(project, ["  ", "/definitely/missing", root]);
		expect(String(result)).toBe(await realpath(project));
		await expect(canonicalizeWorkspacePath(root, [root])).rejects.toMatchObject({
			code: errorCodes.VALIDATION_FAILED,
		});
	});

	test("rejects files and an allowlist containing only blank or inaccessible roots", async () => {
		const root = await makeTempDir("ws-root-");
		const file = join(root, "not-a-directory");
		await Bun.write(file, "content");

		await expect(canonicalizeWorkspacePath(file, [root])).rejects.toMatchObject({
			code: errorCodes.VALIDATION_FAILED,
			message: expect.stringMatching(/directory/i),
		});
		await expect(
			canonicalizeWorkspacePath(root, ["  ", "/definitely/missing"], {
				allowRootEquality: true,
			}),
		).rejects.toMatchObject({
			code: errorCodes.VALIDATION_FAILED,
			message: expect.stringMatching(/resolvable/i),
		});
	});

	test("rejects prefix-collision tricks (similarly-prefixed sibling directory)", async () => {
		const base = await makeTempDir("ws-base-");
		const allowed = join(base, "workspaces");
		const attacker = join(base, "workspaces-evil");
		await mkdir(allowed);
		await mkdir(attacker);
		const project = join(attacker, "proj");
		await mkdir(project);
		const roots = [await realpath(allowed)];

		await expect(canonicalizeWorkspacePath(project, roots)).rejects.toMatchObject({
			code: errorCodes.VALIDATION_FAILED,
			message: expect.stringMatching(/allowlist|outside|root/i),
		});
	});

	test("rejects symlink escape outside the allowlisted root", async () => {
		const base = await makeTempDir("ws-base-");
		const allowed = join(base, "allowed");
		const outside = join(base, "outside");
		await mkdir(allowed);
		await mkdir(outside);
		const secret = join(outside, "secret-repo");
		await mkdir(secret);
		const link = join(allowed, "escape");
		await symlink(secret, link);
		const roots = [await realpath(allowed)];

		await expect(canonicalizeWorkspacePath(link, roots)).rejects.toMatchObject({
			code: errorCodes.VALIDATION_FAILED,
			message: expect.stringMatching(/symlink|escape|outside|allowlist|root/i),
		});
	});

	test("accepts a symlink that stays inside the allowlisted root", async () => {
		const root = await makeTempDir("ws-root-");
		const project = join(root, "real-proj");
		await mkdir(project);
		const link = join(root, "alias-proj");
		await symlink(project, link);
		const roots = [await realpath(root)];

		const result = await canonicalizeWorkspacePath(link, roots);
		expect(String(result)).toBe(await realpath(project));
	});

	test("normalized errors never embed secrets from the candidate path URL form", async () => {
		const root = await makeTempDir("ws-root-");
		const roots = [await realpath(root)];
		const sneaky = join(root, "https://user:p@ssw0rd@github.com/org/repo");
		try {
			await canonicalizeWorkspacePath(sneaky, roots);
			expect.unreachable("should reject");
		} catch (err) {
			expect(err).toBeInstanceOf(Error);
			const message = String(err);
			expect(message).not.toContain("p@ssw0rd");
			if (err && typeof err === "object" && "code" in err) {
				expect((err as { code: string }).code).toBe(errorCodes.VALIDATION_FAILED);
			}
		}
	});

	test("property: random nested paths under root stay inside; random outside paths reject", async () => {
		const root = await makeTempDir("ws-root-");
		const nested = join(root, "a", "b", "c");
		await mkdir(nested, { recursive: true });
		const outsideBase = await makeTempDir("ws-out-");
		const rootReal = await realpath(root);
		const roots = [rootReal];

		for (let i = 0; i < 20; i++) {
			const segments = Array.from({ length: 1 + (i % 3) }, (_, j) => `seg${i}_${j}`);
			const inside = join(root, ...segments);
			await mkdir(inside, { recursive: true });
			const accepted = await canonicalizeWorkspacePath(inside, roots);
			expect(accepted.startsWith(`${rootReal}/`) || accepted === rootReal).toBe(true);
			expect(isPathInsideRoot(accepted, rootReal)).toBe(true);

			const outside = join(outsideBase, `out-${i}`);
			await mkdir(outside, { recursive: true });
			await expect(canonicalizeWorkspacePath(outside, roots)).rejects.toMatchObject({
				code: errorCodes.VALIDATION_FAILED,
			});
		}
	});
});

describe("isPathInsideRoot", () => {
	test("distinguishes true children from prefix collisions", () => {
		expect(isPathInsideRoot("/var/workspaces/proj", "/var/workspaces")).toBe(true);
		expect(isPathInsideRoot("/var/workspaces", "/var/workspaces")).toBe(true);
		expect(isPathInsideRoot("/var/workspaces-evil/proj", "/var/workspaces")).toBe(false);
		expect(isPathInsideRoot("/var/workspac", "/var/workspaces")).toBe(false);
	});

	test("supports roots that already include a trailing separator", () => {
		expect(isPathInsideRoot("/var/workspaces/project", "/var/workspaces/")).toBe(true);
		expect(isPathInsideRoot("/var/workspaces-evil", "/var/workspaces/")).toBe(false);
	});
});

// Ensure createNormalizedError is available for implementations that throw it.
test("shared error helper is importable for path failures", () => {
	const err = createNormalizedError({
		code: errorCodes.VALIDATION_FAILED,
		message: "path rejected",
		httpStatus: 400,
	});
	expect(err.code).toBe(errorCodes.VALIDATION_FAILED);
});
