/**
 * Bounded HTTP fetch with redirect policy, retries, and byte limits.
 * Contract: docs/plans/web-tools.md → Interfaces → Bounded HTTP fetch.
 */

import { validateRedirect, validateUrl } from "./url-policy.js";
import type { FetchErrorCode } from "./types.js";

export class HttpFetchError extends Error {
	constructor(
		public readonly code: Extract<
			FetchErrorCode,
			"blocked-url" | "too-large" | "http-error" | "timeout" | "network" | "retry-exhausted"
		>,
		message: string,
		public readonly status?: number,
		public readonly attempts = 1,
	) {
		super(message);
		this.name = "HttpFetchError";
	}
}

export interface HttpFetchOptions {
	/** Per-request timeout. Default 20s. */
	timeoutMs?: number;
	/** Maximum response body size. Default 5 MB. Enforced on content-length and streamed body. */
	maxBytes?: number;
	/** Maximum redirect hops. Default 5. */
	maxRedirects?: number;
	/** Retries after the first attempt. Default 2 (3 attempts total). */
	maxRetries?: number;
	signal?: AbortSignal;
	/** Injection points for tests. */
	fetchImpl?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
}

export interface HttpResponse {
	effectiveUrl: string;
	status: number;
	contentType: string;
	body: string;
	attempts: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BYTES = 5_000_000;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_MAX_RETRIES = 2;

const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 8_000;
const RETRY_AFTER_CAP_MS = 30_000;

const REQUEST_HEADERS: Record<string, string> = {
	"User-Agent":
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
	Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.8",
	"Accept-Language": "en-US,en;q=0.9",
};

type StoredCookie = { value: string; path: string };
type CookieJar = Map<string, Map<string, StoredCookie>>;

function originKey(url: string): string {
	const parsed = new URL(url);
	return parsed.origin;
}

function defaultCookiePath(url: string): string {
	const pathname = new URL(url).pathname;
	if (!pathname || pathname === "/") return "/";
	const slash = pathname.lastIndexOf("/");
	return slash <= 0 ? "/" : pathname.slice(0, slash);
}

/** Split combined Set-Cookie values without splitting commas in Expires dates. */
function splitSetCookie(value: string): string[] {
	return value.split(/,(?=\s*[^;,=\s]+=)/);
}

function setCookiesFromResponse(url: string, headers: Headers, jar: CookieJar): void {
	const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
	const values = getSetCookie
		? getSetCookie.call(headers)
		: headers.get("set-cookie")
			? splitSetCookie(headers.get("set-cookie") as string)
			: [];
	if (values.length === 0) return;

	const key = originKey(url);
	const cookies = jar.get(key) ?? new Map<string, StoredCookie>();
	for (const header of values) {
		const match = /^\s*([^=;\s]+)=([^;]*)/.exec(header);
		if (!match) continue;
		const name = match[1];
		const value = match[2];
		const maxAge = /(?:^|;)\s*max-age\s*=\s*(-?\d+)/i.exec(header);
		if (value === "" || (maxAge && Number(maxAge[1]) <= 0)) {
			cookies.delete(name);
			continue;
		}
		const path =
			/(?:^|;)\s*path\s*=\s*([^;]+)/i.exec(header)?.[1]?.trim() || defaultCookiePath(url);
		cookies.set(name, { value, path: path.startsWith("/") ? path : "/" });
	}
	if (cookies.size > 0) jar.set(key, cookies);
	else jar.delete(key);
}

function cookieHeaderFor(url: string, jar: CookieJar): string | undefined {
	const cookies = jar.get(originKey(url));
	if (!cookies) return undefined;
	const pathname = new URL(url).pathname || "/";
	const matching = [...cookies.entries()]
		.filter(
			([, cookie]) =>
				pathname === cookie.path || pathname.startsWith(`${cookie.path.replace(/\/$/, "")}/`),
		)
		.map(([name, cookie]) => `${name}=${cookie.value}`);
	return matching.length > 0 ? matching.join("; ") : undefined;
}

/** Parse a Retry-After header (delay-seconds or HTTP-date) into a delay in ms. */
export function parseRetryAfterMs(
	value: string | null,
	now: () => number,
): number | null {
	if (!value) return null;
	const trimmed = value.trim();
	const seconds = Number(trimmed);
	if (Number.isFinite(seconds) && trimmed !== "") {
		return Math.max(0, seconds * 1000);
	}
	const when = Date.parse(trimmed);
	if (!Number.isNaN(when)) {
		return Math.max(0, when - now());
	}
	return null;
}

async function defaultSleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

async function readBodyBounded(
	response: Response,
	maxBytes: number,
): Promise<{ body: string; tooLarge: boolean }> {
	// Bounded read via streaming when a body is present; plain text() fallback
	// for mocked responses without one.
	if (!response.body) {
		const text = await response.text();
		return { body: text, tooLarge: Buffer.byteLength(text, "utf8") > maxBytes };
	}

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let received = 0;
	let tooLarge = false;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (value) {
			received += value.byteLength;
			if (received > maxBytes) {
				tooLarge = true;
				await reader.cancel().catch(() => {});
				break;
			}
			chunks.push(value);
		}
	}
	const total = Buffer.concat(chunks.map((c) => Buffer.from(c)));
	return { body: tooLarge ? "" : total.toString("utf8"), tooLarge };
}

