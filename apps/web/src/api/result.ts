/**
 * Shared helpers for interpreting ApiResponse-shaped results on web pages.
 */

export function isUnauthorized(result: {
	ok: boolean;
	error?: { code?: string; httpStatus?: number };
}): boolean {
	return !result.ok && (result.error?.code === "UNAUTHORIZED" || result.error?.httpStatus === 401);
}
