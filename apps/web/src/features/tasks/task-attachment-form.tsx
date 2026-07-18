import { type FormEvent, useState } from "react";

export interface TaskAttachmentFormProps {
	onSubmit: (taskPath: string) => void;
	isSubmitting?: boolean;
	serverError?: string | null;
}

export function TaskAttachmentForm({
	onSubmit,
	isSubmitting,
	serverError,
}: TaskAttachmentFormProps) {
	const [taskPath, setTaskPath] = useState("");

	function handleSubmit(e: FormEvent) {
		e.preventDefault();
		if (taskPath.trim()) {
			onSubmit(taskPath.trim());
		}
	}

	return (
		<form onSubmit={handleSubmit} aria-label="Attach task file">
			{serverError && (
				<div role="alert" aria-live="assertive">
					<p>{serverError}</p>
				</div>
			)}

			<div>
				<label htmlFor="task-path">Task path</label>
				<input
					id="task-path"
					name="taskPath"
					type="text"
					value={taskPath}
					onChange={(e) => setTaskPath(e.target.value)}
					placeholder="tasks/user-auth.json"
					required
				/>
				<p>Enter a project-relative path to a .json task file.</p>
			</div>

			<button type="submit" disabled={isSubmitting}>
				Attach
			</button>
		</form>
	);
}
