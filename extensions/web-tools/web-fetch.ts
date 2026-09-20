/**
 * web_fetch tool — bounded retrieval, disk cache, offset/findText retrieval.
 * Contract: docs/plans/web-tools.md → Interfaces → Tool registration.
 */

import { createHash } from "node:crypto";
import { Type } from "typebox";
import type { Static } from "typebox";
import { extractContent } from "./extract.js";
import { cacheKeyFor, openFetchStore, type FetchStore } from "./fetch-store.js";
import { findInText } from "./find-text.js";
import { httpFetch, HttpFetchError } from "./http.js";
import { errorFetchResult, okFetchResult, type FetchResult } from "./types.js";
import { validateUrl } from "./url-policy.js";

export const webFetchParameters = Type.Object({
	url: Type.Optional(Type.String({ description: "URL to fetch" })),
	urls: Type.Optional(
		Type.Array(Type.String(), { minItems: 1, maxItems: 8, description: "1–8 URLs to fetch" }),
	),
	format: Type.Optional(
		Type.Union([Type.Literal("markdown"), Type.Literal("text")], {
			description: "Output format (default markdown; text strips formatting)",
		}),
	),
	maxCharacters: Type.Optional(
		Type.Number({
			minimum: 500,
			maximum: 50_000,
			description: "Max characters returned per URL (default 8000, max 50000)",
		}),
	),
	offset: Type.Optional(
		Type.Number({ minimum: 0, description: "Character offset into the stored content (default 0)" }),
	),
	findText: Type.Optional(
		Type.Union([Type.String(), Type.Array(Type.String())], {
			description:
				'Return only passages matching these terms (case-insensitive), e.g. "installation" or ["retry", "timeout"]',
		}),
	),
	fresh: Type.Optional(
		Type.Boolean({ description: "Bypass cache and refetch (the new result is cached)" }),
	),
});

export type WebFetchParams = Static<typeof webFetchParameters>;

export interface WebFetchDeps {
	store: FetchStore;
	fetchImpl?: typeof fetch;
	signal?: AbortSignal;
	extractionOptsHash?: string;
}

const DEFAULT_MAX_CHARS = 8_000;
const ABSOLUTE_MAX_CHARS = 50_000;
const BATCH_CONCURRENCY = 4;
const BATCH_LIMIT = 8;

const ALLOWED_CONTENT_TYPES = ["text/html", "application/xhtml+xml", "text/plain"];

