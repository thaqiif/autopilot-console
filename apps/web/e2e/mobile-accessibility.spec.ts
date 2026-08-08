import {
	assertNoConsolePrApproveOrMerge,
	assertNoHorizontalOverflow,
	assertPrimaryTapTargets,
	assertWcag22Aa,
	expect,
	signIn,
	test,
} from "./fixtures";

const CORE_ROUTES = [
	"/",
	"/attention",
	"/releases",
	"/projects",
	"/activity",
	"/settings",
	"/projects/new",
	"/releases/new",
	"/features/new?projectId=project-1&releaseId=release-1",
	"/features/test-feature-1",
	"/features/test-feature-planned",
	"/projects/project-1",
	"/releases/release-1",
	"/login",
] as const;

test.describe("mobile accessibility at 375x667", () => {
	test.use({ viewport: { width: 375, height: 667 } });

	test("login journey completes without horizontal scrolling", async ({ page }) => {
		await page.goto("/login");
		await page.waitForSelector("h1");
		await assertNoHorizontalOverflow(page);

		await page.fill("#username", "admin");
		await page.fill("#password", "password123");
		await page.click('button[type="submit"]');
		await page.waitForURL("**/");
		await expect(
			page.getByRole("heading", { name: /needs your attention|overview|portfolio/i }).first(),
		).toBeVisible();
		await assertNoHorizontalOverflow(page);
	});

	test("portfolio review journey surfaces attention without horizontal scroll", async ({
		page,
	}) => {
		await signIn(page);
		await expect(page.getByText(/1/).first()).toBeVisible();
		await page.goto("/attention");
		await expect(page.getByText(/PR awaiting review/i)).toBeVisible();
		await assertNoHorizontalOverflow(page);
		await assertNoConsolePrApproveOrMerge(page);
	});

	test("project registration journey validates and creates a project at 375px", async ({
		page,
	}) => {
		await signIn(page);
		await page.goto("/projects/new");
		await assertNoHorizontalOverflow(page);

		await page.getByLabel(/^name$/i).fill("Mobile Project");
		await page.getByLabel(/^slug$/i).fill("mobile-project");
		await page.getByLabel(/github owner/i).fill("example");
		await page.getByLabel(/repository/i).fill("mobile-repo");
		await page.getByLabel(/workspace path/i).fill("/workspaces/mobile-project");
		await page.getByLabel(/development branch/i).fill("main");
		await page.getByLabel(/description/i).fill("Registered from mobile journey");

		await page.getByRole("button", { name: /^validate$/i }).click();
		await expect(page.getByText(/all required checks passed|passed/i).first()).toBeVisible();
		await assertNoHorizontalOverflow(page);

		await page.getByRole("button", { name: /create project/i }).click();
		await page.waitForURL(/\/projects\/[^/]+$/);
		await expect(page.getByRole("heading", { name: /mobile project/i })).toBeVisible();
		await assertNoHorizontalOverflow(page);
	});

	test("release and feature creation journeys complete without page overflow", async ({ page }) => {
		await signIn(page);

		await page.goto("/releases/new");
		await page.locator("#release-project").selectOption("project-1");
		await page.getByLabel(/^name$/i).fill("Mobile Release");
		await page.getByLabel(/^version$/i).fill("2.0.0");
		await page.getByLabel(/description/i).fill("Release from mobile");
		await page.getByRole("button", { name: /create release/i }).click();
		await page.waitForURL(/\/releases\/[^/]+$/);
		await expect(page.getByRole("heading", { name: /mobile release/i })).toBeVisible();
		await assertNoHorizontalOverflow(page);

		const releaseId = page.url().split("/").at(-1);
		await page.goto(`/features/new?projectId=project-1&releaseId=${releaseId}`);
		await page.getByLabel(/^title$/i).fill("Mobile Feature");
		await page.getByLabel(/^slug$/i).fill("mobile-feature");
		await page.getByLabel(/summary/i).fill("Feature created at 375px");
		await page.getByRole("button", { name: /create feature/i }).click();
		await page.waitForURL(/\/features\/[^/]+$/);
		await expect(page.getByRole("heading", { name: /mobile feature/i })).toBeVisible();
		await assertNoHorizontalOverflow(page);
	});

	test("task attach review and approval complete at 375px", async ({ page }) => {
		await signIn(page);
		await page.goto("/features/test-feature-planned");
		await assertNoHorizontalOverflow(page);

		await page.getByLabel(/task path/i).fill("docs/autopilotagent/example/example.json");
		await page.getByRole("button", { name: /^attach$/i }).click();
		await expect(page.getByRole("region", { name: /task review/i })).toBeVisible();
		await expect(page.getByText(/bootstrap/i).first()).toBeVisible();
		await assertNoHorizontalOverflow(page);

		await page.getByRole("button", { name: /approve.*queue/i }).click();
		const dialog = page.getByRole("dialog");
		await expect(dialog).toBeVisible();
		await assertNoHorizontalOverflow(page);
		await dialog.getByRole("button", { name: /^confirm$/i }).click();

		await expect(
			page
				.locator("[data-status]")
				.filter({ hasText: /develop|queue/i })
				.first(),
		).toBeVisible({
			timeout: 10_000,
		});
		await assertNoHorizontalOverflow(page);
	});

	test("progress cancellation retry failure and PR-link journeys complete at 375px", async ({
		page,
	}) => {
		await signIn(page);
		await page.goto("/features/test-feature-1");
		await assertNoHorizontalOverflow(page);

		await expect(page.getByRole("heading", { level: 1, name: /example feature/i })).toBeVisible();
		await expect(page.getByRole("region", { name: /development progress/i })).toBeVisible();
		await expect(page.getByRole("region", { name: /diagnostic log/i })).toBeVisible();

		const cancel = page.getByRole("button", { name: /^cancel$/i });
		await cancel.click();
		const cancelDialog = page.getByRole("dialog", { name: /cancel/i });
		await expect(cancelDialog).toBeVisible();
		await cancelDialog.getByRole("button", { name: /^confirm$/i }).click();
		await expect(
			page
				.locator("[data-status]")
				.filter({ hasText: /cancel/i })
				.first(),
		).toBeVisible({
			timeout: 10_000,
		});
		await assertNoHorizontalOverflow(page);

		const retry = page.getByRole("button", { name: /^retry$/i });
		await expect(retry).toBeVisible();
		await retry.click();
		const retryDialog = page.getByRole("dialog", { name: /retry/i });
		await expect(retryDialog).toBeVisible();
		await retryDialog.getByRole("button", { name: /^confirm$/i }).click();
		await expect(
			page
				.locator("[data-status]")
				.filter({ hasText: /develop|queue|running/i })
				.first(),
		).toBeVisible({ timeout: 10_000 });

		await page.goto("/features/test-feature-failed");
		await expect(page.getByText(/exited with code|review logs|failure/i).first()).toBeVisible();
		await assertNoHorizontalOverflow(page);

		await page.goto("/features/test-feature-1");
		await expect(page.getByRole("link", { name: /#42|view on github/i }).first()).toBeVisible();
		await assertNoConsolePrApproveOrMerge(page);
		await assertNoHorizontalOverflow(page);
	});

	test("primary tap targets are at least 44x44 where practical", async ({ page }) => {
		await signIn(page);
		await page.goto("/features/test-feature-1");
		await assertPrimaryTapTargets(page);
	});

	test("no critical action requires hover right-click drag or desktop-only interaction", async ({
		page,
	}) => {
		await signIn(page);
		await page.goto("/features/test-feature-1");
		await expect(page.getByRole("button", { name: /^cancel$/i })).toBeVisible();
		await expect(page.getByRole("link", { name: /github|#42/i }).first()).toBeVisible();
		await page.getByRole("button", { name: /^cancel$/i }).click();
		await expect(page.getByRole("dialog")).toBeVisible();
		await page.keyboard.press("Escape");
	});

	// Multi-route axe scans need more than the 30s default when two projects
	// run in parallel under qualification load.
	test("standards-based WCAG 2.2 AA scan reports no serious violations on core screens", async ({
		page,
	}) => {
		test.setTimeout(120_000);
		for (const route of CORE_ROUTES) {
			if (route === "/login") {
				await page.goto("/login");
			} else {
				await signIn(page);
				await page.goto(route);
			}
			await expect(page.locator("main, h1").first()).toBeVisible();
			await assertWcag22Aa(page, route);
			if (route !== "/login") {
				await assertNoConsolePrApproveOrMerge(page);
			}
		}
	});

	test("status is not color-only and live regions exist for view states", async ({ page }) => {
		await signIn(page);
		await page.goto("/features/test-feature-1");
		const status = page.locator("[data-status]").first();
		await expect(status).toBeVisible();
		const statusText = await status.textContent();
		expect(statusText?.trim().length).toBeGreaterThan(0);
		expect(await page.locator('[aria-live="polite"]').count()).toBeGreaterThanOrEqual(1);
	});

	test("UTC timestamps render as accessible local time elements", async ({ page }) => {
		await signIn(page);
		await page.goto("/activity");
		const time = page.locator("time[datetime]").first();
		await expect(time).toBeVisible();
		const datetime = await time.getAttribute("datetime");
		expect(datetime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect((await time.textContent())?.trim().length).toBeGreaterThan(0);
	});

	test("AxeBuilder is available as the standards-based engine including color-contrast", async ({
		page,
	}) => {
		await signIn(page);
		await assertWcag22Aa(page, "/");
	});
});
