import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import source from "./devpass-quota.js";

const MONTHLY_KEY = {
	devPlan: "pro",
	devPlanCreditsUsed: "12",
	devPlanCreditsLimit: "100",
	devPlanPremiumWeeklyLimit: "50",
	devPlanPremiumCreditsUsed: "7",
	devPlanPremiumWeekResetsAt: "2026-04-18T00:00:00.000Z",
};

const CATALOG = {
	data: [
		{
			id: "premium-by-input",
			pricing: { prompt: "0.000006", completion: "0.000001" },
			providers: [
				{
					streaming: true,
					tools: true,
					pricing: { prompt: "0.000006", completion: "0.000001" },
				},
			],
		},
		{
			id: "premium-by-output",
			pricing: { prompt: "0.000001", completion: "0.000015" },
			providers: [{ streaming: true, tools: true, pricing: { prompt: "0.000001", completion: "0.000001" } }],
		},
		{
			id: "standard",
			pricing: { prompt: "0.000001", completion: "0.000001" },
			providers: [{ streaming: true, tools: true, pricing: { prompt: "0.000001", completion: "0.000001" } }],
		},
	],
};

function response(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

describe("DevPass quota source", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-04-15T12:00:00.000Z"));
		vi.stubEnv("LLMGATEWAY_API_KEY", "test-key");
		vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			return url.endsWith("/key") ? response({ data: MONTHLY_KEY }) : response(CATALOG);
		}));
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
	});

	it("returns independent monthly and premium-weekly snapshots with opaque model limit IDs", async () => {
		const result = await source.getUsage({
			settings: { billingCycleAnchor: "2025-01-15T00:00:00Z" },
		});

		expect(result.snapshots).toHaveLength(2);
		expect(result.snapshots[0]).toMatchObject({
			label: "Monthly",
			spend: 12,
			quota: 100,
		});
		expect(result.snapshots[0]).toMatchObject({
			windowStart: Date.parse("2026-04-15T00:00:00Z"),
			windowEnd: Date.parse("2026-05-15T00:00:00Z"),
			asOf: Date.parse("2026-04-15T12:00:00Z"),
		});
		expect(result.snapshots[0].limitId).toBeUndefined();
		expect(result.snapshots[1]).toMatchObject({
			label: "Premium",
			limitId: "premium-weekly",
			spend: 7,
			quota: 50,
			windowStart: Date.parse("2026-04-11T00:00:00Z"),
			windowEnd: Date.parse("2026-04-18T00:00:00Z"),
		});
		expect(result.modelLimitIds).toEqual({
			"premium-by-input": ["premium-weekly"],
			"premium-by-output": ["premium-weekly"],
		});
		expect(result.modelLimitIds).not.toHaveProperty("standard");
	});

	it("uses eligible-provider medians when catalog pricing does not cross the premium threshold", async () => {
		const fetchMock = vi.mocked(fetch);
		fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/key")) return response({ data: MONTHLY_KEY });
			return response({
				data: [{
					id: "median-premium",
					pricing: {},
					providers: [
						{ streaming: true, tools: true, pricing: { prompt: "0.000004", completion: "0.000001" } },
						{ streaming: true, tools: true, pricing: { prompt: "0.000006", completion: "0.000001" } },
					],
				}],
			});
		});

		const result = await source.getUsage({
			settings: { billingCycleAnchor: "2025-01-15T00:00:00Z" },
		});

		expect(result.modelLimitIds).toEqual({ "median-premium": ["premium-weekly"] });
	});

	it("omits the weekly snapshot when the premium pool is absent", async () => {
		vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => String(input).endsWith("/key")
			? response({ data: { ...MONTHLY_KEY, devPlanPremiumWeeklyLimit: "0" } })
			: response(CATALOG));
		const result = await source.getUsage({ settings: { billingCycleAnchor: "2025-01-15T00:00:00Z" } });
		expect(result.snapshots).toHaveLength(1);
		expect(result.snapshots[0].limitId).toBeUndefined();
	});

	it("rejects an invalid usage response and a failed upstream request", async () => {
		await expect(source.getUsage({ settings: { billingCycleAnchor: "2025-01-15T00:00:00Z" } })).resolves.toBeDefined();
		vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => String(input).endsWith("/key")
			? response({ data: { ...MONTHLY_KEY, devPlanCreditsUsed: "invalid" } }) : response(CATALOG));
		await expect(source.getUsage({ settings: { billingCycleAnchor: "2025-01-15T00:00:00Z" } })).rejects.toThrow();
		vi.mocked(fetch).mockResolvedValue(new Response("unavailable", { status: 503 }));
		await expect(source.getUsage({ settings: { billingCycleAnchor: "2025-01-15T00:00:00Z" } })).rejects.toThrow();
	});

	it("is a quota-only source and does not expose model or token provisioning seams", async () => {
		const result = await source.getUsage({
			settings: { billingCycleAnchor: "2025-01-15T00:00:00Z" },
		});

		expect(result.snapshots.length).toBeGreaterThan(0);
		expect(source).not.toHaveProperty("discoverModels");
		expect(source).not.toHaveProperty("getToken");
		expect(source).not.toHaveProperty("isRetryableError");
	});
});
