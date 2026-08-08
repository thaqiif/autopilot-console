import { createNormalizedError, errorCodes } from "../errors/normalized-error";
import { redactSecrets } from "../security/redaction";

declare const featureBranchNameBrand: unique symbol;

export type FeatureBranchName = string & {
	readonly [featureBranchNameBrand]: typeof featureBranchNameBrand;
};

function validationError(message: string): never {
	throw createNormalizedError({
		code: errorCodes.VALIDATION_FAILED,
		message: redactSecrets(message),
		httpStatus: 400,
	});
}

/**
 * Sanitize a human title/slug into a Git-ref-safe lowercase kebab component.
 */
export function sanitizeSlug(input: string): string {
	const lowered = input.trim().toLowerCase();
	const replaced = lowered
		.replace(/[_\s.]+/g, "-")
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "");
	if (replaced.length === 0) {
		validationError("Slug sanitizes to empty");
	}
	return replaced;
}

function assertSafeFeatureId(featureId: string): string {
	const id = featureId.trim();
	if (id.length === 0) {
		validationError("Feature id must be non-empty");
	}
	// Feature ids become a single ref segment component; reject path separators and git-unsafe chars.
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
		validationError("Feature id is invalid for a Git ref component");
	}
	if (id.includes("..") || id.endsWith(".") || id.startsWith(".")) {
		validationError("Feature id is invalid for a Git ref component");
	}
	return id;
}

/**
 * Deterministic feature branch: `feature/<feature-id>-<sanitized-slug>`.
 * Distinct feature IDs always produce distinct branches even when slugs collide.
 */
export function generateFeatureBranch(input: {
	featureId: string;
	slug: string;
}): FeatureBranchName {
	const featureId = assertSafeFeatureId(input.featureId);
	const slug = sanitizeSlug(input.slug);
	const branch = `feature/${featureId}-${slug}`;

	// Final Git-ref safety net (subset of git-check-ref-format rules for a single ref name).
	const hasControl = [...branch].some((ch) => {
		const code = ch.charCodeAt(0);
		return code <= 0x1f || code === 0x7f;
	});
	if (
		hasControl ||
		branch.includes("..") ||
		branch.includes("//") ||
		branch.endsWith(".") ||
		branch.endsWith("/") ||
		branch.includes(" ") ||
		branch.includes("~") ||
		branch.includes("^") ||
		branch.includes(":") ||
		branch.includes("?") ||
		branch.includes("*") ||
		branch.includes("[") ||
		branch.includes("\\") ||
		branch.includes("@{")
	) {
		validationError("Generated feature branch is not a valid Git ref");
	}

	return branch as FeatureBranchName;
}
