/**
 * OS-level process tree inspection for Linux.
 * Provides the real ProcessTreeInspector implementation used in production.
 */

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import type { SignalKind } from "../../../../packages/autopilot/src/index";
import type { ProcessTreeInspector } from "./cancellation-controller";

// ---------------------------------------------------------------------------
// PID helpers
// ---------------------------------------------------------------------------

function signalNumber(kind: SignalKind): number {
	switch (kind) {
		case "graceful":
			return 10; // SIGUSR1
		case "term":
			return 15; // SIGTERM
		case "kill":
			return 9; // SIGKILL
	}
}

async function pidExists(pid: number): Promise<boolean> {
	try {
		await readFile(`/proc/${pid}/stat`);
		return true;
	} catch {
		return false;
	}
}

async function parseProcStatStartTicks(pid: number): Promise<number | null> {
	try {
		const stat = await readFile(`/proc/${pid}/stat`, "utf8");
		const close = stat.lastIndexOf(")");
		if (close < 0) return null;
		const rest = stat
			.slice(close + 2)
			.trim()
			.split(/\s+/);
		const startTicks = Number(rest[19]);
		return Number.isFinite(startTicks) ? startTicks : null;
	} catch {
		return null;
	}
}

const CLK_TCK = (() => {
	try {
		const r = spawnSync("getconf", ["CLK_TCK"], { encoding: "utf8" });
		const n = Number((r.stdout || "").trim());
		return n > 0 ? n : 100;
	} catch {
		return 100;
	}
})();

async function bootTimeMs(): Promise<number> {
	const text = await readFile("/proc/stat", "utf8");
	const line = text.split("\n").find((l) => l.startsWith("btime "));
	if (!line) return 0;
	return Number(line.slice(6).trim()) * 1000;
}

async function startTimeMsForPid(pid: number): Promise<number> {
	const ticks = await parseProcStatStartTicks(pid);
	if (ticks === null) throw new Error(`cannot parse starttime for pid ${pid}`);
	const btime = await bootTimeMs();
	return Math.floor(btime + (ticks * 1000) / CLK_TCK);
}

// ---------------------------------------------------------------------------
// Family helpers
// ---------------------------------------------------------------------------

async function getChildren(pid: number): Promise<number[]> {
	try {
		const childrenDir = `/proc/${pid}/task/${pid}/children`;
		const text = await readFile(childrenDir, "utf8");
		return text
			.trim()
			.split(/\s+/)
			.map(Number)
			.filter((n) => n > 0);
	} catch {
		// Fallback: scan /proc for PPID match
		const { readdir } = await import("node:fs/promises");
		const entries = await readdir("/proc");
		const children: number[] = [];
		for (const entry of entries) {
			const childPid = Number(entry);
			if (!Number.isInteger(childPid) || childPid <= 0) continue;
			try {
				const stat = await readFile(`/proc/${childPid}/stat`, "utf8");
				const close = stat.lastIndexOf(")");
				if (close < 0) continue;
				const rest = stat
					.slice(close + 2)
					.trim()
					.split(/\s+/);
				const ppid = Number(rest[1]);
				if (ppid === pid) children.push(childPid);
			} catch {}
		}
		return children;
	}
}

async function getAllDescendants(pid: number): Promise<number[]> {
	const result: number[] = [];
	const queue = [pid];
	while (queue.length > 0) {
		const current = queue.shift()!;
		const children = await getChildren(current);
		for (const child of children) {
			if (!result.includes(child) && child !== pid) {
				result.push(child);
				queue.push(child);
			}
		}
	}
	return result;
}

// ---------------------------------------------------------------------------
// Real ProcessTreeInspector
// ---------------------------------------------------------------------------

export function createProcessTreeInspector(): ProcessTreeInspector {
	return {
		async getDescendants(pid: number): Promise<number[]> {
			return getAllDescendants(pid);
		},

		async verifyIdentity(pid: number, expectedStartTimeMs: number): Promise<boolean> {
			try {
				const current = await startTimeMsForPid(pid);
				return Math.abs(current - expectedStartTimeMs) <= 20;
			} catch {
				return false;
			}
		},

		async signal(pid: number, kind: SignalKind): Promise<void> {
			const exists = await pidExists(pid);
			if (!exists) return;
			const sig = signalNumber(kind);
			try {
				process.kill(pid, sig);
			} catch (error: unknown) {
				const err = error as NodeJS.ErrnoException;
				// ESRCH = process vanished — not an error for our purposes
				if (err.code !== "ESRCH") throw error;
			}
		},
	};
}
