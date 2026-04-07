export function createDiagnosticsTracker(): {
	shouldNotify(path: string, message: string): boolean;
} {
	const seen = new Set<string>();

	return {
		shouldNotify(path: string, message: string): boolean {
			const key = `${path}:${message}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		},
	};
}
