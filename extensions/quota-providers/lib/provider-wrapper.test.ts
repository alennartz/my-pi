import { describe, expect, it, vi } from "vitest";
import { wrapProviderWithQuota } from "./provider-wrapper.js";

function makeProvider() {
	const provider = {
		id: "provider",
		name: "Provider",
		baseUrl: "https://provider.example",
		headers: { "x-test": "1" },
		auth: { resolve: vi.fn() },
		getModels: vi.fn(() => []),
		getAllModels: vi.fn(() => []),
		refreshModels: vi.fn(async () => undefined),
		filterModels: vi.fn((models: readonly unknown[]) => models),
		filterAllModels: vi.fn((models: readonly unknown[]) => models),
		stream: vi.fn(() => "stream"),
		streamSimple: vi.fn(() => "stream-simple"),
		fetchDeferred: vi.fn(() => "deferred"),
		cancelDeferred: vi.fn(async () => undefined),
		generateImages: vi.fn(async () => ({ type: "image", value: [] })),
		classify: vi.fn(async () => ({ type: "classification", value: "ok" })),
	};
	return provider as any;
}

describe("full-provider quota wrapper", () => {
	it.each(["builtin", "models.json", "legacy extension", "native extension"])(
		"guards a complete %s provider before its transport runs",
		(origin) => {
			const provider = makeProvider();
			const model = { id: `${origin}-model`, provider: provider.id, api: "openai-completions" } as any;
			const evaluate = vi.fn(() => ({
				blocked: true as const,
				kind: "soft" as const,
				message: "quota soft cap exceeded",
			}));

			const wrapped = wrapProviderWithQuota(provider, evaluate);

			expect(() => wrapped.streamSimple(model, { messages: [] } as any, {
				sessionId: "tree-session",
			} as any)).toThrow("quota soft cap exceeded");
			expect(evaluate).toHaveBeenCalledWith(model, { sessionId: "tree-session" });
			expect(provider.streamSimple).not.toHaveBeenCalled();
		},
	);

	it("preserves every provider-owned field and operation", () => {
		const provider = makeProvider();
		const wrapped = wrapProviderWithQuota(provider, () => ({ blocked: false }));

		expect(wrapped).not.toBe(provider);
		expect(wrapped.id).toBe(provider.id);
		expect(wrapped.name).toBe(provider.name);
		expect(wrapped.baseUrl).toBe(provider.baseUrl);
		expect(wrapped.headers).toBe(provider.headers);
		expect(wrapped.auth).toBe(provider.auth);
		expect(wrapped.getModels).toBe(provider.getModels);
		expect(wrapped.getAllModels).toBe(provider.getAllModels);
		expect(wrapped.refreshModels).toBe(provider.refreshModels);
		expect(wrapped.filterModels).toBe(provider.filterModels);
		expect(wrapped.filterAllModels).toBe(provider.filterAllModels);
		expect(wrapped.stream).toBe(provider.stream);
		expect(wrapped.fetchDeferred).toBe(provider.fetchDeferred);
		expect(wrapped.cancelDeferred).toBe(provider.cancelDeferred);
		expect(wrapped.generateImages).toBe(provider.generateImages);
		expect(wrapped.classify).toBe(provider.classify);
	});

	it("does not stack quota guards when the same provider runtime is wrapped again", () => {
		const provider = makeProvider();
		const firstEvaluate = vi.fn(() => ({ blocked: false }));
		const secondEvaluate = vi.fn(() => ({ blocked: false }));
		const once = wrapProviderWithQuota(provider, firstEvaluate);
		const twice = wrapProviderWithQuota(once, secondEvaluate);

		const result = twice.streamSimple({ id: "model", provider: provider.id, api: "openai-completions" } as any, {
			messages: [],
		} as any);

		expect(result).toBe("stream-simple");
		expect(firstEvaluate.mock.calls.length + secondEvaluate.mock.calls.length).toBe(1);
		expect(provider.streamSimple).toHaveBeenCalledTimes(1);
	});
});
