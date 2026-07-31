import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { DiagnosticLogExcerpt } from "./diagnostic-log-excerpt";

describe("DiagnosticLogExcerpt", () => {
	afterEach(() => cleanup());

	test("renders log content in a pre/code block", () => {
		const { container } = render(<DiagnosticLogExcerpt log="line 1\nline 2\nline 3" />);
		const section = container.querySelector('[aria-label="Diagnostic log"]');
		const pre = section?.querySelector("pre");
		expect(pre).toBeTruthy();
		expect(pre?.textContent).toContain("line 1");
	});

	test("redacts GitHub tokens from log output", () => {
		const { container } = render(<DiagnosticLogExcerpt log="token: ghp_abc123def456" />);
		const section = container.querySelector('[aria-label="Diagnostic log"]');
		const pre = section?.querySelector("pre");
		expect(pre?.textContent).toContain("[REDACTED]");
		expect(pre?.textContent).not.toContain("ghp_abc123def456");
	});

	test("redacts Bearer tokens from log output", () => {
		const { container } = render(
			<DiagnosticLogExcerpt log="auth: Bearer eyJhbGc.eyJzdWI.signature" />,
		);
		const section = container.querySelector('[aria-label="Diagnostic log"]');
		const pre = section?.querySelector("pre");
		expect(pre?.textContent).toContain("Bearer [REDACTED]");
	});

	test("redacts x-access-token credentials from URLs", () => {
		const { container } = render(
			<DiagnosticLogExcerpt log="url: x-access-token:secret123@github.com" />,
		);
		const section = container.querySelector('[aria-label="Diagnostic log"]');
		const pre = section?.querySelector("pre");
		expect(pre?.textContent).toContain("[REDACTED]");
		expect(pre?.textContent).not.toContain("secret123");
	});

	test("uses the shared redaction policy for every supported credential shape", () => {
		const secrets = [
			"github_pat_abcdefghijklmnopqrstuvwxyz123456",
			"Authorization: Basic dXNlcjpwYXNzd29yZA==",
			"Cookie: ac_session=opaque-value",
			"password=hunter2",
			"https://owner:private-password@example.com/repo",
		];
		const { container } = render(<DiagnosticLogExcerpt log={secrets.join("\n")} />);
		const output = container.querySelector("pre")?.textContent ?? "";
		for (const secret of [
			"github_pat_abcdefghijklmnopqrstuvwxyz123456",
			"dXNlcjpwYXNzd29yZA==",
			"opaque-value",
			"hunter2",
			"private-password",
		]) {
			expect(output).not.toContain(secret);
		}
	});

	test("truncates log when maxLines is exceeded", () => {
		const log = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
		render(<DiagnosticLogExcerpt log={log} maxLines={5} />);
		const truncation = screen.getByRole("status");
		expect(truncation.textContent).toContain("Truncated");
		expect(truncation.textContent).toContain("15 more lines");
	});

	test("does not show truncation when log fits within maxLines", () => {
		render(<DiagnosticLogExcerpt log="line 1\nline 2" maxLines={5} />);
		const truncation = screen.queryByRole("status");
		expect(truncation).toBeNull();
	});

	test("shows truncation marker when truncated prop is true", () => {
		render(<DiagnosticLogExcerpt log="line 1" truncated />);
		const truncation = screen.getByRole("status");
		expect(truncation.textContent).toContain("Truncated");
	});

	test("has accessible section label", () => {
		const { container } = render(<DiagnosticLogExcerpt log="test log" />);
		const section = container.querySelector('[aria-label="Diagnostic log"]');
		expect(section).toBeTruthy();
	});

	test("renders copy button for mobile log usability", () => {
		render(<DiagnosticLogExcerpt log="line 1\nline 2" />);
		const copyButton = screen.getByRole("button", { name: /copy/i });
		expect(copyButton).toBeTruthy();
	});

	test("copy button has minimum tap target size", () => {
		render(<DiagnosticLogExcerpt log="test" />);
		const copyButton = screen.getByRole("button", { name: /copy/i });
		const styles = window.getComputedStyle(copyButton);
		const minHeight = Number.parseFloat(styles.minHeight);
		expect(minHeight).toBeGreaterThanOrEqual(44);
	});

	test("renders download button for mobile log usability", () => {
		render(<DiagnosticLogExcerpt log="line 1\nline 2" />);
		const downloadButton = screen.getByRole("button", { name: /download/i });
		expect(downloadButton).toBeTruthy();
	});

	test("download button has minimum tap target size", () => {
		render(<DiagnosticLogExcerpt log="test" />);
		const downloadButton = screen.getByRole("button", { name: /download/i });
		const styles = window.getComputedStyle(downloadButton);
		const minHeight = Number.parseFloat(styles.minHeight);
		expect(minHeight).toBeGreaterThanOrEqual(44);
	});
});
