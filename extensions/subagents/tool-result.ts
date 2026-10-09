export function formatSpawnToolResult(waitResult?: string): string {
	if (waitResult && waitResult.trim()) return waitResult;
	return "All specified agents have completed. No pending notifications.";
}

/**
 * The tool-result note telling the orchestrator that the persona it requested
 * lost wholesale to the child's workspace declaration (one line per overridden
 * child).
 */
export function formatOverrideNote(requested: string, workspaceName: string, cwd: string): string {
	return `persona '${requested}' overridden by workspace persona '${workspaceName}' (${cwd})`;
}
