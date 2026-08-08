import { type ReactNode, useEffect, useRef } from "react";

const FOCUSABLE =
	'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface FocusTrapProps {
	active: boolean;
	onEscape?: () => void;
	children: ReactNode;
	/** Restores focus to this element when the trap deactivates. */
	restoreFocusTo?: HTMLElement | null;
}

/**
 * Keyboard focus trap for modal dialogs: keeps Tab cycling inside the container
 * and restores focus to the opener on unmount/escape.
 */
export function FocusTrap({ active, onEscape, children, restoreFocusTo }: FocusTrapProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const previouslyFocused = useRef<HTMLElement | null>(null);

	useEffect(() => {
		if (!active) return;

		previouslyFocused.current =
			restoreFocusTo ??
			(document.activeElement instanceof HTMLElement ? document.activeElement : null);

		const container = containerRef.current;
		if (!container) return;

		const focusables = () =>
			Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
				(el) => !el.hasAttribute("disabled") && el.offsetParent !== null,
			);

		const initial = focusables()[0];
		initial?.focus();

		function onKeyDown(event: KeyboardEvent) {
			if (event.key === "Escape") {
				event.preventDefault();
				onEscape?.();
				return;
			}
			if (event.key !== "Tab") return;

			const items = focusables();
			const first = items[0];
			const last = items[items.length - 1];
			if (!first || !last) {
				event.preventDefault();
				return;
			}
			const current = document.activeElement as HTMLElement | null;

			if (event.shiftKey) {
				if (current === first || !container?.contains(current)) {
					event.preventDefault();
					last.focus();
				}
			} else if (current === last || !container?.contains(current)) {
				event.preventDefault();
				first.focus();
			}
		}

		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("keydown", onKeyDown);
			const restore = previouslyFocused.current;
			if (restore && document.contains(restore)) {
				restore.focus();
			}
		};
	}, [active, onEscape, restoreFocusTo]);

	return (
		<div ref={containerRef} data-focus-trap={active ? "true" : undefined}>
			{children}
		</div>
	);
}
