import { useEffect, useRef } from "react";
import { createSseClient } from "./sse";

/**
 * Subscribe to live-update SSE. On disconnect, mark the page stale and
 * re-fetch authoritative REST state. The refresh callback is read from a
 * ref so callers can change loaders (filters, pagination) without tearing
 * down and recreating the EventSource.
 */
export function useSseRestRefresh(
	onRefresh: () => void,
	options?: {
		url?: string;
		onStale?: () => void;
	},
): void {
	const onRefreshRef = useRef(onRefresh);
	const onStaleRef = useRef(options?.onStale);
	const url = options?.url ?? "/api/events";

	useEffect(() => {
		onRefreshRef.current = onRefresh;
	}, [onRefresh]);

	useEffect(() => {
		onStaleRef.current = options?.onStale;
	}, [options?.onStale]);

	useEffect(() => {
		const sse = createSseClient({
			url,
			onDisconnect: () => {
				onStaleRef.current?.();
				onRefreshRef.current();
			},
		});
		sse.connect();
		return () => sse.close();
	}, [url]);
}
