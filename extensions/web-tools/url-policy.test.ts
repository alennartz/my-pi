import { describe, expect, it } from "vitest";
import { isPrivateHost, validateRedirect, validateUrl } from "./url-policy.js";

describe("validateUrl", () => {
	it("allows ordinary public http and https URLs", () => {
		expect(validateUrl("https://example.com/page")).toEqual({ ok: true });
		expect(validateUrl("http://example.com")).toEqual({ ok: true });
		expect(validateUrl("https://docs.astral.sh/uv/guides/scripts/?q=1#frag")).toEqual({
			ok: true,
		});
	});

	it("allows the standard and common proxy ports", () => {
		expect(validateUrl("https://example.com:443/")).toEqual({ ok: true });
		expect(validateUrl("http://example.com:80/")).toEqual({ ok: true });
		expect(validateUrl("http://example.com:8080/")).toEqual({ ok: true });
		expect(validateUrl("https://example.com:8443/")).toEqual({ ok: true });
	});

	it("rejects non-http schemes", () => {
		expect(validateUrl("file:///etc/passwd").ok).toBe(false);
		expect(validateUrl("ftp://example.com/file").ok).toBe(false);
		expect(validateUrl("gopher://example.com").ok).toBe(false);
	});

	it("rejects credentials in the URL", () => {
		const r = validateUrl("https://user:pass@example.com/");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("blocked-url");
	});

	it("rejects localhost by name and by IP", () => {
		expect(validateUrl("http://localhost/x").ok).toBe(false);
		expect(validateUrl("http://localhost.localdomain/x").ok).toBe(false);
		expect(validateUrl("http://127.0.0.1/x").ok).toBe(false);
		expect(validateUrl("http://127.1.2.3/x").ok).toBe(false);
		expect(validateUrl("http://[::1]/x").ok).toBe(false);
		expect(validateUrl("http://0.0.0.0/x").ok).toBe(false);
	});

	it("rejects RFC1918 private ranges", () => {
		expect(validateUrl("http://10.0.0.5/x").ok).toBe(false);
		expect(validateUrl("http://10.255.255.255/x").ok).toBe(false);
		expect(validateUrl("http://172.16.0.1/x").ok).toBe(false);
		expect(validateUrl("http://172.31.255.255/x").ok).toBe(false);
		expect(validateUrl("http://192.168.1.1/x").ok).toBe(false);
	});

	it("rejects link-local, CGNAT, benchmark, and discard ranges", () => {
		expect(validateUrl("http://169.254.169.254/latest/meta-data").ok).toBe(false);
		expect(validateUrl("http://100.64.0.1/x").ok).toBe(false);
		expect(validateUrl("http://198.18.0.1/x").ok).toBe(false);
		expect(validateUrl("http://192.0.2.1/x").ok).toBe(false);
	});

	it("rejects private and special IPv6 ranges including IPv4-mapped", () => {
		expect(validateUrl("http://[fe80::1]/x").ok).toBe(false);
		expect(validateUrl("http://[fc00::1]/x").ok).toBe(false);
		expect(validateUrl("http://[fd12:3456::1]/x").ok).toBe(false);
		expect(validateUrl("http://[ff02::1]/x").ok).toBe(false);
		expect(validateUrl("http://[::ffff:10.0.0.1]/x").ok).toBe(false);
		expect(validateUrl("http://[::ffff:192.168.0.1]/x").ok).toBe(false);
	});

	it("allows public IPv6 and IPv4-mapped public addresses", () => {
		expect(validateUrl("http://[2606:4700::6810:85e3]/x")).toEqual({ ok: true });
		expect(validateUrl("http://[::ffff:93.184.216.34]/x")).toEqual({ ok: true });
	});

	it("rejects cloud metadata hosts and private suffixes", () => {
		expect(validateUrl("http://metadata.google.internal/x").ok).toBe(false);
		expect(validateUrl("http://foo.metadata.google.internal/x").ok).toBe(false);
		expect(validateUrl("http://myserver.local/x").ok).toBe(false);
		expect(validateUrl("http://service.internal/x").ok).toBe(false);
	});

	it("rejects non-standard ports", () => {
		expect(validateUrl("http://example.com:22/x").ok).toBe(false);
		expect(validateUrl("http://example.com:25/x").ok).toBe(false);
		expect(validateUrl("http://example.com:3306/x").ok).toBe(false);
		expect(validateUrl("http://example.com:9999/x").ok).toBe(false);
	});

	it("rejects unparseable URLs", () => {
		expect(validateUrl("not a url").ok).toBe(false);
		expect(validateUrl("").ok).toBe(false);
	});
});

describe("validateRedirect", () => {
	it("allows same-origin and cross-origin https redirects to public hosts", () => {
		expect(
			validateRedirect("https://a.example/x", "https://a.example/y"),
		).toEqual({ ok: true });
		expect(
			validateRedirect("https://a.example/x", "https://b.example/y"),
		).toEqual({ ok: true });
	});

	it("blocks a redirect whose destination violates base policy", () => {
		expect(
			validateRedirect("https://a.example/x", "http://127.0.0.1:8080/y").ok,
		).toBe(false);
		expect(
			validateRedirect("https://a.example/x", "https://internal.local/y").ok,
		).toBe(false);
	});

	it("blocks TLS downgrade redirects", () => {
		const r = validateRedirect("https://a.example/x", "http://a.example/y");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.message).toContain("downgrade");
	});

	it("allows http to https upgrades", () => {
		expect(validateRedirect("http://a.example/x", "https://a.example/y")).toEqual({
			ok: true,
		});
	});
});

describe("isPrivateHost", () => {
	it("recognizes string hosts without URL parsing", () => {
		expect(isPrivateHost("localhost")).toBe(true);
		expect(isPrivateHost("10.1.2.3")).toBe(true);
		expect(isPrivateHost("[fe80::1]")).toBe(true);
		expect(isPrivateHost("example.com")).toBe(false);
		expect(isPrivateHost("93.184.216.34")).toBe(false);
	});
});
