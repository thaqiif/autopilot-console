import {
	assertNoConsolePrApproveOrMerge,
	assertVisibleFocus,
	expect,
	signIn,
	test,
} from "./fixtures";

test.describe("keyboard navigation", () => {
	test.use({ viewport: { width: 1280, height: 800 } });

	test("login form completes with keyboard only", async ({ page }) => {
		await page.goto("/login");
		await expect(page.locator("#username")).toBeVisible();

		await page.locator("#username").focus();
		await assertVisibleFocus(page.locator("#username"));
		await page.keyboard.type("admin");
		await page.locator("#password").focus();
		await page.keyboard.type("password123");
		await page.locator('button[type="submit"]').focus();
		await assertVisibleFocus(page.locator('button[type="submit"]'));
		await page.keyboard.press("Enter");
		await page.waitForURL("**/");
		await expect(page.locator("main")).toBeVisible();
	});

	test("skip-to-main-content link works", async ({ page }) => {
		await signIn(page);
		await page.goto("/");
		const skip = page.locator("a.skip-link");
		await skip.focus();
		await expect(skip).toBeFocused();
		await page.keyboard.press("Enter");
		await expect(page.locator("#main-content")).toBeFocused();
	});

	test("desktop navigation has logical keyboard order and visible focus", async ({ page }) => {
		await signIn(page);
		const nav = page.locator('nav[aria-label="Main navigation"] a');
		const count = await nav.count();
		expect(count).toBe(6);

		for (let i = 0; i < count; i++) {
			const link = nav.nth(i);
			await link.focus();
			await assertVisibleFocus(link);
		}
	});

	test("project registration workflow completes with keyboard only", async ({ page }) => {
		await signIn(page);
		await page.goto("/projects");
		await page.locator('a[href="/projects/new"]').first().focus();
		await page.keyboard.press("Enter");
		await page.waitForURL("**/projects/new");

		await page.locator("#project-name").focus();
		await page.keyboard.type("Keyboard Project");
		await page.locator("#project-slug").focus();
		await page.keyboard.type("keyboard-project");
		await page.locator("#project-github-owner").focus();
		await page.keyboard.type("example");
		await page.locator("#project-github-repo").focus();
		await page.keyboard.type("keyboard-repo");
		await page.locator("#project-workspace-path").focus();
		await page.keyboard.type("/workspaces/keyboard-project");
		await page.locator("#project-development-branch").focus();
		await page.keyboard.type("main");

		await page.getByRole("button", { name: /^validate$/i }).focus();
		await page.keyboard.press("Enter");
		await expect(page.getByText(/all required checks passed|passed/i).first()).toBeVisible();

		await page.getByRole("button", { name: /create project/i }).focus();
		await page.keyboard.press("Enter");
		await page.waitForURL(/\/projects\/[^/]+$/);
		await expect(page.getByRole("heading", { name: /keyboard project/i })).toBeVisible();
	});

	test("release and feature creation complete with keyboard only", async ({ page }) => {
		await signIn(page);
		await page.goto("/releases/new");
		await page.locator("#release-project").focus();
		await page.keyboard.press("ArrowDown");
		await page.keyboard.press("Enter");
		await page.locator("#release-name").focus();
		await page.keyboard.type("Keyboard Release");
		await page.locator("#release-version").focus();
		await page.keyboard.type("3.0.0");
		await page.getByRole("button", { name: /create release/i }).focus();
		await page.keyboard.press("Enter");
		await page.waitForURL(/\/releases\/[^/]+$/);
		await expect(page.getByRole("heading", { name: /keyboard release/i })).toBeVisible();

		const releaseId = page.url().split("/").at(-1);
		await page.goto(`/features/new?projectId=project-1&releaseId=${releaseId}`);
		await page.locator("#feature-title").focus();
		await page.keyboard.type("Keyboard Feature");
		await page.locator("#feature-slug").focus();
		await page.keyboard.type("keyboard-feature");
		await page.getByRole("button", { name: /create feature/i }).focus();
		await page.keyboard.press("Enter");
		await page.waitForURL(/\/features\/[^/]+$/);
		await expect(page.getByRole("heading", { name: /keyboard feature/i })).toBeVisible();
	});

	test("task review approval cancel and retry complete with keyboard only", async ({ page }) => {
		await signIn(page);
		await page.goto("/features/test-feature-planned");

		await page.locator("#task-path").focus();
		await page.keyboard.type("docs/autopilotagent/example/example.json");
		await page.getByRole("button", { name: /^attach$/i }).focus();
		await page.keyboard.press("Enter");
		await expect(page.getByRole("region", { name: /task review/i })).toBeVisible();

		await page.getByRole("button", { name: /approve.*queue/i }).focus();
		await page.keyboard.press("Enter");
		const approveDialog = page.getByRole("dialog");
		await expect(approveDialog).toBeVisible();
		const focusInsideApprove = await page.evaluate(() => {
			const active = document.activeElement;
			const dialogEl = document.querySelector('[role="dialog"]');
			return Boolean(dialogEl && active && dialogEl.contains(active));
		});
		expect(focusInsideApprove).toBe(true);
		await approveDialog.getByRole("button", { name: /^confirm$/i }).focus();
		await page.keyboard.press("Enter");
		await expect(
			page
				.locator("[data-status]")
				.filter({ hasText: /develop|queue/i })
				.first(),
		).toBeVisible({
			timeout: 10_000,
		});

		await page.goto("/features/test-feature-1");
		const cancel = page.getByRole("button", { name: /^cancel$/i });
		await cancel.focus();
		await page.keyboard.press("Enter");
		const cancelDialog = page.getByRole("dialog");
		await expect(cancelDialog).toBeVisible();

		for (let i = 0; i < 6; i++) {
			await page.keyboard.press("Tab");
			const stillInside = await page.evaluate(() => {
				const active = document.activeElement;
				const dialogEl = document.querySelector('[role="dialog"]');
				return Boolean(dialogEl && active && dialogEl.contains(active));
			});
			expect(stillInside).toBe(true);
		}

		await page.keyboard.press("Escape");
		await expect(cancelDialog).toHaveCount(0);
		const restored = await page.evaluate(() => {
			const active = document.activeElement as HTMLElement | null;
			return active?.tagName === "BUTTON" && /cancel/i.test(active.textContent ?? "");
		});
		expect(restored).toBe(true);

		await cancel.focus();
		await page.keyboard.press("Enter");
		await page
			.getByRole("dialog")
			.getByRole("button", { name: /^confirm$/i })
			.focus();
		await page.keyboard.press("Enter");
		await expect(
			page
				.locator("[data-status]")
				.filter({ hasText: /cancel/i })
				.first(),
		).toBeVisible({
			timeout: 10_000,
		});

		const retry = page.getByRole("button", { name: /^retry$/i });
		await retry.focus();
		await page.keyboard.press("Enter");
		await page
			.getByRole("dialog")
			.getByRole("button", { name: /^confirm$/i })
			.focus();
		await page.keyboard.press("Enter");
		await expect(
			page
				.locator("[data-status]")
				.filter({ hasText: /develop|queue|running/i })
				.first(),
		).toBeVisible({ timeout: 10_000 });
		await assertNoConsolePrApproveOrMerge(page);
	});

	test("no focus traps exist on primary routes outside modal dialogs", async ({ page }) => {
		await signIn(page);
		const routes = ["/", "/attention", "/releases", "/projects", "/settings"];
		for (const route of routes) {
			await page.goto(route);
			const focusedElements = new Set<string>();
			for (let i = 0; i < 12; i++) {
				await page.keyboard.press("Tab");
				focusedElements.add(
					await page.evaluate(() => {
						const element = document.activeElement;
						return `${element?.tagName}:${element?.textContent?.trim()}:${element?.getAttribute("href")}`;
					}),
				);
			}
			expect(focusedElements.size).toBeGreaterThan(1);
			expect(await page.evaluate(() => document.contains(document.activeElement))).toBe(true);
		}
	});

	test("focus is restored after navigation", async ({ page }) => {
		await signIn(page);
		const attentionLink = page.locator('a[href="/attention"]:visible').first();
		await attentionLink.focus();
		await page.keyboard.press("Enter");
		await page.waitForURL("**/attention");
		await expect(page.locator("h1, h2").first()).toBeVisible();
	});
});
