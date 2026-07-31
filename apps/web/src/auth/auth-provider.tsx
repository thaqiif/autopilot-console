import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { type ApiClient, createApiClient } from "../api/client";

export interface AuthState {
	authenticated: boolean;
	loading: boolean;
	client: ApiClient;
	login: (username: string, password: string) => Promise<boolean>;
	logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function useAuth(): AuthState {
	const ctx = useContext(AuthContext);
	if (!ctx) throw new Error("useAuth must be used within AuthProvider");
	return ctx;
}

export interface AuthProviderProps {
	children: ReactNode;
	initialAuthenticated?: boolean;
	client?: ApiClient;
}

const defaultClient = createApiClient({ baseUrl: "" });

interface AuthPayload {
	authenticated: boolean;
	username?: string;
	csrfToken: string;
}

export function AuthProvider({
	children,
	initialAuthenticated,
	client = defaultClient,
}: AuthProviderProps) {
	const shouldRestore = initialAuthenticated === undefined;
	const [authenticated, setAuthenticated] = useState(initialAuthenticated ?? false);
	const [loading, setLoading] = useState(shouldRestore);

	useEffect(() => {
		client.setUnauthorizedHandler(() => {
			client.setCsrfToken(null);
			setAuthenticated(false);
		});
		if (!shouldRestore) {
			setLoading(false);
			return () => client.setUnauthorizedHandler(null);
		}

		let active = true;
		void client.get<AuthPayload>("/api/auth/session").then((result) => {
			if (!active) return;
			if (result.ok && result.data.authenticated) {
				client.setCsrfToken(result.data.csrfToken);
				setAuthenticated(true);
			} else {
				client.setCsrfToken(null);
				setAuthenticated(false);
			}
			setLoading(false);
		});
		return () => {
			active = false;
			client.setUnauthorizedHandler(null);
		};
	}, [client, shouldRestore]);

	const login = useCallback(
		async (username: string, password: string) => {
			const result = await client.post<AuthPayload>("/api/auth/login", { username, password });
			if (!result.ok || !result.data.authenticated) return false;
			client.setCsrfToken(result.data.csrfToken);
			setAuthenticated(true);
			return true;
		},
		[client],
	);

	const logout = useCallback(async () => {
		await client.post("/api/auth/logout");
		client.setCsrfToken(null);
		setAuthenticated(false);
	}, [client]);

	return (
		<AuthContext.Provider value={{ authenticated, loading, client, login, logout }}>
			{children}
		</AuthContext.Provider>
	);
}
