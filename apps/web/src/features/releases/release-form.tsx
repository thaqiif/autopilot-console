import { type FormEvent, useState } from "react";

export interface ReleaseFormData {
	name: string;
	version: string;
	description: string;
}

export interface ReleaseFormProps {
	onSubmit: (data: ReleaseFormData) => void;
	onCancel: () => void;
	initialData?: Partial<ReleaseFormData>;
	isSubmitting?: boolean;
	serverError?: string | null;
	projectId?: string;
}

export function ReleaseForm({
	onSubmit,
	onCancel,
	initialData,
	isSubmitting,
	serverError,
}: ReleaseFormProps) {
	const [name, setName] = useState(initialData?.name ?? "");
	const [version, setVersion] = useState(initialData?.version ?? "");
	const [description, setDescription] = useState(initialData?.description ?? "");

	function handleSubmit(e: FormEvent) {
		e.preventDefault();
		onSubmit({ name, version, description });
	}

	return (
		<form onSubmit={handleSubmit} aria-label="Release form">
			{serverError && (
				<div role="alert" aria-live="assertive">
					<p>{serverError}</p>
				</div>
			)}

			<div>
				<label htmlFor="release-name">Name</label>
				<input
					id="release-name"
					name="name"
					value={name}
					onChange={(e) => setName(e.target.value)}
					required
				/>
			</div>

			<div>
				<label htmlFor="release-version">Version</label>
				<input
					id="release-version"
					name="version"
					value={version}
					onChange={(e) => setVersion(e.target.value)}
					required
				/>
			</div>

			<div>
				<label htmlFor="release-description">Description</label>
				<textarea
					id="release-description"
					name="description"
					value={description}
					onChange={(e) => setDescription(e.target.value)}
				/>
			</div>

			<div>
				<button type="button" onClick={onCancel}>
					Cancel
				</button>
				<button type="submit" disabled={isSubmitting}>
					{initialData?.name ? "Save" : "Create release"}
				</button>
			</div>
		</form>
	);
}
