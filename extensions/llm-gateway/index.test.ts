import { InMemoryModelsStore } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import registerLLMGateway from "./index.js";

const NOW = Date.parse("2026-04-15T12:00:00Z");

async function captureRegistration() {
	const registerProvider = vi.fn();
	await registerLLMGateway({ registerProvider } as any);
	const [providerId, config] = registerProvider.mock.calls[0] ?? [];
	return { providerId, config } as { providerId: string; config: Record<string, any> };
}

function storedModel() {
	return {
		id: "stored-model", name: "Stored model", provider: "llmgateway",
		baseUrl: "https://api.llmgateway.io/v1", api: "openai-completions",
		input: ["text"], reasoning: false, contextWindow: 16_000, maxTokens: 2_000,
		cost: { input: 1, output: 2, cacheRead: 1, cacheWrite: 1 },
	};
}

function catalogResponse() {
	return new Response(JSON.stringify({ data: [
		{
			id: "coding-model", display_name: "Coding model", context_length: 131_072,
			max_output: 8_192, architecture: { input_modalities: ["text", "image"] },
			supported_parameters: ["reasoning"],
			providers: [{ streaming: true, tools: true, reasoning: true, pricing: {
				prompt: "0.000001", completion: "0.000004", input_cache_read: "0.0000005", input_cache_write: "0.000002",
			} }],
		},
		{ id: "unsupported", providers: [{ streaming: true, tools: false, pricing: { prompt: "1e-6", completion: "1e-6" } }] },
	] }));
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	vi.stubEnv("LLMGATEWAY_API_KEY", "gateway-key");
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

describe("LLM Gateway provider registration", () => {
	it("registers the provider ID and delegates streaming to pi's OpenAI adapter", async () => {
		const { providerId, config } = await captureRegistration();
		expect(providerId).toBe("llmgateway");
		expect(config).toMatchObject({ name: "LLM Gateway DevPass", baseUrl: "https://api.llmgateway.io/v1", api: "openai-completions", apiKey: "$LLMGATEWAY_API_KEY", authHeader: true });
		expect(config.streamSimple).toBeUndefined();
		expect(typeof config.refreshModels).toBe("function");
	});

	it("round-trips a refreshed catalog through pi's store and restores it in fresh and offline runtimes", async () => {
		const store = new InMemoryModelsStore();
		const { config } = await captureRegistration();
		const fetchMock = vi.fn(async () => catalogResponse());
		vi.stubGlobal("fetch", fetchMock);
		const publish = async ({ persist }: any) => {
			if (persist) await store.write("llmgateway", persist);
			return true;
		};
		const models = await config.refreshModels({ stored: undefined, allowNetwork: true, force: false, signal: new AbortController().signal, publish });
		expect(models).toEqual([expect.objectContaining({
			id: "coding-model", name: "Coding model", input: ["text", "image"], reasoning: true,
			contextWindow: 131_072, maxTokens: 8_192,
			cost: { input: 1, output: 4, cacheRead: 0.5, cacheWrite: 2 },
		})]);
		const stored = await store.read("llmgateway");
		expect(stored).toMatchObject({ checkedAt: NOW, models: [expect.objectContaining({
			id: "coding-model", name: "Coding model", provider: "llmgateway", baseUrl: "https://api.llmgateway.io/v1", api: "openai-completions",
			input: ["text", "image"], reasoning: true, contextWindow: 131_072, maxTokens: 8_192,
			cost: { input: 1, output: 4, cacheRead: 0.5, cacheWrite: 2 },
		})] });

		const freshRuntime = (await captureRegistration()).config;
		const fresh = await freshRuntime.refreshModels({ stored, allowNetwork: true, force: false, signal: new AbortController().signal, publish });
		const offlineRuntime = (await captureRegistration()).config;
		const offline = await offlineRuntime.refreshModels({ stored, allowNetwork: false, force: true, signal: new AbortController().signal, publish });
		expect(fresh).toEqual([expect.objectContaining({ id: "coding-model" })]);
		expect(offline).toEqual([expect.objectContaining({ id: "coding-model" })]);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it.each([
		{ name: "stale", checkedAt: NOW - 3_600_000, force: false },
		{ name: "forced", checkedAt: NOW, force: true },
	])("refreshes a $name catalog using gateway authentication", async ({ checkedAt, force }) => {
		const { config } = await captureRegistration();
		const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			expect(String(input)).toBe("https://api.llmgateway.io/v1/models");
			expect(new Headers(init?.headers).get("authorization")).toBe("Bearer gateway-key");
			return catalogResponse();
		});
		vi.stubGlobal("fetch", fetchMock);
		await config.refreshModels({ stored: { models: [storedModel()], checkedAt }, allowNetwork: true, force, signal: new AbortController().signal, publish: vi.fn(async () => true) });
		expect(fetchMock).toHaveBeenCalled();
	});

	it("cancels an in-flight refresh without publishing", async () => {
		const { config } = await captureRegistration();
		const controller = new AbortController();
		const publish = vi.fn();
		let started!: () => void;
		const fetchStarted = new Promise<void>((resolve) => { started = resolve; });
		vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise((_resolve, reject) => {
			started();
			init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
		})));
		const refresh = Promise.resolve(config.refreshModels({ allowNetwork: true, force: true, signal: controller.signal, publish })).catch(() => {});
		await fetchStarted;
		controller.abort();
		await refresh;
		expect(publish).not.toHaveBeenCalled();
	});

	it("does not fetch or publish after cancellation", async () => {
		const { config } = await captureRegistration();
		const fetchMock = vi.fn();
		const publish = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const controller = new AbortController();
		controller.abort();
		await Promise.resolve(config.refreshModels({ allowNetwork: true, force: true, signal: controller.signal, publish })).catch(() => {});
		expect(fetchMock).not.toHaveBeenCalled();
		expect(publish).not.toHaveBeenCalled();
	});
});
