/**
 * Release-qualification contract suite against the installed autopilot-multi CLI.
 *
 * This file intentionally uses the `.contract.ts` suffix (not `*.test.ts`) so
 * ordinary unit and branch-coverage discovery do not accidentally depend on an
 * external installation. `verify:phase-1` invokes it unconditionally:
 *
 *   bun test ./packages/autopilot/src/runner/installed-cli.contract.ts
 *
 * A missing installation fails release qualification; it is never skipped.
 */

import { describe, expect, test } from "bun:test";
import { access, constants } from "node:fs/promises";
import { join } from "node:path";

describe("installed autopilotagent CLI contract", () => {
	test("run.sh exists and documents run.pid + SIGUSR1", async () => {
		const runSh = process.env.AUTOPILOT_MULTI_ROOT
			? join(process.env.AUTOPILOT_MULTI_ROOT, "run.sh")
			: "/opt/autopilot-multi/run.sh";
		await access(runSh, constants.R_OK);
		const text = await Bun.file(runSh).text();
		expect(text).toMatch(/run\.pid/);
		expect(text).toMatch(/SIGUSR1/);
		expect(text).toMatch(/echo \$\$ > "\$PID_FILE"/);
	});

	test("slash command checks out branch from task basename", async () => {
		const cmd = process.env.AUTOPILOT_MULTI_ROOT
			? join(process.env.AUTOPILOT_MULTI_ROOT, "commands/autopilotagent.md")
			: "/opt/autopilot-multi/commands/autopilotagent.md";
		const text = await Bun.file(cmd).text();
		expect(text).toMatch(/git checkout <feature-name>/);
		expect(text).toMatch(/basename/);
	});

	test("global autopilotagent is executable when enabled", async () => {
		const which = Bun.which("autopilotagent");
		expect(which).toBeTruthy();
	});
});
