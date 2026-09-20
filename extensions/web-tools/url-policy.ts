/**
 * URL and redirect policy — pure functions, no network.
 *
 * Every URL we fetch and every redirect hop we follow must pass through here
 * before a request is made. See docs/plans/web-tools.md for the contract.
 */

export type UrlPolicyResult =
	| { ok: true }
	| { ok: false; code: "blocked-url"; message: string };

const ALLOWED_PORTS = new Set([80, 443, 8080, 8443]);

const BLOCKED_HOST_SUFFIXES = [".local", ".internal"];

const BLOCKED_METADATA_HOSTS = [
	"metadata.google.internal",
	"metadata.internal",
	"169.254.169.254",
];

/** Parse an IPv4 address into its four octets, or null if not IPv4. */
function parseIpv4(host: string): number[] | null {
	if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return null;
	const parts = host.split(".").map(Number);
	if (parts.some((n) => n < 0 || n > 255)) return null;
	return parts;
}

function isPrivateIpv4(octets: number[]): boolean {
	const [a, b] = octets;
	if (a === 0) return true; // 0.0.0.0/8 — "this" network
	if (a === 10) return true; // 10.0.0.0/8
	if (a === 127) return true; // 127.0.0.0/8 — loopback
	if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
	if (a === 192 && b === 168) return true; // 192.168.0.0/16
	if (a === 169 && b === 254) return true; // 169.254.0.0/16 — link-local
	if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 — CGNAT
	if (a === 192 && b === 0) return true; // 192.0.0.0/24 + 192.0.2.0/24
	if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 — benchmarks
	return false;
}

function isPrivateIpv6(host: string): boolean {
	let h = host.toLowerCase().replace(/^\[|\]$/g, "");

	// IPv4-mapped, dotted form: ::ffff:a.b.c.d — before URL parsing canonicalizes it.
	const mappedDotted = h.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
	if (mappedDotted) {
		const octets = parseIpv4(mappedDotted[1]);
		if (octets !== null && isPrivateIpv4(octets)) return true;
	}

	// IPv4-mapped, canonical hex form: ::ffff:XXXX:XXXX (two 16-bit groups).
	// The WHATWG URL parser rewrites ::ffff:a.b.c.d into this shape.
	const mappedHex = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
	if (mappedHex) {
		const hi = Number.parseInt(mappedHex[1], 16);
		const lo = Number.parseInt(mappedHex[2], 16);
		if (isPrivateIpv4([(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff])) {
			return true;
		}
	}

	if (h === "::" || h === "::1") return true; // unspecified + loopback
	if (h.startsWith("fe8") || h.startsWith("fe9") || h.startsWith("fea") || h.startsWith("feb"))
		return true; // fe80::/10 — link-local
	if (h.startsWith("fc") || h.startsWith("fd")) return true; // fc00::/7 — unique local
	if (h.startsWith("ff")) return true; // ff00::/8 — multicast
	if (h.startsWith("100::")) return true; // 100::/64 — discard-only
	if (h.startsWith("64:ff9b:")) return true; // NAT64 well-known prefix (local translation)
	return false;
}

/**
 * Check whether a hostname (as it appears in a URL, no DNS resolution) refers
 * to a private, loopback, link-local, or otherwise non-public target.
 */
export function isPrivateHost(host: string): boolean {
	const lower = host.toLowerCase().replace(/^\[|\]$/g, "");

	if (lower === "localhost" || lower === "localhost.localdomain") return true;

	for (const blocked of BLOCKED_METADATA_HOSTS) {
		if (lower === blocked || lower.endsWith(`.${blocked}`)) return true;
	}

	for (const suffix of BLOCKED_HOST_SUFFIXES) {
		if (lower.endsWith(suffix)) return true;
	}

	const octets = parseIpv4(lower);
	if (octets !== null) return isPrivateIpv4(octets);

	if (lower.includes(":")) return isPrivateIpv6(lower);

	return false;
}

/** Validate a URL we are about to fetch. Pure — no DNS, no network. */
export function validateUrl(url: string): UrlPolicyResult {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return { ok: false, code: "blocked-url", message: `invalid URL: ${url}` };
	}

	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return {
			ok: false,
			code: "blocked-url",
			message: `only http/https allowed, got ${parsed.protocol}`,
		};
	}

	if (parsed.username || parsed.password) {
		return {
			ok: false,
			code: "blocked-url",
			message: "credentials in URL not allowed",
		};
	}

	if (isPrivateHost(parsed.hostname)) {
		return {
			ok: false,
			code: "blocked-url",
			message: `private or internal host: ${parsed.hostname}`,
		};
	}

	const port = parsed.port ? Number(parsed.port) : null;
	if (port !== null && !ALLOWED_PORTS.has(port)) {
		return {
			ok: false,
			code: "blocked-url",
			message: `port ${port} not allowed (allowed: 80, 443, 8080, 8443)`,
		};
	}

	return { ok: true };
}

/**
 * Validate a redirect hop from `from` to `to`. Applies all of validateUrl to
 * the destination, plus redirect-specific rules: no TLS downgrade, and no
 * cross-origin hop that smuggles credentials (e.g. a query-param token is the
 * page's business, but userinfo on the redirect target never is).
 */
export function validateRedirect(from: string, to: string): UrlPolicyResult {
	const destination = validateUrl(to);
	if (!destination.ok) return destination;

	let fromParsed: URL;
	let toParsed: URL;
	try {
		fromParsed = new URL(from);
		toParsed = new URL(to);
	} catch {
		return { ok: false, code: "blocked-url", message: `invalid redirect URL: ${to}` };
	}

	if (fromParsed.protocol === "https:" && toParsed.protocol === "http:") {
		return {
			ok: false,
			code: "blocked-url",
			message: `TLS downgrade redirect: ${from} → ${to}`,
		};
	}

	return { ok: true };
}
