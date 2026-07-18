import { realpath, stat } from "node:fs/promises";
import { createNormalizedError, errorCodes } from "../errors/normalized-error";
import { redactSecrets } from "../security/redaction";

declare const canonicalWorkspacePathBrand: unique symbol;

export type CanonicalWorkspacePath = string & {
	readonly [canonicalWorkspacePathBrand]: typeof canonicalWorkspacePathBrand;
};

export interface CanonicalizeOptions {
	/** When false (default), path must be a strict child of a root, not the root itself. */
	allowRootEquality?: boolean;
}

function pathError(message: string): never {
	throw createNormalizedError({
		code: errorCodes.VALIDATION_FAILED,
		message: redactSecrets(message),
		httpStatus: 400,
	});
}

/**
 * True when `candidate` is equal to `root` or a path segment child of `root`.
 * Rejects prefix collisions like `/var/workspaces-evil` vs `/var/workspaces`.
 */
export function isPathInsideRoot(candidate: string, root: string): boolean {
	if (candidate === root) return true;
	const prefix = root.endsWith("/") ? root : `${root}/`;
	return candidate.startsWith(prefix);
}

/**
 * Resolve `candidate` via realpath and ensure it sits under one allowlisted root.
 */
export async function canonicalizeWorkspacePath(
	candidate: string,
	roots: readonly string[],
	options: CanonicalizeOptions = {},
): Promise<CanonicalWorkspacePath> {
	const allowRootEquality = options.allowRootEquality ?? false;
	const trimmed = candidate.trim();
	if (trimmed.length === 0) {
		pathError("Workspace path must be non-empty");
	}
	if (roots.length === 0) {
		pathError("Workspace roots allowlist must be non-empty");
	}

	let resolvedCandidate: string;
	try {
		const info = await stat(trimmed);
		if (!info.isDirectory()) {
			pathError("Workspace path must be a directory");
		}
		resolvedCandidate = await realpath(trimmed);
	} catch (err) {
		if (
			err &&
			typeof err === "object" &&
			"code" in err &&
			(err as { code: string }).code === "VALIDATION_FAILED"
		) {
			throw err;
		}
		pathError("Workspace path does not exist or is not accessible");
	}

	const resolvedRoots: string[] = [];
	for (const root of roots) {
		const rootTrimmed = root.trim();
		if (rootTrimmed.length === 0) continue;
		try {
			resolvedRoots.push(await realpath(rootTrimmed));
		} catch {
			// Skip unresolvable roots; empty final list fails below.
		}
	}
	if (resolvedRoots.length === 0) {
		pathError("No resolvable workspace roots in allowlist");
	}

	const matchingRoot = resolvedRoots.find((root) => isPathInsideRoot(resolvedCandidate, root));
	if (!matchingRoot) {
		pathError("Workspace path is outside the configured allowlist roots");
	}

	if (!allowRootEquality && resolvedCandidate === matchingRoot) {
		pathError("Workspace path must be a project directory under a root, not the root itself");
	}

	return resolvedCandidate as CanonicalWorkspacePath;
}
