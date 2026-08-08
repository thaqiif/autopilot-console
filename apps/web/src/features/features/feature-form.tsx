import { type FormEvent, useState } from "react";

export interface FeatureFormData {
	title: string;
	slug: string;
	summary: string;
}

export interface FeatureFormProps {
	onSubmit: (data: FeatureFormData) => void;
	onCancel: () => void;
	isSubmitting?: boolean;
	serverError?: string | null;
	projectId?: string;
	releaseId?: string;
	initialData?: Partial<FeatureFormData>;
}

export function FeatureForm({
	onSubmit,
	onCancel,
	isSubmitting,
	serverError,
	initialData,
}: FeatureFormProps) {
	const [title, setTitle] = useState(initialData?.title ?? "");
	const [slug, setSlug] = useState(initialData?.slug ?? "");
	const [summary, setSummary] = useState(initialData?.summary ?? "");

	function handleSubmit(e: FormEvent) {
		e.preventDefault();
		onSubmit({ title, slug, summary });
	}

	return (
		<form onSubmit={handleSubmit} aria-label="Feature form">
			{serverError && (
				<div role="alert" aria-live="assertive">
					<p>{serverError}</p>
				</div>
			)}

			<div>
				<label htmlFor="feature-title">Title</label>
				<input
					id="feature-title"
					name="title"
					value={title}
					onChange={(e) => setTitle(e.target.value)}
					required
				/>
			</div>

			<div>
				<label htmlFor="feature-slug">Slug</label>
				<input
					id="feature-slug"
					name="slug"
					value={slug}
					onChange={(e) => setSlug(e.target.value)}
					required
				/>
			</div>

			<div>
				<label htmlFor="feature-summary">Summary</label>
				<textarea
					id="feature-summary"
					name="summary"
					value={summary}
					onChange={(e) => setSummary(e.target.value)}
				/>
			</div>

			<p>State: PLANNED</p>

			{slug && <p>Branch: feature/{slug}</p>}

			<div>
				<button type="button" onClick={onCancel}>
					Cancel
				</button>
				<button type="submit" disabled={isSubmitting}>
					{initialData?.title ? "Save" : "Create feature"}
				</button>
			</div>
		</form>
	);
}
