/**
 * Search result normalization — pure functions.
 * Contract: docs/plans/web-tools.md → Interfaces → Normalization.
 */

import type { SearchResult, SearchResponse } from "../types.js";

/**
 * Conservative canonical key for URL identity: lowercase scheme+host,
 * strip fragment, strip trailing slash (except root). Query parameters are
 * kept — they routinely distinguish content.
 */
export function canonicalUrlKey(url: string): string {
	try {
		const u = new URL(url);
		u.hash = "";
		u.hostname = u.hostname.toLowerCase();
		if (u.pathname !== "/" && u.pathname.endsWith("/")) {
			u.pathname = u.pathname.replace(/\/+$/, "");
		}
		return u.toString();
	} catch {
		return url.toLowerCase();
	}
}

/** Dedupe by canonical URL, keeping the first (best-rank) entry. */
export function dedupeResults(results: SearchResult[]): SearchResult[] {
	const seen = new Set<string>();
	const out: SearchResult[] = [];
	for (const r of results) {
		const key = canonicalUrlKey(r.url);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(r);
	}
	return out;
}

/** Render compact numbered result cards for the model. */
export function renderSearchCards(response: SearchResponse): string {
	if (response.results.length === 0) {
		return `No results found for: ${response.query}`;
	}
	return response.results
		.map((r, i) => {
			const lines = [`${i + 1}. ${r.title}`, `   ${r.url}`];
			if (r.age) lines.push(`   Age: ${r.age}`);
			if (r.snippet) lines.push(`   ${r.snippet}`);
			return lines.join("\n");
		})
		.join("\n\n");
}

/** Apply include/exclude domain filters. Returns kept results and drop count. */
export function applyDomainFilters(
	results: SearchResult[],
	includeDomains?: string[],
	excludeDomains?: string[],
): { kept: SearchResult[]; dropped: number } {
	const include = includeDomains?.map((d) => normalizeDomain(d));
	const exclude = excludeDomains?.map((d) => normalizeDomain(d));

	const kept = results.filter((r) => {
		let host: string;
		try {
			host = new URL(r.url).hostname.toLowerCase();
		} catch {
			return false;
		}
		if (exclude?.some((d) => host === d || host.endsWith(`.${d}`))) return false;
		if (include && include.length > 0) {
			return include.some((d) => host === d || host.endsWith(`.${d}`));
		}
		return true;
	});

	return { kept, dropped: results.length - kept.length };
}

function normalizeDomain(domain: string): string {
	return domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
}
