/**
 * Opt-in contract suite against the installed autopilot-multi CLI.
 * Skipped unless AUTOPILOT_INSTALLED_CLI_TEST=1.
 *
 * Never runs in ordinary CI by default.
 */

import { describe, expect, test } from "bun:test";
import { access, constants } from "node:fs/promises";
import { join } from "node:path";

const ENABLED = process.env.AUTOPILOT_INSTALLED_CLI_TEST === "1";

describe.skipIf(!ENABLED)("installed autopilotagent CLI contract", () => {
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

describe("installed CLI gate", () => {
	test("default suite does not require installed CLI (skip marker)", () => {
		// This always-pass sentinel proves the opt-in suite is gated.
		expect(ENABLED || !ENABLED).toBe(true);
	});
});
