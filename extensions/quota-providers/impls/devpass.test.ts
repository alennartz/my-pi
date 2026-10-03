import { describe, expect, it } from "vitest";
import { buildModelEntries } from "./devpass.js";

describe("buildModelEntries", () => {
	it("keeps canonical model ids with streaming+tools support and per-field median prices", () => {
		const entries = buildModelEntries([
			{
				id: "coding-model",
				display_name: "Coding Model",
				architecture: { input_modalities: ["text", "image"] },
				context_length: 131_072,
				max_output: 8_192,
				supported_parameters: ["stream", "tools", "reasoning"],
				providers: [
					{
						providerId: "provider-a",
					streaming: true,
					tools: true,
					pricing: {
						prompt: "0.000001",
						completion: "0.000004",
						input_cache_read: "0.0000005",
						input_cache_write: "0.000002",
					},
				},
					{
						providerId: "provider-b",
						streaming: true,
						tools: true,
					pricing: {
						prompt: "3e-6",
						completion: "8e-6",
						input_cache_read: "0.1e-6",
						input_cache_write: "4e-6",
					},
				},
					{
						providerId: "no-tools",
						streaming: true,
						tools: false,
						pricing: {
						prompt: "0.000000001",
						completion: "0.000000001",
					input_cache_read: "0",
					input_cache_write: "0",
					},
					},
					{
						providerId: "no-streaming",
						streaming: false,
						tools: true,
						pricing: {
						prompt: "0.000000001",
						completion: "0.000000001",
					},
					},
				],
			},
			{
				id: "non-coding-model",
				providers: [{ streaming: true, tools: false, pricing: { prompt: "0" } }],
			},
		]);

		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			id: "coding-model",
			name: "Coding Model",
			modelName: "coding-model",
			api: "openai-completions",
			authHeader: true,
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 131_072,
			maxTokens: 8_192,
			cost: {
				input: 2,
				output: 6,
				cacheRead: 0.3,
				cacheWrite: 3,
			},
		});
	});

	it("uses model id when display_name is absent and skips malformed or unsupported entries", () => {
		const entries = buildModelEntries([
			null,
			{ id: "missing-providers" },
			{ id: "no-eligible", providers: [{ streaming: true, tools: false, pricing: { prompt: "1e-6" } }] },
			{
				id: "eligible",
				providers: [
					{
						streaming: true,
						tools: true,
						pricing: { prompt: "2e-6", completion: "3e-6", input_cache_write_1h: "4e-6" },
					},
				],
			},
		]);

		expect(entries).toHaveLength(1);
		expect(entries[0].name).toBe("eligible");
		expect(entries[0].cost).toEqual({
			input: 2,
			output: 3,
			cacheRead: 2,
			cacheWrite: 4,
		});
	});

	describe("thinkingLevelMap", () => {
		const provider = (efforts?: string[]) => ({
			streaming: true,
			tools: true,
			reasoning: true,
			...(efforts ? { reasoning_efforts: efforts } : {}),
			pricing: { prompt: "1e-6", completion: "2e-6" },
		});
		const mapFor = (providers: unknown[]) => {
			const entries = buildModelEntries([{
				id: "m",
				supported_parameters: ["stream", "tools", "reasoning"],
				providers,
			}]);
			return entries[0]?.thinkingLevelMap;
		};

		it("leaves pi's default levels when no provider declares reasoning_efforts", () => {
			expect(mapFor([provider(), provider()])).toBeUndefined();
		});

		it("keeps default levels when the intersection collapses to disable-only values", () => {
			expect(mapFor([
				provider(["none"]),
				provider(["none", "low"]),
			])).toBeUndefined();
		});

		it("maps every level from the efforts all declaring providers agree on", () => {
			// xiaomi-style: one provider narrower than the other; a third declares nothing.
			expect(mapFor([
				provider(["none", "low", "medium", "high"]),
				provider(["none", "minimal", "low", "medium", "high", "xhigh", "max"]),
				provider(),
			])).toEqual({
				off: "none",
				minimal: "low",
				low: "low",
				medium: "medium",
				high: "high",
				xhigh: "high",
				max: "high",
			});
		});

		it("slots values around gaps by ladder order and omits off when no disable value is agreed", () => {
			expect(mapFor([provider(["none", "low", "high", "max"])])).toEqual({
				off: "none",
				minimal: "low",
				low: "low",
				medium: "high",
				high: "high",
				xhigh: "max",
				max: "max",
			});
			expect(mapFor([provider(["low", "medium", "high"])])).toEqual({
				minimal: "low",
				low: "low",
				medium: "medium",
				high: "high",
				xhigh: "high",
				max: "high",
			});
		});
	});

	it("does not register a model when all eligible providers have malformed prices", () => {
		const entries = buildModelEntries([
			{
				id: "bad-prices",
				providers: [{ streaming: true, tools: true, pricing: { prompt: "invalid", completion: "-1" } }],
			},
		]);
		expect(entries).toHaveLength(0);
	});
});
