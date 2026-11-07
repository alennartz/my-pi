import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { InMemoryModelsStore } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import quotaExtension from "./index.js";

const source = join(dirname(fileURLToPath(import.meta.url)), "test/fake-quota-source.ts");
const dirs: string[] = [];
const cleanups: (() => Promise<void>)[] = [];
const day = 86_400_000;

function model(id: string, provider: string) {
	return {
		id,
		name: id,
		provider,
		api: "openai-completions",
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8_192,
		maxTokens: 1_024,
	} as any;
}

function nativeProvider(id: string, marker: string) {
	return {
		id,
		marker,
		name: "Native provider",
		baseUrl: "https://example.test/v1",
		auth: { apiKey: { resolve: async () => ({ auth: { apiKey: marker } }) } },
		getModels: () => [model("standard", id)],
		streamSimple: vi.fn(() => "native-result"),
		stream: () => "native-stream",
	} as any;
}

function snapshot() {
	const now = Date.now();
	return {
		spend: 10,
		quota: 10,
		windowStart: now - day,
		windowEnd: now + day,
		asOf: now,
	};
}

function makePi(registry: ModelRegistry) {
	const events = new Map<string, Function>();
	return {
		events,
		pi: {
			on: (name: string, handler: Function) => events.set(name, handler),
			registerCommand: vi.fn(),
			registerProvider: (...args: any[]) => args.length === 1
				? registry.registerProvider(args[0])
				: registry.registerProvider(args[0], args[1]),
		},
	};
}

function configureQuota(dir: string, providerId: string) {
	writeFileSync(join(dir, "quota-providers.json"), JSON.stringify({
		providers: {
			[providerId]: { module: source, maxPollSeconds: 3_600, enforceHardCap: true },
		},
	}));
	const cacheDir = join(dir, "cache", "quota-providers", providerId);
	mkdirSync(cacheDir, { recursive: true });
	writeFileSync(join(cacheDir, "usage.json"), JSON.stringify({
		writtenAt: Date.now(),
		snapshots: [snapshot()],
		modelLimitIds: {},
	}));
}

async function createNativeAttachment(providerId: string, marker: string) {
	const dir = mkdtempSync(join(tmpdir(), "quota-followup-"));
	dirs.push(dir);
	configureQuota(dir, providerId);
	vi.stubEnv("PI_CODING_AGENT_DIR", dir);
	const runtime = await ModelRuntime.create({
		modelsPath: null,
		authPath: join(dir, "auth.json"),
		modelsStore: new InMemoryModelsStore(),
		refreshOnCreate: false,
	});
	const registry = new ModelRegistry(runtime);
	const native = nativeProvider(providerId, marker);
	registry.registerProvider(native);
	const { pi, events } = makePi(registry);
	await quotaExtension(pi as any);
	const manager = { getSessionId: () => `${marker}-session` };
	const ctx = {
		modelRegistry: registry,
		sessionManager: manager,
		hasUI: false,
		ui: { notify: vi.fn(), setStatus: vi.fn() },
		model: model("standard", providerId),
	};
	await events.get("session_start")?.({}, ctx);
	cleanups.push(async () => { await events.get("session_shutdown")?.({}, ctx); });
	return { dir, registry, native, events, ctx };
}

async function cleanFirstSession(events: Map<string, Function>, ctx: any): Promise<void> {
	await events.get("session_shutdown")?.({}, ctx);
}

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("quota provider review follow-up", () => {
	it("keeps the quota guard on the first request after model registry recomposition", async () => {
		const dir = mkdtempSync(join(tmpdir(), "quota-refresh-"));
		dirs.push(dir);
		const providerId = "refresh-provider";
		const modelsPath = join(dir, "models.json");
		const models = (modelId: string) => ({ providers: {
			[providerId]: {
				baseUrl: "https://example.test/v1",
				api: "openai-completions",
				apiKey: "test-key",
				models: [model(modelId, providerId)],
			},
		} });
		writeFileSync(modelsPath, JSON.stringify(models("first")));
		configureQuota(dir, providerId);
		vi.stubEnv("PI_CODING_AGENT_DIR", dir);
		const runtime = await ModelRuntime.create({
			modelsPath,
			authPath: join(dir, "auth.json"),
			modelsStore: new InMemoryModelsStore(),
			refreshOnCreate: false,
		});
		const registry = new ModelRegistry(runtime);
		const { pi, events } = makePi(registry);
		await quotaExtension(pi as any);
		const manager = { getSessionId: () => "refresh-session" };
		const ctx = {
			modelRegistry: registry,
			sessionManager: manager,
			hasUI: false,
			ui: { notify: vi.fn(), setStatus: vi.fn() },
			model: model("first", providerId),
		};
		await events.get("session_start")?.({}, ctx);
		cleanups.push(() => cleanFirstSession(events, ctx));

		writeFileSync(modelsPath, JSON.stringify(models("replacement")));
		await registry.refresh({ allowNetwork: false });
		const effective = registry.getProvider(providerId)!;
		const replacement = effective.getModels().find((entry) => entry.id === "replacement")!;
		const result = await effective.streamSimple(replacement, { messages: [] } as any, {} as any).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(/quota/i);
	});

	it("keeps provider attachment state isolated by model registry", async () => {
		const first = await createNativeAttachment("shared-provider", "first");
		const second = await createNativeAttachment("shared-provider", "second");

		await first.events.get("agent_start")?.({}, first.ctx);
		await second.events.get("agent_start")?.({}, second.ctx);

		expect((first.registry.getProvider("shared-provider") as any).marker).toBe("first");
		expect((second.registry.getProvider("shared-provider") as any).marker).toBe("second");
		expect(() => first.registry.getProvider("shared-provider")!.streamSimple(
			model("standard", "shared-provider"),
			{ messages: [] } as any,
			{ sessionId: first.ctx.sessionManager.getSessionId() } as any,
		)).toThrow(/quota/i);
		expect(() => second.registry.getProvider("shared-provider")!.streamSimple(
			model("standard", "shared-provider"),
			{ messages: [] } as any,
			{ sessionId: second.ctx.sessionManager.getSessionId() } as any,
		)).toThrow(/quota/i);

		await first.events.get("session_shutdown")?.({}, first.ctx);
		expect((second.registry.getProvider("shared-provider") as any).marker).toBe("second");
		await second.events.get("session_shutdown")?.({}, second.ctx);
	});
});
