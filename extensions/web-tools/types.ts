/**
 * Canonical types shared by web_search and web_fetch.
 * Contract: docs/plans/web-tools.md → Interfaces.
 */

export interface SearchResult {
	/** Stable within a response: "s1", "s2", ... */
	sourceId: string;
	/** Result URL as returned by the provider. */
	url: string;
	title: string;
	snippet?: string;
	/** Provider age string, verbatim (e.g. "2 days ago"). */
	age?: string;
	provider: "brave";
	/** 1-based position before dedupe. */
	rank: number;
}

export interface SearchResponse {
	query: string;
	results: SearchResult[];
	/** Random id; key for follow-up retrieval of this response. */
	responseId: string;
}

export type FetchErrorCode =
	| "blocked-url" // failed URL/redirect policy
	| "bad-content-type" // not html/xhtml/text/plain
	| "too-large" // exceeded maxBytes
	| "http-error" // non-retryable HTTP status (4xx other than 429)
	| "timeout"
	| "network" // connection failure after retries
	| "retry-exhausted" // transient failures persisted past maxRetries
	| "extraction-failed"; // nothing extractable in a 2xx response

export interface FetchResult {
	/** Requested URL. */
	url: string;
	/** Final URL after redirects. */
	effectiveUrl: string;
	title?: string;
	/** Extracted content (markdown format; plain text for text/plain sources). */
	markdown: string;
	/** sha256 hex of the full untruncated markdown. */
	contentHash: string;
	/** Character count of the full untruncated markdown. */
	charCount: number;
	/** True if the returned markdown was cut by maxCharacters. */
	truncated: boolean;
	/** Present when truncated: offset to request next. */
	nextOffset?: number;
	status: "ok" | "error";
	errorCode?: FetchErrorCode;
	errorMessage?: string;
	/** HTTP attempts made (>= 1). */
	attempts: number;
	fromCache: boolean;
}

export function okFetchResult(init: {
	url: string;
	effectiveUrl: string;
	title?: string;
	markdown: string;
	contentHash: string;
	attempts: number;
	fromCache: boolean;
}): FetchResult {
	return {
		status: "ok",
		truncated: false,
		charCount: init.markdown.length,
		...init,
	};
}

export function errorFetchResult(
	url: string,
	code: FetchErrorCode,
	message: string,
	attempts = 0,
): FetchResult {
	return {
		url,
		effectiveUrl: url,
		markdown: "",
		contentHash: "",
		charCount: 0,
		truncated: false,
		status: "error",
		errorCode: code,
		errorMessage: message,
		attempts,
		fromCache: false,
	};
}