/** Strip markdown formatting down to readable plain text. */
function stripMarkdownFormatting(md: string): string {
	return md
		.replace(/```[\s\S]*?```/g, (block) => block.replace(/```\w*\n?/g, ""))
		.replace(/`([^`]+)`/g, "$1")
		.replace(/!?\[([^\]]*)\]\(([^)]*)\)/g, "$1 ($2)")
		.replace(/^#{1,6}\s+/gm, "")
		.replace(/^\s*[-*+]\s+/gm, "- ")
		.replace(/[*_]{1,2}([^*_]+)[*_]{1,2}/g, "$1")
		.replace(/\|\s*-{3,}\s*\|/g, "|")
		.replace(/\|/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** Run tasks with bounded concurrency, preserving input order. */
export async function mapWithConcurrency<T, R>(
	items: T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let cursor = 0;
	async function worker(): Promise<void> {
		for (;;) {
			const index = cursor++;
			if (index >= items.length) return;
			results[index] = await fn(items[index], index);
		}
	}
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}

function normalizeFindText(findText: WebFetchParams["findText"]): string[] {
	if (findText === undefined) return [];
	return (Array.isArray(findText) ? findText : [findText]).map((q) => q.trim()).filter(Boolean);
}

/** Core fetch pipeline for one URL. */
async function fetchOne(
	url: string,
	params: WebFetchParams,
	deps: WebFetchDeps,
): Promise<FetchResult> {
	const policy = validateUrl(url);
	if (!policy.ok) {
		return errorFetchResult(url, "blocked-url", policy.message);
	}

	const key = cacheKeyFor(url, deps.extractionOptsHash ?? "");

	if (!params.fresh) {
		const stored = await deps.store.get(key);
		if (stored) {
			return renderResult(stored.result, params, true);
		}
	}

	let http;
	try {
		http = await httpFetch(url, { fetchImpl: deps.fetchImpl, signal: deps.signal });
	} catch (err) {
		if (err instanceof HttpFetchError) {
			return errorFetchResult(url, err.code, err.message, err.attempts);
		}
		throw err;
	}

	const contentType = http.contentType.split(";")[0]?.trim() ?? "";
	if (!ALLOWED_CONTENT_TYPES.some((t) => contentType === t)) {
		return errorFetchResult(
			url,
			"bad-content-type",
			`unsupported content type "${contentType || "unknown"}"`,
			http.attempts,
		);
	}

	let markdown: string;
	let title: string | undefined;
	if (contentType === "text/plain") {
		markdown = http.body;
	} else {
		const extraction = extractContent(http.body, http.effectiveUrl);
		markdown = extraction.markdown;
		title = extraction.title;
	}

	if (markdown.trim().length === 0) {
		return errorFetchResult(
			url,
			"extraction-failed",
			"no readable content extracted (the page may need JavaScript)",
			http.attempts,
		);
	}

	const result = okFetchResult({
		url,
		effectiveUrl: http.effectiveUrl,
		title,
		markdown,
		contentHash: hashOf(markdown),
		attempts: http.attempts,
		fromCache: false,
	});
	await deps.store.put(key, result);
	return renderResult(result, params, false);
}

function hashOf(markdown: string): string {
	return createHash("sha256").update(markdown).digest("hex");
}

/** Apply format/maxCharacters/offset/findText to a full stored result. */
function renderResult(full: FetchResult, params: WebFetchParams, fromCache: boolean): FetchResult {
	const maxChars = Math.min(params.maxCharacters ?? DEFAULT_MAX_CHARS, ABSOLUTE_MAX_CHARS);
	const queries = normalizeFindText(params.findText);

	if (queries.length > 0) {
		const found = findInText(full.markdown, queries);
		const body = params.format === "text" ? stripMarkdownFormatting(found.text) : found.text;
		return {
			...full,
			markdown: body,
			charCount: full.charCount,
			truncated: false,
			nextOffset: undefined,
			fromCache,
		};
	}

	const offset = params.offset ?? 0;
	if (offset > full.markdown.length) {
		return {
			...full,
			markdown: `(offset ${offset} is beyond the end of the stored content: ${full.markdown.length} chars)`,
			truncated: false,
			nextOffset: undefined,
			fromCache,
		};
	}

	const slice = full.markdown.slice(offset, offset + maxChars);
	const truncated = offset + slice.length < full.markdown.length;
	let body = slice;
	if (params.format === "text") {
		body = stripMarkdownFormatting(slice);
	}

	return {
		...full,
		markdown: body,
		truncated,
		nextOffset: truncated ? offset + maxChars : undefined,
		fromCache,
	};
}

export interface WebFetchOutcome {
	text: string;
	details: FetchResult[];
}

/** Batch entry point: validate params, fetch with bounded concurrency. */
export async function runWebFetch(
	params: WebFetchParams,
	deps: WebFetchDeps,
): Promise<WebFetchOutcome> {
	const urls = (params.urls ?? (params.url ? [params.url] : [])).map((u) => u.trim()).filter(Boolean);
	if (urls.length === 0) {
		throw new Error("provide url or urls");
	}
	if (urls.length > BATCH_LIMIT) {
		throw new Error(`at most ${BATCH_LIMIT} URLs per call`);
	}
	const queries = normalizeFindText(params.findText);
	if (queries.length > 0 && params.offset !== undefined && params.offset !== 0) {
		throw new Error("findText and offset are mutually exclusive");
	}

	const results = await mapWithConcurrency(urls, BATCH_CONCURRENCY, (url) =>
		fetchOne(url, params, deps),
	);

	return { text: results.map(renderOne).join("\n\n"), details: results };
}

function renderOne(result: FetchResult): string {
	if (result.status === "error") {
		return `=== ${result.url}\nERROR (${result.errorCode}): ${result.errorMessage}`;
	}
	const header = [
		`=== ${result.url}`,
		result.title ? `Title: ${result.title}` : undefined,
		`Chars: ${result.charCount}${result.truncated ? ` (truncated — continue with offset: ${result.nextOffset})` : ""}`,
		`Hash: ${result.contentHash.slice(0, 12)} · ${result.fromCache ? "cached" : `fetched (${result.attempts} attempt${result.attempts === 1 ? "" : "s"})`}`,
	]
		.filter((l) => l !== undefined)
		.join("\n");
	return `${header}\n\n${result.markdown}`;
}
