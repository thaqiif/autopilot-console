import { assertNoHorizontalOverflow, expect, signIn, test } from "./fixtures";

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
		await assertNoHorizontalOverflow(page);
	});

	test("portfolio overview renders without horizontal scroll at 375px", async ({ page }) => {
		await signIn(page);
		await assertNoHorizontalOverflow(page);
		await expect(
			page.getByRole("heading", { name: /needs your attention|overview|portfolio/i }).first(),
		).toBeVisible();
	});

	test("primary tap targets are at least 44x44 CSS pixels", async ({ page }) => {
		await signIn(page);

		const boxes = await page.evaluate(() => {
			const nodes = Array.from(document.querySelectorAll("button, a[href]")).filter((el) => {
				const style = window.getComputedStyle(el);
				const rect = el.getBoundingClientRect();
				return (
					style.display !== "none" &&
					style.visibility !== "hidden" &&
					rect.width > 0 &&
					rect.height > 0
				);
			});
			return nodes.slice(0, 20).map((el) => {
				const rect = el.getBoundingClientRect();
				return { width: rect.width, height: rect.height };
			});
		});
		expect(boxes.length).toBeGreaterThan(0);
		for (const box of boxes) {
			expect(box.width).toBeGreaterThanOrEqual(44);
			expect(box.height).toBeGreaterThanOrEqual(44);
		}
	});

	test("automated accessibility scan finds no serious violations", async ({ page }) => {
		await signIn(page);

		const violations = await page.evaluate(() => {
			const results: string[] = [];
			const main = document.querySelector("main");
			if (!main) results.push("missing main landmark");

			const headings = document.querySelectorAll("h1, h2, h3, h4, h5, h6");
			if (headings.length === 0) results.push("no headings found");

			const images = document.querySelectorAll("img");
			for (const img of images) {
				if (!img.getAttribute("alt") && !img.getAttribute("aria-label")) {
					results.push(`image missing alt: ${img.src}`);
				}
			}

			const buttons = document.querySelectorAll("button");
			for (const btn of buttons) {
				const text = btn.textContent?.trim();
				const ariaLabel = btn.getAttribute("aria-label");
				if (!text && !ariaLabel) {
					results.push("button without accessible name");
				}
			}

			const unlabeled = document.querySelectorAll("input:not([type=hidden]), select, textarea");
			for (const control of unlabeled) {
				const id = control.getAttribute("id");
				const labelledBy = control.getAttribute("aria-labelledby");
				const ariaLabel = control.getAttribute("aria-label");
				const hasLabel = id ? Boolean(document.querySelector(`label[for="${id}"]`)) : false;
				if (!hasLabel && !labelledBy && !ariaLabel) {
					results.push(`control without label: ${control.outerHTML.slice(0, 80)}`);
				}
			}

			return results;
		});
		expect(violations).toEqual([]);
	});

	test("status announcements work for view states", async ({ page }) => {
		await signIn(page);
		const liveRegion = page.locator('[aria-live="polite"]');
		expect(await liveRegion.count()).toBeGreaterThanOrEqual(1);
	});

	test("project registration flow is accessible at 375px", async ({ page }) => {
		await signIn(page);
		await page.goto("/projects/new");
		await assertNoHorizontalOverflow(page);
		const labels = page.locator("label");
		expect(await labels.count()).toBeGreaterThan(0);
		await expect(page.getByLabel(/name/i).first()).toBeVisible();
	});

	test("release and feature planning pages have no page-level overflow", async ({ page }) => {
		await signIn(page);
		for (const route of ["/releases", "/releases/new", "/features/new", "/projects"]) {
			await page.goto(route);
			await expect(page.locator("main")).toBeVisible();
			await assertNoHorizontalOverflow(page);
		}
	});

	test("navigation works without page-level horizontal scroll", async ({ page }) => {
		await signIn(page);
		const routes = ["/attention", "/releases", "/projects", "/activity", "/settings"];
		for (const route of routes) {
			await page.goto(route);
			await assertNoHorizontalOverflow(page);
		}
	});

	test("color is not the sole means of conveying status", async ({ page }) => {
		await signIn(page);
		await page.goto("/features/test-feature-1");
		await expect(page.locator("[data-status]").first()).toBeVisible();
		const statusText = await page.locator("[data-status]").first().textContent();
		expect(statusText?.trim().length).toBeGreaterThan(0);

		const statusElements = page.locator(
			'[role="status"]:not(.sr-only), [role="alert"]:not(.sr-only)',
		);
		const count = await statusElements.count();
		for (let i = 0; i < count; i++) {
			const el = statusElements.nth(i);
			const text = await el.textContent();
			const ariaLabel = await el.getAttribute("aria-label");
			expect(text || ariaLabel).toBeTruthy();
		}
	});

	test("feature detail job progress cancel and PR journeys complete at 375px", async ({ page }) => {
		await signIn(page);
		await page.goto("/features/test-feature-1");
		await assertNoHorizontalOverflow(page);

		await expect(page.getByRole("heading", { level: 1, name: /example feature/i })).toBeVisible();
		await expect(page.getByRole("region", { name: /development progress/i })).toBeVisible();

		const cancel = page.getByRole("button", { name: /^cancel$/i });
		await expect(cancel).toBeVisible();
		await cancel.click();
		const dialog = page.getByRole("dialog");
		await expect(dialog).toBeVisible();
		await assertNoHorizontalOverflow(page);
		await page
			.getByRole("button", { name: /^cancel$/i })
			.last()
			.click();

		await expect(page.getByRole("link", { name: /#42|view on github/i }).first()).toBeVisible();
		await expect(page.getByRole("region", { name: /diagnostic log/i })).toBeVisible();
		await expect(page.getByRole("button", { name: /copy log/i })).toBeVisible();
		await expect(page.getByRole("button", { name: /download log/i })).toBeVisible();
	});

	test("task review page is readable at 375px without horizontal scroll", async ({ page }) => {
		await signIn(page);
		await page.goto("/features/test-feature-1");
		await assertNoHorizontalOverflow(page);
		await expect(page.getByText(/bootstrap/i).first()).toBeVisible();
	});

	test("job progress section renders without horizontal scroll at 375px", async ({ page }) => {
		await signIn(page);
		await page.goto("/features/test-feature-1");
		await assertNoHorizontalOverflow(page);
		await expect(
			page.locator('[data-status="in_progress"], [data-status="passed"]').first(),
		).toBeVisible();
	});

	test("time elements use datetime attribute for accessibility", async ({ page }) => {
		await signIn(page);
		await page.goto("/activity");
		await expect(page.getByText(/project created/i)).toBeVisible();

		const timeElements = page.locator("time[datetime]");
		const count = await timeElements.count();
		expect(count).toBeGreaterThan(0);
		for (let i = 0; i < count; i++) {
			const datetime = await timeElements.nth(i).getAttribute("datetime");
			expect(datetime).toBeTruthy();
			expect(datetime).toMatch(/^\d{4}-\d{2}-\d{2}/);
		}
	});

	test("all data pages resolve without an error state", async ({ page }) => {
		await signIn(page);
		const routes = [
			"/",
			"/attention",
			"/releases",
			"/projects",
			"/activity",
			"/settings",
			"/features/test-feature-1",
			"/projects/project-1",
			"/releases/release-1",
		];
		for (const route of routes) {
			await page.goto(route);
			await expect(page.locator("main")).toBeVisible();
			await expect(
				page.locator('[role="alert"]:not(.sr-only)'),
				`unexpected error state on ${route}`,
			).toHaveCount(0);
			await assertNoHorizontalOverflow(page);
		}
	});

	test("diagnostic log excerpt has accessible truncation indicator", async ({ page }) => {
		await signIn(page);
		await page.goto("/features/test-feature-1");
		const truncation = page.locator('[role="status"]:has-text("Truncated")');
		await expect(truncation).toBeVisible();
		await expect(truncation).toContainText(/more lines/i);
	});

	test("no critical action depends on hover right-click or drag", async ({ page }) => {
		await signIn(page);
		await page.goto("/features/test-feature-1");
		// Cancel is a visible button, not hover-only
		await expect(page.getByRole("button", { name: /^cancel$/i })).toBeVisible();
		// PR open is a normal link
		await expect(page.getByRole("link", { name: /github|#42/i }).first()).toBeVisible();
		// Dialog opens from click, not drag
		await page.getByRole("button", { name: /^cancel$/i }).click();
		await expect(page.getByRole("dialog")).toBeVisible();
	});
	test("core data routes keep tables/cards and logs usable without page overflow", async ({
		page,
	}) => {
		await signIn(page);
		const routes = [
			"/",
			"/attention",
			"/releases",
			"/projects",
			"/activity",
			"/settings",
			"/features/test-feature-1",
			"/projects/project-1",
			"/releases/release-1",
		];
		for (const route of routes) {
			await page.goto(route);
			await expect(page.locator("main")).toBeVisible();
			await assertNoHorizontalOverflow(page);

			const statuses = page.locator("[data-status]");
			const count = await statuses.count();
			for (let i = 0; i < Math.min(count, 8); i++) {
				const text = await statuses.nth(i).textContent();
				expect((text ?? "").trim().length, `color-only status on ${route}`).toBeGreaterThan(0);
			}
		}

		await page.goto("/features/test-feature-1");
		await expect(page.getByRole("button", { name: /copy log/i })).toBeVisible();
		await expect(page.getByRole("button", { name: /download log/i })).toBeVisible();
		await assertNoHorizontalOverflow(page);
	});

	test("UTC timestamps render as local accessible time elements", async ({ page }) => {
		await signIn(page);
		await page.goto("/activity");
		const time = page.locator("time[datetime]").first();
		await expect(time).toBeVisible();
		const datetime = await time.getAttribute("datetime");
		expect(datetime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		const text = await time.textContent();
		expect((text ?? "").trim().length).toBeGreaterThan(0);
	});
});
