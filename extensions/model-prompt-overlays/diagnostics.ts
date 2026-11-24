export function createDiagnosticsTracker() {
	const seen = new Set<string>();

	return {
		// Every diagnostic message already embeds its file path, so the message
		// alone is a sufficient dedupe key.
		shouldNotify(message: string): boolean {
			if (seen.has(message)) {return false;}
			seen.add(message);
			return true;
		},
	};
}
