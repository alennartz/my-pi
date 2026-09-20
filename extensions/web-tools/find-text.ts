/**
 * Passage search over cached page content — literal, case-insensitive.
 * Contract: docs/plans/web-tools.md → Interfaces → Passage search.
 */

export interface FindOptions {
	/** Context shown each side of a match. Default 400 chars. */
	contextChars?: number;
	/** Output cap. Default 20_000 chars. */
	maxOutputChars?: number;
}

export interface FindResult {
	/** Rendered passages with per-query match counts. */
	text: string;
	matchCount: number;
	perQuery: Array<{ query: string; matchCount: number }>;
}

interface Range {
	start: number;
	end: number;
}

const DEFAULT_CONTEXT_CHARS = 400;
const DEFAULT_MAX_OUTPUT_CHARS = 20_000;

function findLiteral(haystackLower: string, needleLower: string): Range[] {
	const matches: Range[] = [];
	if (needleLower.length === 0) return matches;
	for (
		let i = haystackLower.indexOf(needleLower);
		i >= 0;
		i = haystackLower.indexOf(needleLower, i + needleLower.length)
	) {
		matches.push({ start: i, end: i + needleLower.length });
	}
	return matches;
}

function mergeRanges(ranges: Range[]): Range[] {
	if (ranges.length === 0) return [];
	const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
	const merged: Range[] = [{ ...sorted[0] }];
	for (const range of sorted.slice(1)) {
		const last = merged[merged.length - 1];
		if (range.start <= last.end) {
			last.end = Math.max(last.end, range.end);
		} else {
			merged.push({ ...range });
		}
	}
	return merged;
}

/** Find matching passages in `markdown`. Pure — no I/O. */
export function findInText(
	markdown: string,
	queries: string[],
	opts: FindOptions = {},
): FindResult {
	const contextChars = opts.contextChars ?? DEFAULT_CONTEXT_CHARS;
	const maxOutputChars = opts.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;

	const normalized = [...new Set(queries.map((q) => q.trim()).filter(Boolean))];
	if (normalized.length === 0 || markdown.length === 0) {
		return { text: "No search terms provided.", matchCount: 0, perQuery: [] };
	}

	const lower = markdown.toLowerCase();
	const perQuery = normalized.map((query) => ({
		query,
		matches: findLiteral(lower, query.toLowerCase()),
	}));
	const totalMatches = perQuery.reduce((n, { matches }) => n + matches.length, 0);

	if (totalMatches === 0) {
		return {
			text: `No matches for: ${normalized.map((q) => `"${q}"`).join(", ")}`,
			matchCount: 0,
			perQuery: perQuery.map(({ query, matches }) => ({ query, matchCount: matches.length })),
		};
	}

	// Expand each match by the context window, then merge overlaps.
	const matchRanges: Range[] = [];
	for (const { matches } of perQuery) {
		for (const m of matches) {
			matchRanges.push({
				start: Math.max(0, m.start - contextChars),
				end: Math.min(markdown.length, m.end + contextChars),
			});
		}
	}
	const passages = mergeRanges(matchRanges);

	const header = `Matches (${totalMatches} total)`;
	const sections: string[] = [header];
	let shownMatches = 0;
	let shownPassages = 0;

	for (const passage of passages) {
		// Which queries have matches inside this passage?
		const counts = perQuery
			.map(({ query, matches }) => ({
				query,
				count: matches.filter((m) => m.start >= passage.start && m.end <= passage.end).length,
			}))
			.filter((c) => c.count > 0);
		if (counts.length === 0) continue;

		const prefix = passage.start > 0 ? "…" : "";
		const suffix = passage.end < markdown.length ? "…" : "";
		const body = `${prefix}${markdown.slice(passage.start, passage.end).replace(/\s+/g, " ").trim()}${suffix}`;
		const label = counts.map((c) => `"${c.query}" ×${c.count}`).join(", ");
		const rendered = `${shownPassages + 1}. ${label}\n${body}`;

		if (sections.join("\n\n").length + rendered.length > maxOutputChars && shownPassages > 0) {
			break; // cap reached — stop adding whole passages
		}
		sections.push(rendered);
		shownPassages++;
		shownMatches += counts.reduce((n, c) => n + c.count, 0);
	}

	if (shownMatches < totalMatches) {
		sections.push(`Showing ${shownMatches} of ${totalMatches} matches.`);
	}

	return {
		text: sections.join("\n\n"),
		matchCount: totalMatches,
		perQuery: perQuery.map(({ query, matches }) => ({ query, matchCount: matches.length })),
	};
}
