import { createContext, type ReactNode, useCallback, useContext, useRef, useState } from "react";

export interface StatusAnnouncer {
	announce: (message: string, priority?: "polite" | "assertive") => void;
}

const StatusContext = createContext<StatusAnnouncer | null>(null);

export function useStatusAnnouncer(): StatusAnnouncer {
	const ctx = useContext(StatusContext);
	if (!ctx) throw new Error("useStatusAnnouncer must be used within StatusAnnouncerProvider");
	return ctx;
}

export function StatusAnnouncerProvider({ children }: { children: ReactNode }) {
	const [politeMessage, setPoliteMessage] = useState("");
	const [assertiveMessage, setAssertiveMessage] = useState("");
	const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const announce = useCallback((message: string, priority: "polite" | "assertive" = "polite") => {
		if (timeoutRef.current) clearTimeout(timeoutRef.current);

		if (priority === "assertive") {
			setAssertiveMessage("");
			requestAnimationFrame(() => setAssertiveMessage(message));
		} else {
			setPoliteMessage("");
			requestAnimationFrame(() => setPoliteMessage(message));
		}

		timeoutRef.current = setTimeout(() => {
			setPoliteMessage("");
			setAssertiveMessage("");
		}, 5000);
	}, []);

	return (
		<StatusContext.Provider value={{ announce }}>
			{children}
			<div aria-live="polite" className="sr-only" role="status" data-testid="status-polite">
				{politeMessage}
			</div>
			<div aria-live="assertive" className="sr-only" role="alert" data-testid="status-assertive">
				{assertiveMessage}
			</div>
		</StatusContext.Provider>
	);
}
