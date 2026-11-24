import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryModelsStore } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import quotaExtension from "./index.js";

const quotaSource = join(dirname(fileURLToPath(import.meta.url)), "test/fake-quota-source.ts");
const tempDirs: string[] = [];
const cleanups: (() => Promise<void>)[] = [];

function chatModel(id: string, provider: string) {
	return {
		id,
		name: id,
		provider,
		api: "openai-completions",
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 1024,
	} as any;
}

function genetecProvider(marker: string) {
	return {
		id: "genetec",
		name: "Genetec",
		marker,
		baseUrl: "https://example.test/v1",
		auth: {
			apiKey: {
				resolve: async () => ({ auth: { apiKey: marker } }),
			},
		},
		getModels: () => [chatModel("gen-model", "genetec")],
		streamSimple: () => "native result",
		stream: () => "native stream",
	} as any;
}

const gatewayConfig = {
	name: "LLM Gateway",
	baseUrl: "https://example.test/v1",
	api: "openai-completions",
	apiKey: "gateway-key",
	authHeader: true,
	models: [{
		id: "gateway-model",
		name: "gateway-model",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 1024,
	}],
} as any;

function extensionApi(registry: ModelRegistry) {
	const events = new Map<string, Function>();
	return {
		events,
		pi: {
			on: (name: string, handler: Function) => events.set(name, handler),
			registerCommand: vi.fn(),
			registerProvider: (...args: any[]) => args.length === 1
				? registry.registerProvider(args[0])
				: registry.registerProvider(args[0], args[1]),
			unregisterProvider: (providerId: string) => registry.unregisterProvider(providerId),
		},
	};
}

function configureQuota(dir: string): void {
	writeFileSync(join(dir, "quota-providers.json"), JSON.stringify({ providers: {
		genetec: { module: quotaSource, maxPollSeconds: 3600, enforceHardCap: true },
		llmgateway: { module: quotaSource, maxPollSeconds: 3600, enforceHardCap: true },
	} }));

	const now = Date.now();
	for (const providerId of ["genetec", "llmgateway"]) {
		const cacheDir = join(dir, "cache", "quota-providers", providerId);
		mkdirSync(cacheDir, { recursive: true });
		writeFileSync(join(cacheDir, "usage.json"), JSON.stringify({
			writtenAt: now,
			snapshots: [{
				spend: 10,
				quota: 10,
				windowStart: now - 86_400_000,
				windowEnd: now + 86_400_000,
				asOf: now,
			}],
			modelLimitIds: {},
		}));
	}
}

async function createQuotaSession(registry: ModelRegistry, id: string, dir: string) {
	vi.stubEnv("PI_CODING_AGENT_DIR", dir);
	const { pi, events } = extensionApi(registry);
	await quotaExtension(pi as any);
	const ctx = {
		modelRegistry: registry,
		sessionManager: { getSessionId: () => id },
		hasUI: false,
		ui: { notify: vi.fn(), setStatus: vi.fn() },
		model: chatModel("gen-model", "genetec"),
	};
	await events.get("session_start")?.({}, ctx);
	let active = true;
	const shutdown = async () => {
		if (!active) {return;}
		active = false;
		await events.get("session_shutdown")?.({}, ctx);
	};
	cleanups.push(shutdown);
	return { events, ctx, shutdown };
}

async function settleRuntime(runtime: ModelRuntime): Promise<void> {
	await runtime.refresh({ allowNetwork: false });
}

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) {await cleanup();}
	vi.unstubAllEnvs();
	for (const dir of tempDirs.splice(0)) {rmSync(dir, { recursive: true, force: true });}
});

describe("quota provider lifecycle on a shared runtime", () => {
	it("keeps shared providers and their quota checks after an adopting session shuts down", async () => {
		const dir = mkdtempSync(join(tmpdir(), "quota-shared-runtime-"));
		tempDirs.push(dir);
		configureQuota(dir);

		const runtime = await ModelRuntime.create({
			modelsPath: null,
			authPath: join(dir, "auth.json"),
			modelsStore: new InMemoryModelsStore(),
			refreshOnCreate: false,
		});

		const firstRegistry = new ModelRegistry(runtime);
		firstRegistry.registerProvider(genetecProvider("first"));
		firstRegistry.registerProvider("llmgateway", gatewayConfig);
		await settleRuntime(runtime);
		const firstSession = await createQuotaSession(firstRegistry, "first-session", dir);
		await settleRuntime(runtime);

		const secondRegistry = new ModelRegistry(runtime);
		secondRegistry.registerProvider(genetecProvider("second"));
		secondRegistry.registerProvider("llmgateway", gatewayConfig);
		await settleRuntime(runtime);
		const secondSession = await createQuotaSession(secondRegistry, "second-session", dir);
		await settleRuntime(runtime);

		await firstSession.events.get("agent_start")?.({}, firstSession.ctx);
		await settleRuntime(runtime);
		await firstSession.shutdown();

		for (const [providerId, modelId] of [
			["genetec", "gen-model"],
			["llmgateway", "gateway-model"],
		]) {
			const model = runtime.getModel(providerId, modelId);
			expect(model).toBeDefined();
			expect(await runtime.getAuth(model!)).toMatchObject({
				auth: { apiKey: expect.any(String) },
			});
			expect(() => runtime.getProvider(providerId)!.streamSimple(
				model!,
				{ messages: [] } as any,
				{ sessionId: "second-session" } as any,
			)).toThrow(/quota/i);
		}

		await secondSession.shutdown();
	});
});
