/**
 * OS process identity: PID + start time for PID-reuse detection.
 */

import { readFile } from "node:fs/promises";

export interface ProcessIdentity {
	pid: number;
	/** Process start time in milliseconds since epoch (or boot-relative converted). */
	startTimeMs: number;
}

function parseProcStatStartTicks(stat: string): number | null {
	// comm may contain spaces/parens: pid (comm) state ...
	const close = stat.lastIndexOf(")");
	if (close < 0) return null;
	const rest = stat
		.slice(close + 2)
		.trim()
		.split(/\s+/);
	// fields after state: ppid ... starttime is field 20 in full stat (index 19 after pid+comm removed → index 19)
	// After removing "pid (comm)", remaining fields start at state=0, so starttime is index 19.
	const startTicks = Number(rest[19]);
	return Number.isFinite(startTicks) ? startTicks : null;
}

let cachedClkTck: number | null = null;
let cachedBtimeSec: number | null = null;

async function clockTicksPerSecond(): Promise<number> {
	if (cachedClkTck != null) return cachedClkTck;
	// Linux default; avoid spawning when possible.
	cachedClkTck = 100;
	try {
		const { spawnSync } = await import("node:child_process");
		const r = spawnSync("getconf", ["CLK_TCK"], { encoding: "utf8" });
		const n = Number((r.stdout || "").trim());
		if (Number.isFinite(n) && n > 0) cachedClkTck = n;
	} catch {
		// keep default
	}
	return cachedClkTck;
}

async function bootTimeMs(): Promise<number> {
	if (cachedBtimeSec != null) return cachedBtimeSec * 1000;
	const text = await readFile("/proc/stat", "utf8");
	const line = text.split("\n").find((l) => l.startsWith("btime "));
	if (!line) throw new Error("cannot read boot time from /proc/stat");
	const sec = Number(line.slice(6).trim());
	if (!Number.isFinite(sec)) throw new Error("invalid btime");
	cachedBtimeSec = sec;
	return sec * 1000;
}

async function startTimeMsForPid(pid: number): Promise<number> {
	const stat = await readFile(`/proc/${pid}/stat`, "utf8");
	const ticks = parseProcStatStartTicks(stat);
	if (ticks == null) throw new Error(`cannot parse starttime for pid ${pid}`);
	const hz = await clockTicksPerSecond();
	const btime = await bootTimeMs();
	return Math.floor(btime + (ticks * 1000) / hz);
}

export async function createProcessIdentity(pid: number): Promise<ProcessIdentity> {
	if (!Number.isInteger(pid) || pid <= 0) {
		throw new Error(`invalid pid: ${pid}`);
	}
	const startTimeMs = await startTimeMsForPid(pid);
	return { pid, startTimeMs };
}

export async function verifyProcessIdentity(identity: ProcessIdentity): Promise<boolean> {
	try {
		const current = await startTimeMsForPid(identity.pid);
		// Allow 1 tick of jitter from integer ms conversion.
		return Math.abs(current - identity.startTimeMs) <= 20;
	} catch {
		return false;
	}
}
