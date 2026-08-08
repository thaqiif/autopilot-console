/**
 * Bounded event wait for integration/e2e tests.
 *
 * Prefer HoldGate.whenWaiting() for hold-driven races. Use waitUntil only for
 * DB-visible predicates when no hold is available — never arbitrary sleeps.
 */

export async function waitUntil(
	predicate: () => Promise<boolean>,
	label: string,
	maxTurns = 200,
): Promise<void> {
	for (let i = 0; i < maxTurns; i += 1) {
		if (await predicate()) return;
		await Promise.resolve();
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	throw new Error(`waitUntil timed out: ${label}`);
}
