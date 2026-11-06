import { describe, expect, it } from "vitest";
import { parseQuotaAttachments } from "./attachments.js";

function noExpand(path: string): string {
	return path;
}

function config(providers: Record<string, unknown>): string {
	return JSON.stringify({ providers });
}

describe("quota attachment configuration", () => {
	it("attaches usage policy to the actual pi provider ID and passes source settings through", () => {
		const result = parseQuotaAttachments(
			config({
				llmgateway: {
					module: "/quota/devpass.ts",
					bypassAllowed: false,
					lookaheadHours: 12,
					maxPollSeconds: 60,
					enforceHardCap: true,
					billingCycleAnchor: "2025-01-15T00:00:00Z",
				},
			}),
			noExpand,
		);

		expect(result.warnings).toEqual([]);
		expect(result.attachments).toEqual([{
			providerId: "llmgateway",
			modulePath: "/quota/devpass.ts",
			enabled: true,
			policy: {
				bypassAllowed: false,
				lookaheadHours: 12,
				maxPollSeconds: 60,
				enforceHardCap: true,
			},
			settings: { billingCycleAnchor: "2025-01-15T00:00:00Z" },
		}]);
	});

	it("keeps disabled attachments in the resolved configuration", () => {
		const result = parseQuotaAttachments(
			config({ disabled: { module: "~/disabled.ts", enabled: false } }),
			(path) => path.replace("~/", "/home/test/"),
		);

		expect(result.attachments).toHaveLength(1);
		expect(result.attachments[0]).toMatchObject({
			providerId: "disabled",
			modulePath: "/home/test/disabled.ts",
			enabled: false,
		});
	});

	it("drops malformed source entries with a warning while preserving valid provider IDs", () => {
		const result = parseQuotaAttachments(
			config({
				bad: { enabled: true },
				valid: { module: "/quota/source.ts" },
			}),
			noExpand,
		);

		expect(result.attachments).toHaveLength(1);
		expect(result.attachments[0].providerId).toBe("valid");
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toMatch(/bad/);
	});
});
