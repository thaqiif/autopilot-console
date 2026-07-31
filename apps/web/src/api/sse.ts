/**
 * Thin SSE wrapper. Events are a live hint only — every disconnect must
 * re-fetch authoritative state through REST (onDisconnect).
 */

export interface SseClientOptions {
	url: string;
	/** Invoked on every disconnect/error so callers can reload from REST. */
	onDisconnect?: () => void;
	onMessage?: (data: string, event: MessageEvent) => void;
	/** Delay before automatic reconnect. Defaults to 1500ms. */
	reconnectDelayMs?: number;
	/** Injectable for tests. Defaults to the browser EventSource. */
	EventSourceImpl?: typeof EventSource;
	withCredentials?: boolean;
}

export interface SseClient {
	connect(): void;
	close(): void;
	readonly connected: boolean;
}

export function createSseClient(options: SseClientOptions): SseClient {
	const EventSourceImpl = options.EventSourceImpl ?? EventSource;
	const reconnectDelayMs = options.reconnectDelayMs ?? 1500;

	let source: EventSource | null = null;
	let closed = false;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let connected = false;

	function clearReconnectTimer() {
		if (reconnectTimer !== null) {
			clearTimeout(reconnectTimer);
			reconnectTimer = null;
		}
	}

	function attach(es: EventSource) {
		es.onmessage = (event) => {
			options.onMessage?.(event.data, event);
		};

		es.onerror = () => {
			connected = false;
			options.onDisconnect?.();
			try {
				es.close();
			} catch {
				// ignore close races
			}
			if (source === es) source = null;
			if (!closed) {
				clearReconnectTimer();
				reconnectTimer = setTimeout(() => {
					if (!closed) open();
				}, reconnectDelayMs);
			}
		};

		es.onopen = () => {
			connected = true;
		};
	}

	function open() {
		if (closed) return;
		clearReconnectTimer();
		if (source) {
			try {
				source.close();
			} catch {
				// ignore
			}
			source = null;
		}
		const es = new EventSourceImpl(options.url, {
			withCredentials: options.withCredentials ?? true,
		});
		source = es;
		attach(es);
	}

	return {
		connect() {
			closed = false;
			open();
		},
		close() {
			closed = true;
			connected = false;
			clearReconnectTimer();
			if (source) {
				try {
					source.close();
				} catch {
					// ignore
				}
				source = null;
			}
		},
		get connected() {
			return connected;
		},
	};
}
