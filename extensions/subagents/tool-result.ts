export function formatSpawnToolResult(waitResult?: string): string {
	if (waitResult && waitResult.trim()) return waitResult;
	return "All specified agents have completed. No pending notifications.";
}
