import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join, normalize, posix } from "node:path";
import { createNormalizedError, errorCodes } from "../errors/normalized-error";
import { redactSecrets } from "../security/redaction";
import { isPathInsideRoot } from "./workspace-path";

declare const taskRelativePathBrand: unique symbol;

export type TaskRelativePath = string & {
	readonly [taskRelativePathBrand]: typeof taskRelativePathBrand;
};

export interface ResolvedTaskPath {
	/** Normalized project-relative path using POSIX separators. */
	relative: TaskRelativePath;
	/** Real absolute path of the file after containment checks. */
	absolute: string;
}

function pathError(message: string): never {
	throw createNormalizedError({
		code: errorCodes.VALIDATION_FAILED,
		message: redactSecrets(message),
		httpStatus: 400,
	});
}

function looksAbsolute(input: string): boolean {
	if (isAbsolute(input)) return true;
	// Windows drive / UNC forms even when running on Unix.
	if (/^[A-Za-z]:[\\/]/.test(input)) return true;
	if (input.startsWith("\\\\") || input.startsWith("//")) return true;
	return false;
}

function hasJsonExtension(path: string): boolean {
	const base = posix.basename(path);
	const lastDot = base.lastIndexOf(".");
	if (lastDot < 0) return false;
	return base.slice(lastDot).toLowerCase() === ".json";
}

/**
 * Resolve a project-relative task JSON path inside `projectRoot`.
 * Re-checks realpath containment after join to block symlink escapes.
 */
export async function resolveTaskPath(
	projectRoot: string,
	relativePath: string,
): Promise<ResolvedTaskPath> {
	const raw = relativePath.trim();
	if (raw.length === 0) {
		pathError("Task path must be non-empty");
	}
	if (looksAbsolute(raw)) {
		pathError("Task path must be project-relative, not absolute");
	}
	if (raw.includes("\0")) {
		pathError("Task path contains invalid characters");
	}

	// Normalize separators; reject parent-directory segments after normalize.
	const posixStyle = raw.replace(/\\/g, "/");
	const normalized = posix.normalize(posixStyle).replace(/^\.\//, "");
	if (normalized.length === 0 || normalized === ".") {
		pathError("Task path must be non-empty");
	}
	const segments = normalized.split("/");
	if (segments.some((segment) => segment === ".." || segment === "")) {
		pathError("Task path must not contain parent-directory traversal");
	}
	if (!hasJsonExtension(normalized)) {
		pathError("Task path must end with a .json extension");
	}

	let projectReal: string;
	try {
		projectReal = await realpath(projectRoot);
	} catch {
		pathError("Project root does not exist or is not accessible");
	}

	const joined = join(projectReal, normalized);
	// Pre-realpath traversal check on the joined string (platform normalize).
	const platformNormalized = normalize(joined);
	if (!isPathInsideRoot(platformNormalized, projectReal)) {
		pathError("Task path resolves outside the project root");
	}

	let fileReal: string;
	try {
		const info = await stat(joined);
		if (!info.isFile()) {
			pathError("Task path must be a file, not a directory");
		}
		fileReal = await realpath(joined);
	} catch (err) {
		if (
			err &&
			typeof err === "object" &&
			"code" in err &&
			(err as { code: string }).code === "VALIDATION_FAILED"
		) {
			throw err;
		}
		pathError("Task path does not exist or is not accessible");
	}

	if (!isPathInsideRoot(fileReal, projectReal) || fileReal === projectReal) {
		pathError("Task path symlink escapes the project root");
	}

	return {
		relative: normalized as TaskRelativePath,
		absolute: fileReal,
	};
}
