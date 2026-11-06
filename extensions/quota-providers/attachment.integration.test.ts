import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryModelsStore } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import quotaExtension from "./index.js";
import { getOrCreateSessionTreeStore, registerSessionTreeStore } from "../subagents/scoped-store.js";

const source = join(dirname(fileURLToPath(import.meta.url)), "test/fake-quota-source.ts");
const dirs: string[] = [];
const cleanups: (() => Promise<void>)[] = [];
const day = 86_400_000;

function tempDir() {
	const dir = mkdtempSync(join(tmpdir(), "quota-attachment-"));
	dirs.push(dir);
	return dir;
}

function model(id: string, provider: string) {
	return { id, name: id, provider, api: "openai-completions", baseUrl: "https://example.test/v1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 } as any;
}

function nativeProvider(id: string) {
	return {
		id, name: "Native provider", baseUrl: "https://example.test/v1",
		auth: { apiKey: { resolve: async () => ({ auth: { apiKey: "secret" } }) } },
		getModels: () => [model("premium", id), model("standard", id)],
		streamSimple: vi.fn(() => "native-result"),
		stream: () => "native-stream",
	} as any;
}

async function setup(origin: "builtin" | "models.json" | "legacy" | "native", snapshots: any[], mapping: Record<string, string[]> = {}, hard = true) {
	const dir = tempDir();
	vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("unexpected network request"); }));
	const id = origin === "builtin" ? "openai" : `test-${origin.replace(".", "-")}`;
	const modelsPath = join(dir, "models.json");
	if (origin === "models.json") writeFileSync(modelsPath, JSON.stringify({ providers: { [id]: {
		baseUrl: "https://example.test/v1", api: "openai-completions", apiKey: "test-key",
		models: [{ id: "standard", name: "standard", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 }],
	} } }));
	const runtime = await ModelRuntime.create({ modelsPath: origin === "models.json" ? modelsPath : null, authPath: join(dir, "auth.json"), modelsStore: new InMemoryModelsStore(), refreshOnCreate: false });
	const registry = new ModelRegistry(runtime);
	if (origin === "legacy") registry.registerProvider(id, { baseUrl: "https://example.test/v1", api: "openai-completions", apiKey: "test-key", models: [{ id: "standard", name: "standard", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 }] });
	const native = nativeProvider(id);
	if (origin === "native") registry.registerProvider(native);
	const other = nativeProvider("unattached");
	registry.registerProvider(other);
	const original = registry.getProvider(id)!;
	const before = original.getModels().map((m) => m.id);
	expect(before.length).toBeGreaterThan(0);
	writeFileSync(join(dir, "quota-providers.json"), JSON.stringify({ providers: { [id]: { module: source, enforceHardCap: hard, lookaheadHours: 0, maxPollSeconds: 3600 } } }));
	const cacheDir = join(dir, "cache", "quota-providers", id);
	mkdirSync(cacheDir, { recursive: true });
	writeFileSync(join(cacheDir, "usage.json"), JSON.stringify({ writtenAt: Date.now(), snapshots, modelLimitIds: mapping }));
	vi.stubEnv("PI_CODING_AGENT_DIR", dir);
	const events = new Map<string, Function>();
	const commands = new Map<string, any>();
	const pi = {
		on: (name: string, handler: Function) => events.set(name, handler),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		registerProvider: (...args: any[]) => args.length === 1 ? registry.registerProvider(args[0]) : registry.registerProvider(args[0], args[1]),
	};
	await quotaExtension(pi as any);
	const manager = { getSessionId: () => `session-${dir}` };
	const ctx = { modelRegistry: registry, sessionManager: manager, hasUI: false, ui: { notify: vi.fn(), setStatus: vi.fn() }, model: model("standard", id) };
	await events.get("session_start")?.({}, ctx);
	cleanups.push(async () => { await events.get("session_shutdown")?.({}, ctx); });
	return { id, registry, native, other, before, events, commands, ctx, cacheDir };
}

