import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { InMemoryModelsStore } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import quotaExtension from "./index.js";
import { wrapProviderWithQuota } from "./lib/provider-wrapper.js";

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
			unregisterProvider: (providerId: string) => registry.unregisterProvider(providerId),
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

async function createDynamicAttachment(
	providerId: string,
	refreshModels: (context: any) => Promise<any[]>,
) {
	const dir = mkdtempSync(join(tmpdir(), "quota-dynamic-"));
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
	registry.registerProvider(providerId, {
		baseUrl: "https://example.test/v1",
		api: "openai-completions",
		apiKey: "test-key",
		models: [model("initial", providerId)],
		refreshModels,
	} as any);
	const { pi, events } = makePi(registry);
	await quotaExtension(pi as any);
	const manager = { getSessionId: () => `${providerId}-session` };
	const ctx = {
		modelRegistry: registry,
		sessionManager: manager,
		hasUI: false,
		ui: { notify: vi.fn(), setStatus: vi.fn() },
		model: model("initial", providerId),
	};
	await events.get("session_start")?.({}, ctx);
	cleanups.push(async () => { await events.get("session_shutdown")?.({}, ctx); });
	return { dir, registry, events, ctx };
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
		const models = (modelId: string, api = "openai-completions") => ({ providers: {
			[providerId]: {
				baseUrl: "https://example.test/v1",
				api,
				apiKey: "test-key",
				models: [{ ...model(modelId, providerId), api }],
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
		await new Promise((resolve) => setTimeout(resolve, 25));

		writeFileSync(modelsPath, JSON.stringify(models("replacement", "anthropic-messages")));
		await registry.refresh({ allowNetwork: false });
		const effective = registry.getProvider(providerId)!;
		expect(effective.getModels().map((entry) => entry.id)).toEqual(["replacement"]);
		const replacement = effective.getModels().find((entry) => entry.id === "replacement")!;
		let result;
		try {
			result = await effective.streamSimple(replacement, { messages: [] } as any, {} as any).result();
		} catch (error) {
			expect(String(error)).toMatch(/quota/i);
			return;
		}

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(/quota/i);
	});

	it("preserves the refreshed DevPass catalog before refresh resolves", async () => {
		let refreshed = false;
		const attachment = await createDynamicAttachment("dynamic-provider", async (context) => {
			if (!context.allowNetwork) return [model("initial", "dynamic-provider")];
			return [model(refreshed ? "refreshed" : "initial", "dynamic-provider")];
		});
		await new Promise((resolve) => setTimeout(resolve, 25));
		refreshed = true;

		await attachment.registry.refresh({ providers: ["dynamic-provider"], allowNetwork: true, force: true });
		expect(attachment.registry.getProvider("dynamic-provider")?.getModels().map((entry) => entry.id))
			.toEqual(["refreshed"]);
	});

	it("lets only the latest overlapping refresh rebuild the attachment", async () => {
		let calls = 0;
		let aborted = 0;
		const gates: (() => void)[] = [];
		const attachment = await createDynamicAttachment("overlap-provider", async (context) => {
			if (!context.allowNetwork) return [model("initial", "overlap-provider")];
			const index = calls++;
			return new Promise<any[]>((resolve, reject) => {
				gates[index] = () => resolve([model(`refresh-${index}`, "overlap-provider")]);
				context.signal.addEventListener("abort", () => {
					aborted += 1;
					reject(new DOMException("aborted", "AbortError"));
				}, { once: true });
			});
		});
		await new Promise((resolve) => setTimeout(resolve, 25));

		const first = attachment.registry.refresh({ providers: ["overlap-provider"], allowNetwork: true, force: true });
		for (let index = 0; index < 100 && calls < 1; index += 1) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		const second = attachment.registry.refresh({ providers: ["overlap-provider"], allowNetwork: true, force: true });
		for (let index = 0; index < 100 && calls < 2; index += 1) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		if (calls < 2) throw new Error("overlapping refreshes did not start");

		gates[0]!();
		await first;
		expect(aborted).toBe(1);
		gates[1]!();
		await second;
		expect(aborted).toBe(1);
		expect(attachment.registry.getProvider("overlap-provider")?.getModels().map((entry) => entry.id))
			.toEqual(["refresh-1"]);
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

	it("rebuilds the attachment around an external provider replacement", async () => {
		const attachment = await createNativeAttachment("replaceable-provider", "original");
		const replacement = nativeProvider("replaceable-provider", "replacement");
		attachment.registry.registerProvider(replacement);
		await attachment.events.get("agent_start")?.({}, attachment.ctx);

		expect((attachment.registry.getProvider("replaceable-provider") as any).marker).toBe("replacement");
		expect(() => attachment.registry.getProvider("replaceable-provider")!.streamSimple(
			model("standard", "replaceable-provider"),
			{ messages: [] } as any,
			{ sessionId: attachment.ctx.sessionManager.getSessionId() } as any,
		)).toThrow(/quota/i);
	});

	it("does not trust a caller-owned nested-guard marker", () => {
		const provider = nativeProvider("marker-provider", "marker");
		const evaluate = vi.fn(() => ({ blocked: true as const, kind: "hard" as const, message: "quota blocked" }));
		const wrapped = wrapProviderWithQuota(provider, evaluate);
		const options = { [Symbol.for("my-pi.quota-provider-nested-guard")]: true } as any;

		expect(() => wrapped.streamSimple(
			model("standard", "marker-provider"),
			{ messages: [] } as any,
			options,
		)).toThrow("quota blocked");
		expect(evaluate).toHaveBeenCalledTimes(1);
	});

	it("uses the latest evaluator after rewrapping", () => {
		const provider = nativeProvider("rewrapped", "rewrapped");
		const allowed = vi.fn(() => ({ blocked: false as const }));
		const wrapped = wrapProviderWithQuota(provider, allowed);
		const blocked = vi.fn(() => ({ blocked: true as const, kind: "hard" as const, message: "quota blocked" }));
		const rewrapped = wrapProviderWithQuota(wrapped, blocked);

		expect(() => rewrapped.streamSimple(
			model("standard", "rewrapped"),
			{ messages: [] } as any,
			{} as any,
		)).toThrow("quota blocked");
		expect(allowed).not.toHaveBeenCalled();
		expect(blocked).toHaveBeenCalledTimes(1);
	});

	it("evaluates concurrent requests that reuse one options object", async () => {
		const provider = nativeProvider("shared-options", "shared");
		provider.streamSimple = vi.fn(() => ({ result: () => Promise.resolve({}) }));
		const evaluate = vi.fn(() => ({ blocked: false as const }));
		const wrapped = wrapProviderWithQuota(provider, evaluate);
		const options = {} as any;

		const first = wrapped.streamSimple(model("standard", "shared-options"), { messages: [] } as any, options);
		const second = wrapped.streamSimple(model("standard", "shared-options"), { messages: [] } as any, options);
		expect(evaluate).toHaveBeenCalledTimes(2);
		await Promise.all([first.result(), second.result()]);
	});
});
