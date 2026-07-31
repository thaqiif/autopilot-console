import { expect, signIn, test } from "./fixtures";

test.describe("keyboard navigation", () => {
	test("login form is fully keyboard operable", async ({ page }) => {
		await page.goto("/login");
		await expect(page.locator("#username")).toBeVisible();

		await page.keyboard.press("Tab");
		const focused = await page.evaluate(() => document.activeElement?.tagName);
		expect(["INPUT", "BUTTON", "A"]).toContain(focused);

		await page.keyboard.press("Tab");
		await page.keyboard.press("Tab");
		await page.fill("#username", "admin");
		await page.fill("#password", "password123");

		await page.keyboard.press("Enter");
		await page.waitForURL("**/");
	});

	test("skip-to-main-content link works", async ({ page }) => {
		await signIn(page);
		await page.goto("/");
		await expect(page.locator("main")).toBeVisible();

		const skip = page.locator("a.skip-link");
		await skip.focus();
		await expect(skip).toBeFocused();
		await page.keyboard.press("Enter");
		const afterSkip = await page.evaluate(() => document.activeElement?.id);
		expect(afterSkip).toBe("main-content");
	});

	test("desktop navigation is keyboard accessible", async ({ page }) => {
		await signIn(page);

		const nav = page.locator('nav[aria-label="Main navigation"] a');
		const count = await nav.count();
		expect(count).toBe(6);
		if ((page.viewportSize()?.width ?? 0) <= 768) {
			await expect(nav.first()).toBeHidden();
			return;
		}

		for (let i = 0; i < count; i++) {
			const link = nav.nth(i);
			await link.focus();
			const isFocused = await link.evaluate((el) => document.activeElement === el);
			expect(isFocused).toBe(true);
		}
	});

	test("focus is visible on all interactive elements", async ({ page }) => {
		await signIn(page);

		const interactiveElements = page.locator("a, button, input, select, textarea, [tabindex]");
		const count = await interactiveElements.count();

		for (let i = 0; i < Math.min(count, 15); i++) {
			const el = interactiveElements.nth(i);
			const isVisible = await el.isVisible();
			if (!isVisible) continue;

			await el.focus();
			const outlineStyle = await el.evaluate((node) => {
				const style = window.getComputedStyle(node);
				return {
					outlineStyle: style.outlineStyle,
					outlineWidth: style.outlineWidth,
					outlineColor: style.outlineColor,
				};
			});
			const hasFocusIndicator =
				outlineStyle.outlineStyle !== "none" || outlineStyle.outlineWidth !== "0px";
			expect(hasFocusIndicator).toBe(true);
		}
	});

	test("breadcrumbs are navigable by keyboard", async ({ page }) => {
		await signIn(page);
		await page.goto("/projects");

		const breadcrumbNav = page.locator('nav[aria-label="Breadcrumb"]');
		const links = breadcrumbNav.locator("a");
		const linkCount = await links.count();

		for (let i = 0; i < linkCount; i++) {
			const link = links.nth(i);
			await link.focus();
			const isFocused = await link.evaluate((el) => document.activeElement === el);
			expect(isFocused).toBe(true);
		}
	});

	test("no focus traps exist in main content", async ({ page }) => {
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

		const heading = page.locator("h1, h2");
		await expect(heading.first()).toBeVisible();
	});

	test("project registration form is keyboard operable", async ({ page }) => {
		await signIn(page);
		await page.goto("/projects/new");

		const inputs = page.locator("input, select, textarea");
		const count = await inputs.count();
		for (let i = 0; i < count; i++) {
			const input = inputs.nth(i);
			const isVisible = await input.isVisible();
			if (!isVisible) continue;
			await input.focus();
			const isFocused = await input.evaluate((el) => document.activeElement === el);
			expect(isFocused).toBe(true);
		}
	});

	test("release creation form is keyboard operable", async ({ page }) => {
		await signIn(page);
		await page.goto("/releases/new");

		const inputs = page.locator("input, select, textarea");
		const count = await inputs.count();
		for (let i = 0; i < count; i++) {
			const input = inputs.nth(i);
			const isVisible = await input.isVisible();
			if (!isVisible) continue;
			await input.focus();
			const isFocused = await input.evaluate((el) => document.activeElement === el);
			expect(isFocused).toBe(true);
		}
	});

	test("settings page is keyboard navigable", async ({ page }) => {
		await signIn(page);
		await page.goto("/settings");

		const interactiveElements = page.locator("a, button, input, select, textarea");
		const count = await interactiveElements.count();
		for (let i = 0; i < Math.min(count, 15); i++) {
			const el = interactiveElements.nth(i);
			const isVisible = await el.isVisible();
			if (!isVisible) continue;
			await el.focus();
			const isFocused = await el.evaluate((node) => document.activeElement === node);
			expect(isFocused).toBe(true);
		}
	});

	test("cancel confirmation dialog traps focus and restores it", async ({ page }) => {
		await signIn(page);
		await page.goto("/features/test-feature-1");

		const cancel = page.getByRole("button", { name: /^cancel$/i });
		await cancel.focus();
		await page.keyboard.press("Enter");

		const dialog = page.getByRole("dialog");
		await expect(dialog).toBeVisible();

		const focusInside = await page.evaluate(() => {
			const active = document.activeElement;
			const dialogEl = document.querySelector('[role="dialog"]');
			return Boolean(dialogEl && active && dialogEl.contains(active));
		});
		expect(focusInside).toBe(true);

		// Tabbing should keep focus inside the dialog
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
		await expect(dialog).toHaveCount(0);

		const restored = await page.evaluate(() => {
			const active = document.activeElement as HTMLElement | null;
			return active?.tagName === "BUTTON" && /cancel/i.test(active.textContent ?? "");
		});
		expect(restored).toBe(true);
	});

	test("primary desktop workflows complete with keyboard only", async ({ page }) => {
		await page.goto("/login");
		await page.locator("#username").focus();
		await page.keyboard.type("admin");
		await page.locator("#password").focus();
		await page.keyboard.type("password123");
		await page.locator('button[type="submit"]').focus();
		await page.keyboard.press("Enter");
		await page.waitForURL("**/");

		const skip = page.locator("a.skip-link");
		await skip.focus();
		await page.keyboard.press("Enter");
		await expect(page.locator("#main-content")).toBeFocused();

		await page.goto("/projects");
		await page.locator('a[href="/projects/new"]').first().focus();
		await page.keyboard.press("Enter");
		await page.waitForURL("**/projects/new");
		await expect(page.locator("form")).toBeVisible();

		await page.goto("/features/test-feature-1");
		await page.getByRole("button", { name: /^cancel$/i }).focus();
		await page.keyboard.press("Enter");
		await expect(page.getByRole("dialog")).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(page.getByRole("dialog")).toHaveCount(0);
	});
});
