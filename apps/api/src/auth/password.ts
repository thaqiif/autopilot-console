/**
 * Password strength validation and Argon2id hashing (Bun.password).
 */

const MIN_PASSWORD_LENGTH = 12;

export function assertStrongPassword(password: string): string {
	if (password.length < MIN_PASSWORD_LENGTH) {
		throw new Error(`Weak password: must be at least ${MIN_PASSWORD_LENGTH} characters`);
	}
	if (!/[a-z]/.test(password)) {
		throw new Error("Weak password: must include a lowercase letter");
	}
	if (!/[A-Z]/.test(password)) {
		throw new Error("Weak password: must include an uppercase letter");
	}
	if (!/[0-9]/.test(password)) {
		throw new Error("Weak password: must include a digit");
	}
	if (!/[^A-Za-z0-9]/.test(password)) {
		throw new Error("Weak password: must include a special character");
	}
	return password;
}

export async function hashPassword(password: string): Promise<string> {
	assertStrongPassword(password);
	return Bun.password.hash(password, { algorithm: "argon2id" });
}

export async function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
	return Bun.password.verify(password, passwordHash);
}