export async function httpFetch(url: string, opts: HttpFetchOptions = {}): Promise<HttpResponse> {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
	const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
	const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
	const doFetch = opts.fetchImpl ?? fetch;
	const sleep = opts.sleep ?? defaultSleep;
	const now = opts.now ?? Date.now;
	const maxAttempts = maxRetries + 1;

	let currentUrl = url;
	let attempts = 0;
	const cookieJar: CookieJar = new Map();
	let lastRetryable: { code: "timeout" | "network" | "retry-exhausted"; message: string } | null =
		null;

	for (let hop = 0; hop <= maxRedirects; hop++) {
		// Destination was validated when the redirect was followed (location branch);
		// the initial URL is validated here on hop 0 and re-checked on later hops
		// in case currentUrl was reassigned.
		const check = validateUrl(currentUrl);
		if (!check.ok) {
			throw new HttpFetchError("blocked-url", check.message);
		}

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			attempts++;

			// Compose caller signal with a per-attempt timeout.
			const timedOut = { value: false };
			const timeoutController = new AbortController();
			const timer = setTimeout(() => {
				timedOut.value = true;
				timeoutController.abort();
			}, timeoutMs);
			const signal = opts.signal
				? AbortSignal.any([opts.signal, timeoutController.signal])
				: timeoutController.signal;

			let response: Response;
			try {
				const headers: Record<string, string> = { ...REQUEST_HEADERS };
				const cookie = cookieHeaderFor(currentUrl, cookieJar);
				if (cookie) headers.Cookie = cookie;
				response = await doFetch(currentUrl, {
					redirect: "manual",
					headers,
					signal,
				});
			} catch (err) {
				clearTimeout(timer);
				if (opts.signal?.aborted) throw err; // caller cancellation propagates
				const code = timedOut.value ? "timeout" : "network";
				const message = `${code} on ${currentUrl}: ${err instanceof Error ? err.message : String(err)}`;
				lastRetryable = { code, message };
				if (attempt < maxAttempts) {
					await sleep(backoffDelayMs(attempt));
					continue;
				}
				throw new HttpFetchError(code, message, undefined, attempts);
			}
			clearTimeout(timer);
			setCookiesFromResponse(currentUrl, response.headers, cookieJar);

			if (response.status >= 200 && response.status < 300) {
				const declaredLength = Number(response.headers?.get?.("content-length") ?? "0");
				if (declaredLength > maxBytes) {
					throw new HttpFetchError(
						"too-large",
						`response too large: content-length ${declaredLength} > ${maxBytes}`,
						response.status,
						attempts,
					);
				}
				const { body, tooLarge } = await readBodyBounded(response, maxBytes);
				if (tooLarge) {
					throw new HttpFetchError(
						"too-large",
						`response body exceeded ${maxBytes} bytes`,
						response.status,
						attempts,
					);
				}
				return {
					effectiveUrl: currentUrl,
					status: response.status,
					contentType: (response.headers?.get?.("content-type") ?? "").toLowerCase(),
					body,
					attempts,
				};
			}

			if (response.status >= 300 && response.status < 400) {
				const location = response.headers?.get?.("location");
				if (!location) {
					throw new HttpFetchError(
						"http-error",
						`redirect without location from ${currentUrl}`,
						response.status,
						attempts,
					);
				}
				const next = new URL(location, currentUrl).toString();
				const redirectCheck = validateRedirect(currentUrl, next);
				if (!redirectCheck.ok) {
					throw new HttpFetchError("blocked-url", redirectCheck.message);
				}
				currentUrl = next;
				break; // leave the attempt loop, continue the hop loop
			}

			const retryable =
				response.status === 429 ||
				response.status === 503 ||
				response.status >= 500;

			if (!retryable) {
				throw new HttpFetchError(
					"http-error",
					`HTTP ${response.status} from ${currentUrl}`,
					response.status,
					attempts,
				);
			}

			const message = `HTTP ${response.status} from ${currentUrl}`;
			lastRetryable = { code: "retry-exhausted", message };
			if (attempt < maxAttempts) {
				const retryAfter = parseRetryAfterMs(
					response.headers?.get?.("retry-after") ?? null,
					now,
				);
				const delay =
					retryAfter !== null
						? Math.min(retryAfter, RETRY_AFTER_CAP_MS)
						: backoffDelayMs(attempt);
				await sleep(delay);
				continue;
			}
			throw new HttpFetchError("retry-exhausted", message, response.status, attempts);
		}
	}

	// Exited the hop loop without a response: too many redirects.
	throw new HttpFetchError(
		"http-error",
		`too many redirects (max ${maxRedirects})`,
		undefined,
		attempts,
	);
}

/** Capped exponential backoff with jitter, 1-indexed attempt. */
function backoffDelayMs(attempt: number): number {
	const raw = BACKOFF_BASE_MS * 2 ** (attempt - 1);
	const capped = Math.min(raw, BACKOFF_CAP_MS);
	const jitter = capped * 0.2 * Math.random();
	return capped + jitter;
}
