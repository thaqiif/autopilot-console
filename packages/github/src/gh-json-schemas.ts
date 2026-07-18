/**
 * Minimal runtime shape checks for gh --json payloads.
 * Reject human-formatted and partial objects rather than parse ad hoc.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requireString(obj: Record<string, unknown>, key: string): string {
	const v = obj[key];
	if (typeof v !== "string" || v.length === 0) {
		throw new Error(`missing or invalid string field: ${key}`);
	}
	return v;
}

export function requireNumber(obj: Record<string, unknown>, key: string): number {
	const v = obj[key];
	if (typeof v !== "number" || !Number.isFinite(v)) {
		throw new Error(`missing or invalid number field: ${key}`);
	}
	return v;
}

export function optionalString(obj: Record<string, unknown>, key: string): string | null {
	const v = obj[key];
	if (v == null) return null;
	if (typeof v !== "string") {
		throw new Error(`invalid string field: ${key}`);
	}
	return v.length === 0 ? null : v;
}

/** Parse stdout as JSON; reject non-JSON (human-formatted tables, bare URLs). */
export function parseJsonStdout(stdout: string): unknown {
	const trimmed = stdout.trim();
	if (trimmed.length === 0) {
		throw new Error("empty gh JSON output");
	}
	// Human table lines often start with letters and tabs — still try JSON first.
	try {
		return JSON.parse(trimmed);
	} catch {
		throw new Error("gh output is not valid JSON");
	}
}

export interface GhPrListItem {
	number: number;
	url: string;
	headRefName: string;
	baseRefName: string;
	headRefOid: string;
	state: string;
}

export function parsePrListItem(value: unknown): GhPrListItem {
	if (!isRecord(value)) throw new Error("PR list item is not an object");
	return {
		number: requireNumber(value, "number"),
		url: requireString(value, "url"),
		headRefName: requireString(value, "headRefName"),
		baseRefName: requireString(value, "baseRefName"),
		headRefOid: requireString(value, "headRefOid"),
		state: requireString(value, "state"),
	};
}

export function parsePrList(value: unknown): GhPrListItem[] {
	if (!Array.isArray(value)) throw new Error("PR list is not an array");
	return value.map(parsePrListItem);
}

export interface GhPrView {
	number: number;
	url: string;
	headRefName: string;
	baseRefName: string;
	headRefOid: string;
	state: string;
	reviewDecision: string | null;
	mergeCommit: { oid: string } | null;
	mergedAt: string | null;
	closedAt: string | null;
	updatedAt: string | null;
	mergeable: string | null;
	statusCheckRollup: unknown[];
}

export function parsePrView(value: unknown): GhPrView {
	if (!isRecord(value)) throw new Error("PR view is not an object");
	const mergeCommitRaw = value.mergeCommit;
	let mergeCommit: { oid: string } | null = null;
	if (mergeCommitRaw != null) {
		if (!isRecord(mergeCommitRaw) || typeof mergeCommitRaw.oid !== "string") {
			throw new Error("invalid mergeCommit");
		}
		mergeCommit = { oid: mergeCommitRaw.oid };
	}
	const rollup = value.statusCheckRollup;
	if (rollup != null && !Array.isArray(rollup)) {
		throw new Error("statusCheckRollup must be an array");
	}
	return {
		number: requireNumber(value, "number"),
		url: requireString(value, "url"),
		headRefName: requireString(value, "headRefName"),
		baseRefName: requireString(value, "baseRefName"),
		headRefOid: requireString(value, "headRefOid"),
		state: requireString(value, "state"),
		reviewDecision: optionalString(value, "reviewDecision"),
		mergeCommit,
		mergedAt: optionalString(value, "mergedAt"),
		closedAt: optionalString(value, "closedAt"),
		updatedAt: optionalString(value, "updatedAt"),
		mergeable: optionalString(value, "mergeable"),
		statusCheckRollup: Array.isArray(rollup) ? rollup : [],
	};
}

export interface GhRepoView {
	name: string;
	ownerLogin: string;
	viewerPermission: string | null;
}

export function parseRepoView(value: unknown): GhRepoView {
	if (!isRecord(value)) throw new Error("repo view is not an object");
	const owner = value.owner;
	let ownerLogin = "";
	if (isRecord(owner) && typeof owner.login === "string") {
		ownerLogin = owner.login;
	} else if (typeof value.owner === "string") {
		ownerLogin = value.owner;
	} else {
		throw new Error("repo owner missing");
	}
	return {
		name: requireString(value, "name"),
		ownerLogin,
		viewerPermission: typeof value.viewerPermission === "string" ? value.viewerPermission : null,
	};
}

/** gh auth status --json hosts shape (partial). */
export function parseAuthHosts(value: unknown): { login: string | null; ok: boolean } {
	if (!isRecord(value)) throw new Error("auth status is not an object");
	const hosts = value.hosts;
	if (!isRecord(hosts)) throw new Error("auth hosts missing");
	const github = hosts["github.com"];
	if (!isRecord(github)) {
		return { login: null, ok: false };
	}
	const active = typeof github.activeAccount === "string" ? github.activeAccount : null;
	const accounts = github.accounts;
	if (active && isRecord(accounts)) {
		const acct = accounts[active];
		if (isRecord(acct) && acct.state === "success") {
			return { login: active, ok: true };
		}
	}
	// Fallback: any successful account
	if (isRecord(accounts)) {
		for (const [login, acct] of Object.entries(accounts)) {
			if (isRecord(acct) && acct.state === "success") {
				return { login, ok: true };
			}
		}
	}
	return { login: active, ok: false };
}
