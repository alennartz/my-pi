import type { MatchedOverlay } from "./matching.ts";

export function renderOverlayAppendBlock(matches: MatchedOverlay[]): string | undefined {
	if (matches.length === 0) return undefined;

	const sections = matches.map((overlay) => {
		const trimmedBody = overlay.body.trimEnd();
		return `## ${overlay.path}\n\n${trimmedBody}`;
	});

	return `# Model-Specific Prompt Overlays\n\n${sections.join("\n\n")}`;
}
