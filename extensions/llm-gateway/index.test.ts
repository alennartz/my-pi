import { afterEach, describe, expect, it, vi } from "vitest";
import registerLLMGateway from "./index.js";

async function captureRegistration() {
	const registerProvider = vi.fn();
	await registerLLMGateway({ registerProvider } as any);
	const [providerId, config] = registerProvider.mock.calls[0] ?? [];
	return { providerId, config } as {
		providerId: string;
		config: Record<string, any>;
	};
}

function storedModel() {
	return {
		id: "stored-model",
		name: "Stored model",
		api: "openai-completions",
		input: ["text"],
		reasoning: false,
		contextWindow: 16_000,
		maxTokens: 2_000,
		cost: { input: 1, output: 2, cacheRead: 1, cacheWrite: 1 },
	};
}

afterEach(() => {
	delete process.env.LLMGATEWAY_API_KEY;
	vi.unstubAllGlobals();
});

describe("LLM Gateway provider registration", () => {
	it("registers the provider ID and delegates streaming to pi's OpenAI adapter", async () => {
		const { providerId, config } = await captureRegistration();

		expect(providerId).toBe("llmgateway");
		expect(config).toMatchObject({
			name: "LLM Gateway DevPass",
			baseUrl: "https://api.llmgateway.io/v1",
			api: "openai-completions",
			apiKey: "$LLMGATEWAY_API_KEY",
			authHeader: true,
		});
		expect(config.streamSimple).toBeUndefined();
		expect(typeof config.refreshModels).toBe("function");
	});

	it("restores a fresh stored catalog without a network request", async () => {
		const { config } = await captureRegistration();
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const stored = { models: [storedModel()], checkedAt: Date.now() - 1_000 };

		const models = await config.refreshModels({
			stored,
			allowNetwork: true,
			force: false,
			signal: new AbortController().signal,
			publish: vi.fn(async () => true),
		});

		expect(models).toEqual(stored.models);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("restores the stored catalog offline and never attempts the gateway", async () => {
		const { config } = await captureRegistration();
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const stored = { models: [storedModel()], checkedAt: 0 };

		const models = await config.refreshModels({
			stored,
			allowNetwork: false,
			force: true,
			signal: new AbortController().signal,
			publish: vi.fn(async () => true),
		});

		expect(models).toEqual(stored.models);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("refreshes stale catalogs, maps supported models, and publishes the refreshed catalog", async () => {
		const { config } = await captureRegistration();
		const signal = new AbortController().signal;
		const publish = vi.fn(async () => true);
		const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			expect(String(input)).toBe("https://api.llmgateway.io/v1/models");
			expect(init?.signal).toBe(signal);
			const headers = new Headers(init?.headers);
			expect(headers.get("authorization")).toBe("Bearer gateway-key");
			expect(headers.get("accept")).toBe("application/json");
			return new Response(JSON.stringify({
				data: [
					{
						id: "coding-model",
						display_name: "Coding model",
						context_length: 131_072,
						max_output: 8_192,
						architecture: { input_modalities: ["text", "image"] },
						supported_parameters: ["reasoning"],
						providers: [
							{
								streaming: true,
								tools: true,
								reasoning: true,
								pricing: {
									prompt: "0.000001",
									completion: "0.000004",
									input_cache_read: "0.0000005",
									input_cache_write: "0.000002",
								},
							},
						],
					},
					{
						id: "unsupported",
						providers: [{ streaming: true, tools: false, pricing: { prompt: "1e-6", completion: "1e-6" } }],
					},
				],
			}));
		});
		process.env.LLMGATEWAY_API_KEY = "gateway-key";
		vi.stubGlobal("fetch", fetchMock);

		const models = await config.refreshModels({
			stored: { models: [], checkedAt: Date.now() - 3_600_001 },
			allowNetwork: true,
			force: false,
			signal,
			publish,
		});

		expect(models).toEqual([expect.objectContaining({
			id: "coding-model",
			name: "Coding model",
			api: "openai-completions",
			input: ["text", "image"],
			reasoning: true,
			contextWindow: 131_072,
			maxTokens: 8_192,
			cost: {
				input: 1,
				output: 4,
				cacheRead: 0.5,
				cacheWrite: 2,
			},
		})]);
		expect(publish).toHaveBeenCalledWith({
			persist: expect.objectContaining({ models: models }),
		});
	});

	it("refreshes even a fresh catalog when forced", async () => {
		const { config } = await captureRegistration();
		const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [] })));
		vi.stubGlobal("fetch", fetchMock);

		await config.refreshModels({
			stored: { models: [storedModel()], checkedAt: Date.now() },
			allowNetwork: true,
			force: true,
			signal: new AbortController().signal,
			publish: vi.fn(async () => true),
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
