import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadQuotaAttachments, parseQuotaAttachments } from "./attachments.js";
import { cachePaths, POLICY_KEYS } from "./config.js";

// Helpers

function noExpand(pathValue: string): string {
	return pathValue;
}

function makeRaw(providers: Record<string, unknown>): string {
	return JSON.stringify({ providers });
}

// parseQuotaAttachments

describe("parseQuotaAttachments", () => {
	it("applies policy defaults when optional fields are absent", () => {
		const raw = makeRaw({ myProvider: { module: "/path/to/source.ts" } });
		const { attachments, warnings } = parseQuotaAttachments(raw, noExpand);

		expect(warnings).toHaveLength(0);
		expect(attachments).toHaveLength(1);
		const [attachment] = attachments;
		expect(attachment.providerId).toBe("myProvider");
		expect(attachment.modulePath).toBe("/path/to/source.ts");
		expect(attachment.enabled).toBe(true);
		expect(attachment.policy).toEqual({
			bypassAllowed: true,
			lookaheadHours: 6,
			maxPollSeconds: 300,
			enforceHardCap: false,
		});
	});

	it("passes through explicit policy settings", () => {
		const raw = makeRaw({
			myProvider: {
				module: "/source.ts",
				bypassAllowed: false,
				lookaheadHours: 12,
				maxPollSeconds: 60,
				enforceHardCap: true,
			},
		});
		const { attachments } = parseQuotaAttachments(raw, noExpand);
		expect(attachments[0].policy).toEqual({
			bypassAllowed: false,
			lookaheadHours: 12,
			maxPollSeconds: 60,
			enforceHardCap: true,
		});
	});

	it("excludes POLICY_KEYS from settings passthrough", () => {
		const raw = makeRaw({
			myProvider: {
				module: "/source.ts",
				bypassAllowed: false,
				lookaheadHours: 12,
				maxPollSeconds: 60,
				enforceHardCap: true,
				enabled: true,
				endpoint: "https://example.com",
				resourceGroup: "my-rg",
			},
		});
		const { attachments } = parseQuotaAttachments(raw, noExpand);
		const { settings } = attachments[0];

		for (const key of POLICY_KEYS) expect(settings).not.toHaveProperty(key);
		expect(settings.endpoint).toBe("https://example.com");
		expect(settings.resourceGroup).toBe("my-rg");
	});

	it("expands ~ in source module paths via the expandHome callback", () => {
		const expandHome = (pathValue: string) =>
			pathValue.startsWith("~/") ? path.join("/home/user", pathValue.slice(2)) : pathValue;

		const raw = makeRaw({ myProvider: { module: "~/providers/source.ts" } });
		const { attachments } = parseQuotaAttachments(raw, expandHome);
		expect(attachments[0].modulePath).toBe("/home/user/providers/source.ts");
	});

	it("drops a malformed entry (non-string module) with a warning", () => {
		const raw = makeRaw({
			badProvider: { module: 42 },
			goodProvider: { module: "/source.ts" },
		});
		const { attachments, warnings } = parseQuotaAttachments(raw, noExpand);
		expect(attachments).toHaveLength(1);
		expect(attachments[0].providerId).toBe("goodProvider");
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toMatch(/badProvider/);
	});

	it("drops a malformed entry (missing module) with a warning", () => {
		const raw = makeRaw({ noModule: { endpoint: "https://x.com" } });
		const { attachments, warnings } = parseQuotaAttachments(raw, noExpand);
		expect(attachments).toHaveLength(0);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toMatch(/noModule/);
	});

	it("drops an entry whose block is not an object with a warning", () => {
		const raw = makeRaw({ badBlock: "not-an-object" });
		const { attachments, warnings } = parseQuotaAttachments(raw, noExpand);
		expect(attachments).toHaveLength(0);
		expect(warnings).toHaveLength(1);
	});

	it("returns warning and empty attachments on unparseable JSON", () => {
		const { attachments, warnings } = parseQuotaAttachments("{bad json{{", noExpand);
		expect(attachments).toHaveLength(0);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toMatch(/parse/i);
	});

	it("returns warning when providers field is missing or not an object", () => {
		const { attachments, warnings } = parseQuotaAttachments(JSON.stringify({ foo: 1 }), noExpand);
		expect(attachments).toHaveLength(0);
		expect(warnings).toHaveLength(1);
	});

	it("preserves disabled attachments", () => {
		const raw = makeRaw({ myProvider: { module: "/source.ts", enabled: false } });
		const { attachments } = parseQuotaAttachments(raw, noExpand);
		expect(attachments).toHaveLength(1);
		expect(attachments[0].enabled).toBe(false);
	});
});

// loadQuotaAttachments

describe("loadQuotaAttachments", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quota-providers-test-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns empty attachments and no warnings when the file is missing", () => {
		const { attachments, warnings } = loadQuotaAttachments(
			path.join(tmpDir, "does-not-exist.json"),
		);
		expect(attachments).toHaveLength(0);
		expect(warnings).toHaveLength(0);
	});

	it("loads and parses an existing config file", () => {
		const configPath = path.join(tmpDir, "quota-providers.json");
		fs.writeFileSync(
			configPath,
			JSON.stringify({
				providers: {
					testProvider: { module: "/tmp/source.ts", endpoint: "https://x.com" },
				},
			}),
		);

		const { attachments, warnings } = loadQuotaAttachments(configPath);
		expect(warnings).toHaveLength(0);
		expect(attachments).toHaveLength(1);
		expect(attachments[0].providerId).toBe("testProvider");
		expect(attachments[0].settings.endpoint).toBe("https://x.com");
	});
});

// cachePaths

describe("cachePaths", () => {
	it("returns usage and ledger paths nested under the provider cache directory", () => {
		const paths = cachePaths("/home/user/.pi/agent", "my-provider");
		const base = "/home/user/.pi/agent/cache/quota-providers/my-provider";
		expect(paths.dir).toBe(base);
		expect(paths.usage).toBe(path.join(base, "usage.json"));
		expect(paths.ledger).toBe(path.join(base, "ledger.jsonl"));
	});
});
