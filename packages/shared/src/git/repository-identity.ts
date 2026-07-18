import { createNormalizedError, errorCodes } from "../errors/normalized-error";
import { redactSecrets } from "../security/redaction";

export interface RepositoryIdentity {
	owner: string;
	repository: string;
	fullName: string;
}

function validationError(message: string): never {
	throw createNormalizedError({
		code: errorCodes.VALIDATION_FAILED,
		message: redactSecrets(message),
		httpStatus: 400,
	});
}

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
// GitHub repo names: letters, digits, ., _, - ; no slashes
const REPO_RE = /^[A-Za-z0-9._-]+$/;

function assertOwnerRepo(owner: string, repository: string): void {
	if (owner.length === 0) validationError("Repository owner must be non-empty");
	if (repository.length === 0) validationError("Repository name must be non-empty");
	if (owner.includes("/") || !OWNER_RE.test(owner)) {
		validationError("Repository owner is invalid");
	}
	if (repository.includes("/") || !REPO_RE.test(repository)) {
		validationError("Repository name is invalid");
	}
	if (repository === "." || repository === "..") {
		validationError("Repository name is invalid");
	}
}

export function normalizeRepositoryIdentity(input: {
	owner: string;
	repository: string;
}): RepositoryIdentity {
	const owner = input.owner.trim();
	const repository = input.repository.trim().replace(/\.git$/i, "");
	assertOwnerRepo(owner, repository);
	return { owner, repository, fullName: `${owner}/${repository}` };
}

/**
 * Parse a supported GitHub remote URL into owner/repository without retaining credentials.
 */
export function parseGitHubRemote(remote: string): RepositoryIdentity {
	const trimmed = remote.trim();
	if (trimmed.length === 0) {
		validationError("Git remote is invalid");
	}

	// git@github.com:owner/repo(.git)?
	const scp = trimmed.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i);
	if (scp?.[1] && scp[2]) {
		return normalizeRepositoryIdentity({ owner: scp[1], repository: scp[2] });
	}

	// ssh://git@github.com/owner/repo(.git)?
	const ssh = trimmed.match(/^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
	if (ssh?.[1] && ssh[2]) {
		return normalizeRepositoryIdentity({ owner: ssh[1], repository: ssh[2] });
	}

	// https://[user[:pass]@]github.com/owner/repo(.git)?
	// Use URL parsing so credentials never stick around in our result.
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		validationError("Git remote is invalid");
	}

	if (url.protocol !== "https:" && url.protocol !== "http:") {
		validationError("Git remote is invalid");
	}
	const host = url.hostname.toLowerCase();
	if (host !== "github.com" && host !== "www.github.com") {
		// Intentionally do not include the original credential-bearing URL in the message.
		validationError("Git remote must point at github.com");
	}

	const parts = url.pathname.replace(/^\/+/, "").replace(/\/+$/, "").split("/");
	const owner = parts[0];
	const repositoryPart = parts[1];
	if (parts.length < 2 || !owner || !repositoryPart) {
		validationError("Git remote is invalid");
	}
	const repository = repositoryPart.replace(/\.git$/i, "");
	return normalizeRepositoryIdentity({ owner, repository });
}
