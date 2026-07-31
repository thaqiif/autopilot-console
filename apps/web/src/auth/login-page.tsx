import { type FormEvent, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "./auth-provider";

export function LoginPage() {
	const { login } = useAuth();
	const location = useLocation();
	const navigate = useNavigate();
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState<string | null>(null);

	async function handleSubmit(e: FormEvent) {
		e.preventDefault();
		setError(null);
		const ok = await login(username, password);
		if (!ok) {
			setError("Invalid credentials");
			return;
		}
		const from = (location.state as { from?: string } | null)?.from ?? "/";
		navigate(from, { replace: true });
	}

	return (
		<main>
			<h1>Sign In</h1>
			<form onSubmit={handleSubmit} aria-label="Sign in">
				<label htmlFor="username">Username</label>
				<input
					id="username"
					type="text"
					value={username}
					onChange={(e) => setUsername(e.target.value)}
					autoComplete="username"
				/>
				<label htmlFor="password">Password</label>
				<input
					id="password"
					type="password"
					value={password}
					onChange={(e) => setPassword(e.target.value)}
					autoComplete="current-password"
				/>
				<button type="submit">Sign In</button>
				{error && (
					<div role="alert" aria-live="assertive">
						{error}
					</div>
				)}
			</form>
		</main>
	);
}
