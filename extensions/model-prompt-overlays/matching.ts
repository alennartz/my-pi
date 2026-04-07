import type { OverlayFile } from "./parsing.ts";

export type MatchResult = {
	matched: true;
	matchingGlob: string;
	literalChars: number;
	wildcardCount: number;
};

export type MatchedOverlay = OverlayFile & MatchResult;

export function globToRegex(glob: string): RegExp {
	// Escape regex-special chars, then replace escaped \* with .*
	const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
	return new RegExp(`^${escaped}$`);
}

function computeSpecificity(glob: string): { literalChars: number; wildcardCount: number } {
	const wildcardCount = (glob.match(/\*/g) || []).length;
	const literalChars = glob.replace(/\*/g, "").length;
	return { literalChars, wildcardCount };
}

export function matchOverlay(
	modelId: string,
	overlay: OverlayFile,
): MatchResult | { matched: false } {
	let bestMatch: MatchResult | null = null;

	for (const glob of overlay.models) {
		const regex = globToRegex(glob);
		if (!regex.test(modelId)) continue;

		const { literalChars, wildcardCount } = computeSpecificity(glob);

		if (
			!bestMatch ||
			literalChars > bestMatch.literalChars ||
			(literalChars === bestMatch.literalChars && wildcardCount < bestMatch.wildcardCount)
		) {
			bestMatch = { matched: true, matchingGlob: glob, literalChars, wildcardCount };
		}
	}

	return bestMatch ?? { matched: false };
}

/**
 * Compare two MatchResults for broad → narrow ordering.
 * Ascending literalChars (fewer = broader), then descending wildcardCount (more = broader).
 */
export function compareSpecificity(a: MatchResult, b: MatchResult): number {
	if (a.literalChars !== b.literalChars) return a.literalChars - b.literalChars;
	if (a.wildcardCount !== b.wildcardCount) return b.wildcardCount - a.wildcardCount;
	return 0;
}

export type IndexedMatchedOverlay = MatchedOverlay & { rootIndex: number };

/**
 * Sort matched overlays: root order first, then broad → narrow specificity,
 * then path as stable tie-breaker.
 */
export function sortMatchedOverlays(matches: IndexedMatchedOverlay[]): MatchedOverlay[] {
	return [...matches].sort((a, b) => {
		// Root order first
		if (a.rootIndex !== b.rootIndex) return a.rootIndex - b.rootIndex;
		// Specificity within same root (broad → narrow)
		const spec = compareSpecificity(a, b);
		if (spec !== 0) return spec;
		// Stable tie-breaker: path
		return a.path.localeCompare(b.path);
	});
}
