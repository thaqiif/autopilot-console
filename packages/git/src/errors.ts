/**
 * Shared normalized errors for the git package.
 */

import { createNormalizedError, errorCodes } from "../../shared/src/errors/normalized-error";
import { redactSecrets } from "../../shared/src/security/redaction";

export function adapterError(message: string, details?: Record<string, unknown>): never {
	throw createNormalizedError({
		code: errorCodes.ADAPTER_ERROR,
		message: redactSecrets(message),
		httpStatus: 502,
		details,
	});
}

export function preconditionError(message: string): never {
	throw createNormalizedError({
		code: errorCodes.PRECONDITION_FAILED,
		message: redactSecrets(message),
		httpStatus: 409,
	});
}

export function validationError(message: string): never {
	throw createNormalizedError({
		code: errorCodes.VALIDATION_FAILED,
		message: redactSecrets(message),
		httpStatus: 400,
	});
}

/** feature/<feature-id>-<slug> — id then hyphen then slug components. */
export const FEATURE_BRANCH_RE = /^feature\/[A-Za-z0-9][A-Za-z0-9._-]*-[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function assertFeatureBranchName(featureBranch: string): void {
	if (
		!FEATURE_BRANCH_RE.test(featureBranch) ||
		featureBranch.includes("..") ||
		featureBranch.includes("//")
	) {
		validationError("Feature branch must match feature/<feature-id>-<slug>");
	}
}
