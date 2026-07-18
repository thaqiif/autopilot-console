import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errorCodes } from "../errors/normalized-error";
import { type ResolvedTaskPath, resolveTaskPath, type TaskRelativePath } from "./task-path";

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

describe("resolveTaskPath", () => {
	test("accepts a project-relative JSON file that exists under the project root", async () => {
		const project = await makeTempDir("task-proj-");
		const relative = "docs/tasks/feature.json";
		const absolute = join(project, relative);
		await mkdir(join(project, "docs", "tasks"), { recursive: true });
		await writeFile(absolute, '{"requirements":[]}');

		const result = await resolveTaskPath(project, relative);
		expect(String(result.relative)).toBe(relative);
		expect(result.absolute).toBe(await realpath(absolute));
		const branded: ResolvedTaskPath = result;
		expect(String(branded.relative)).toBe(relative);
	});

	test("rejects absolute task paths", async () => {
		const project = await makeTempDir("task-proj-");
		await expect(resolveTaskPath(project, "/etc/passwd.json")).rejects.toMatchObject({
			code: errorCodes.VALIDATION_FAILED,
			message: expect.stringMatching(/absolute/i),
		});
	});

	test("rejects empty paths", async () => {
		const project = await makeTempDir("task-proj-");
		await expect(resolveTaskPath(project, "")).rejects.toMatchObject({
			code: errorCodes.VALIDATION_FAILED,
		});
		await expect(resolveTaskPath(project, "   ")).rejects.toMatchObject({
			code: errorCodes.VALIDATION_FAILED,
		});
	});

	test("rejects dot-dot traversal", async () => {
		const project = await makeTempDir("task-proj-");
		await expect(resolveTaskPath(project, "../escape.json")).rejects.toMatchObject({
			code: errorCodes.VALIDATION_FAILED,
			message: expect.stringMatching(/traversal|\.\.|relative/i),
		});
		await expect(resolveTaskPath(project, "docs/../../escape.json")).rejects.toMatchObject({
			code: errorCodes.VALIDATION_FAILED,
		});
	});

	test("rejects non-JSON extensions", async () => {
		const project = await makeTempDir("task-proj-");
		await writeFile(join(project, "tasks.md"), "# no");
		await writeFile(join(project, "tasks.txt"), "no");
		await writeFile(join(project, "tasks.json.bak"), "{}");
		await expect(resolveTaskPath(project, "tasks.md")).rejects.toMatchObject({
			code: errorCodes.VALIDATION_FAILED,
			message: expect.stringMatching(/json/i),
		});
		await expect(resolveTaskPath(project, "tasks.txt")).rejects.toMatchObject({
			code: errorCodes.VALIDATION_FAILED,
		});
		await expect(resolveTaskPath(project, "tasks.json.bak")).rejects.toMatchObject({
			code: errorCodes.VALIDATION_FAILED,
		});
	});

	test("rejects missing files", async () => {
		const project = await makeTempDir("task-proj-");
		await expect(resolveTaskPath(project, "missing/task.json")).rejects.toMatchObject({
			code: errorCodes.VALIDATION_FAILED,
			message: expect.stringMatching(/exist|missing|not found/i),
		});
	});

	test("rejects directories even when named *.json", async () => {
		const project = await makeTempDir("task-proj-");
		await mkdir(join(project, "not-a-file.json"));
		await expect(resolveTaskPath(project, "not-a-file.json")).rejects.toMatchObject({
			code: errorCodes.VALIDATION_FAILED,
			message: expect.stringMatching(/file|directory/i),
		});
	});

	test("rejects symlink escape after the project-relative join", async () => {
		const base = await makeTempDir("task-base-");
		const project = join(base, "project");
		const outside = join(base, "outside");
		await mkdir(project);
		await mkdir(outside);
		const secret = join(outside, "secret.json");
		await writeFile(secret, "{}");
		const link = join(project, "escape.json");
		await symlink(secret, link);

		await expect(resolveTaskPath(project, "escape.json")).rejects.toMatchObject({
			code: errorCodes.VALIDATION_FAILED,
			message: expect.stringMatching(/symlink|escape|outside|root/i),
		});
	});

	test("accepts a symlink that remains inside the project root", async () => {
		const project = await makeTempDir("task-proj-");
		await mkdir(join(project, "docs"), { recursive: true });
		const realFile = join(project, "docs", "real.json");
		await writeFile(realFile, "{}");
		await symlink(realFile, join(project, "alias.json"));

		const result = await resolveTaskPath(project, "alias.json");
		expect(result.absolute).toBe(await realpath(realFile));
	});

	test("normalizes relative path separators and rejects backslash absolute forms", async () => {
		const project = await makeTempDir("task-proj-");
		await mkdir(join(project, "docs"), { recursive: true });
		await writeFile(join(project, "docs", "task.json"), "{}");
		const result = await resolveTaskPath(project, "./docs/task.json");
		expect(String(result.relative)).toBe("docs/task.json");

		// Windows-style absolute should still be rejected on Unix as absolute-ish or invalid.
		await expect(resolveTaskPath(project, "C:\\Windows\\task.json")).rejects.toMatchObject({
			code: errorCodes.VALIDATION_FAILED,
		});
	});

	test("property: nested relative JSON paths under project accept; escapes reject", async () => {
		const project = await makeTempDir("task-proj-");
		const projectReal = await realpath(project);

		for (let i = 0; i < 15; i++) {
			const rel = `n${i}/deep/task.json`;
			const abs = join(project, rel);
			await mkdir(join(project, `n${i}`, "deep"), { recursive: true });
			await writeFile(abs, "{}");
			const ok = await resolveTaskPath(project, rel);
			expect(ok.absolute.startsWith(`${projectReal}/`)).toBe(true);
			expect(ok.relative.includes("..")).toBe(false);

			await expect(resolveTaskPath(project, `../out-${i}.json`)).rejects.toMatchObject({
				code: errorCodes.VALIDATION_FAILED,
			});
		}
	});
});

describe("TaskRelativePath branding surface", () => {
	test("resolved relative is a plain serializable string", async () => {
		const project = await makeTempDir("task-proj-");
		await writeFile(join(project, "t.json"), "{}");
		const result = await resolveTaskPath(project, "t.json");
		const rel: TaskRelativePath = result.relative as TaskRelativePath;
		expect(JSON.stringify({ path: rel })).toBe(JSON.stringify({ path: "t.json" }));
	});
});