function snapshot(spend: number, limitId?: string) {
	const now = Date.now();
	return { ...(limitId ? { limitId } : {}), spend, quota: 10, windowStart: now - 5 * day, windowEnd: now + 5 * day, asOf: now - 1000 };
}

function stream(registry: ModelRegistry, provider: string, id = "standard", sessionId?: string) {
	return registry.getProvider(provider)!.streamSimple(model(id, provider), { messages: [] }, { sessionId } as any);
}

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("quota attachments through the provider registry", () => {
	it.each(["builtin", "models.json", "legacy", "native"] as const)("blocks an attached %s provider without losing its models or authentication", async (origin) => {
		const { id, registry, native, other, before } = await setup(origin, [snapshot(10)]);
		const wrapped = registry.getProvider(id)!;
		expect(wrapped.id).toBe(id);
		expect(wrapped.getModels().map((m) => m.id)).toEqual(before);
		expect(wrapped.auth).toBeDefined();
		if (origin === "native") expect(await wrapped.auth.apiKey!.resolve({} as any)).toEqual({ auth: { apiKey: "secret" } });
		expect(() => stream(registry, id)).toThrow(/quota/i);
		if (origin === "native") expect(native.streamSimple).not.toHaveBeenCalled();
		expect(stream(registry, "unattached")).toBe("native-result");
		expect(other.streamSimple).toHaveBeenCalled();
	});

	it("applies cached global and scoped budgets to the right models", async () => {
		const { id, registry } = await setup("native", [snapshot(0), snapshot(6, "pool")], { premium: ["pool"] });
		expect(stream(registry, id, "standard")).toBe("native-result");
		expect(() => stream(registry, id, "premium")).toThrow(/quota/i);
		const global = await setup("native", [snapshot(6)], { premium: ["pool"] });
		expect(() => stream(global.registry, global.id, "standard")).toThrow(/quota/i);
		expect(() => stream(global.registry, global.id, "premium")).toThrow(/quota/i);
	});

	it("uses cached membership when recording local spend", async () => {
		const { id, registry, events, ctx } = await setup("native", [{ ...snapshot(0), quota: 100 }, snapshot(0, "pool")], { premium: ["pool"] });
		await events.get("message_end")?.({ message: { role: "assistant", provider: id, model: "premium", timestamp: Date.now(), usage: { cost: { total: 6 } } } }, ctx);
		expect(() => stream(registry, id, "premium")).toThrow(/quota/i);
		expect(stream(registry, id, "standard")).toBe("native-result");
	});

	it("bypasses soft limits but not enforced hard limits", async () => {
		const soft = await setup("native", [snapshot(6)]);
		await soft.commands.get("quota").handler("bypass on", soft.ctx);
		const child = { getSessionId: () => `${soft.ctx.sessionManager.getSessionId()}-child` };
		registerSessionTreeStore(child, getOrCreateSessionTreeStore(soft.ctx.sessionManager));
		const childCtx = { ...soft.ctx, sessionManager: child };
		await soft.events.get("agent_start")?.({}, childCtx);
		expect(stream(soft.registry, soft.id, "standard", child.getSessionId())).toBe("native-result");
		const other = { getSessionId: () => `${soft.ctx.sessionManager.getSessionId()}-other` };
		const otherCtx = { ...soft.ctx, sessionManager: other };
		await soft.events.get("session_start")?.({}, otherCtx);
		expect(() => stream(soft.registry, soft.id, "standard", other.getSessionId())).toThrow(/quota/i);
		await soft.events.get("session_shutdown")?.({}, childCtx);
		await soft.events.get("session_shutdown")?.({}, otherCtx);
		const hard = await setup("native", [snapshot(10)]);
		await hard.commands.get("quota").handler("bypass on", hard.ctx);
		expect(() => stream(hard.registry, hard.id, "standard", hard.ctx.sessionManager.getSessionId())).toThrow(/quota/i);
		const advisory = await setup("native", [snapshot(10)], {}, false);
		expect(stream(advisory.registry, advisory.id)).toBe("native-result");
	});
});
