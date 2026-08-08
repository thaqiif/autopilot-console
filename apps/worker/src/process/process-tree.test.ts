import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import type { ProcessTreeDependencies } from "./process-tree";
import { createProcessTreeInspector } from "./process-tree";

describe("process-tree inspector", () => {
	test("inspects the current process and missing pids", async () => {
		const tree = createProcessTreeInspector();
		const descendants = await tree.getDescendants(process.pid);
		expect(Array.isArray(descendants)).toBe(true);
		expect(descendants.includes(process.pid)).toBe(false);
		expect(await tree.getDescendants(999_999_999)).toEqual([]);

		const start = Date.now() - 60_000;
		expect(typeof (await tree.verifyIdentity(process.pid, start))).toBe("boolean");
		expect(await tree.verifyIdentity(999_999_999, start)).toBe(false);
	});

	test("signal no-ops for missing pids and signals live child with all kinds safely ordered", async () => {
		const tree = createProcessTreeInspector();
		await tree.signal(999_999_999, "graceful");
		await tree.signal(999_999_999, "term");
		await tree.signal(999_999_999, "kill");

		// Spawn a short-lived sleeper so signalNumber executes against a real pid.
		const child = spawn("sleep", ["2"], { stdio: "ignore" });
		try {
			expect(child.pid).toBeTruthy();
			const pid = child.pid as number;
			// SIGUSR1 then SIGTERM then SIGKILL on the sleeper
			await tree.signal(pid, "graceful");
			await tree.signal(pid, "term");
			await tree.signal(pid, "kill");
			// descendants of a process with children: spawn grandchild chain via shell
			const shell = spawn("bash", ["-c", "sleep 2 & wait"], { stdio: "ignore" });
			try {
				const kids = await tree.getDescendants(shell.pid as number);
				expect(Array.isArray(kids)).toBe(true);
			} finally {
				shell.kill("SIGKILL");
			}
		} finally {
			child.kill("SIGKILL");
		}
	});

	test("parses identities and scans proc when the children shortcut is unavailable", async () => {
		const stat = (pid: number, ppid: number, startTicks = 100) =>
			`${pid} (process ${pid}) S ${ppid} ${Array.from({ length: 17 }, () => "0").join(" ")} ${startTicks}`;
		const readFile: ProcessTreeDependencies["readFile"] = (async (path: string | Buffer | URL) => {
			const name = String(path);
			if (name === "/proc/stat") return "cpu 1 2 3\nbtime 1000\n";
			if (name === "/proc/20/stat") return "malformed";
			if (name === "/proc/21/stat") return "21 (short) S 1";
			if (name === "/proc/22/stat") return stat(22, 1, 100);
			if (name === "/proc/10/task/10/children") throw new Error("shortcut unavailable");
			if (name === "/proc/11/task/11/children") return "12 12 10";
			if (name === "/proc/12/task/12/children") return "";
			if (name === "/proc/10/stat") return stat(10, 10);
			if (name === "/proc/11/stat") return stat(11, 10);
			if (name === "/proc/12/stat") return "malformed";
			if (name === "/proc/13/stat") throw new Error("vanished");
			throw new Error(`unexpected read: ${name}`);
		}) as ProcessTreeDependencies["readFile"];
		const tree = createProcessTreeInspector({
			readFile,
			readdir: (async () => ["not-a-pid", "0", "10", "11", "12", "13"]) as never,
		});

		expect(await tree.getDescendants(10)).toEqual([11, 12]);
		expect(await tree.verifyIdentity(20, 0)).toBe(false);
		expect(await tree.verifyIdentity(21, 0)).toBe(false);
		expect(await tree.verifyIdentity(22, 1_001_000)).toBe(true);
		expect(await tree.verifyIdentity(22, 2_000_000)).toBe(false);

		const noBootTime = createProcessTreeInspector({
			readFile: (async (path: string | Buffer | URL) =>
				String(path) === "/proc/stat" ? "cpu 1 2 3\n" : stat(22, 1, 100)) as never,
		});
		expect(await noBootTime.verifyIdentity(22, 1_000)).toBe(true);
	});

	test("handles every signal and distinguishes vanished processes from real signal errors", async () => {
		const calls: Array<[number, NodeJS.Signals | number]> = [];
		let errorCode: string | undefined;
		const tree = createProcessTreeInspector({
			readFile: (async () => Buffer.from("live")) as unknown as ProcessTreeDependencies["readFile"],
			kill: ((pid: number, signal: NodeJS.Signals | number) => {
				calls.push([pid, signal]);
				if (errorCode) throw Object.assign(new Error(errorCode), { code: errorCode });
				return true;
			}) as ProcessTreeDependencies["kill"],
		});

		await tree.signal(1, "graceful");
		await tree.signal(2, "term");
		await tree.signal(3, "kill");
		expect(calls.map((entry) => entry[1])).toEqual([10, 15, 9]);

		errorCode = "ESRCH";
		await expect(tree.signal(4, "term")).resolves.toBeUndefined();
		errorCode = "EPERM";
		await expect(tree.signal(5, "term")).rejects.toMatchObject({ code: "EPERM" });
	});
});
