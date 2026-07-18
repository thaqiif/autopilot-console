/**
 * Normalized errors for the github package.
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

export function validationError(message: string): never {
	throw createNormalizedError({
		code: errorCodes.VALIDATION_FAILED,
		message: redactSecrets(message),
		httpStatus: 400,
	});
}

export function redactText(text: string): string {
	return redactSecrets(text);
}
