import { describe, expect, it, vi } from "vitest";
import { wrapProviderWithQuota } from "./provider-wrapper.js";

function makeProvider() {
	return {
		id: "provider",
		name: "Provider",
		baseUrl: "https://provider.example",
		auth: { resolve: async () => ({ key: "credential" }) },
		getModels() { return [{ id: this.id + "-model" }]; },
		getAllModels() { return this.getModels(); },
		async refreshModels() { return "refreshed"; },
		filterModels(models: unknown[]) { return models.slice(0, 1); },
		stream: () => "stream",
		streamSimple: vi.fn(() => "stream-simple"),
		fetchDeferred: () => "deferred",
		cancelDeferred: async () => "cancelled",
		generateImages: async () => ({ type: "image", value: [] }),
		classify: async () => ({ type: "classification", value: "ok" }),
	} as any;
}

const model = { id: "model", provider: "provider", api: "openai-completions" } as any;
const context = { messages: [] } as any;

describe("full-provider quota wrapper", () => {
	it("blocks before the provider transport and passes the request identity to the gate", () => {
		const provider = makeProvider();
		const evaluate = vi.fn(() => ({ blocked: true as const, kind: "soft" as const, message: "quota soft cap exceeded" }));
		const wrapped = wrapProviderWithQuota(provider, evaluate);

		expect(() => wrapped.streamSimple(model, context, { sessionId: "tree-session" } as any)).toThrow("quota soft cap exceeded");
		expect(evaluate).toHaveBeenCalledWith(model, { sessionId: "tree-session" });
		expect(provider.streamSimple).not.toHaveBeenCalled();
	});

	it("retains provider capabilities and delegates allowed streams", async () => {
		const wrapped = wrapProviderWithQuota(makeProvider(), () => ({ blocked: false }));
		expect(wrapped.id).toBe("provider");
		expect(wrapped.name).toBe("Provider");
		expect(wrapped.baseUrl).toBe("https://provider.example");
		expect(await wrapped.auth.resolve()).toEqual({ key: "credential" });
		expect(wrapped.getModels()).toEqual([{ id: "provider-model" }]);
		expect(wrapped.getAllModels()).toEqual([{ id: "provider-model" }]);
		expect(await wrapped.refreshModels()).toBe("refreshed");
		expect(wrapped.filterModels([1, 2])).toEqual([1]);
		expect(wrapped.stream(model, context)).toBe("stream");
		expect(wrapped.streamSimple(model, context)).toBe("stream-simple");
		expect(wrapped.fetchDeferred()).toBe("deferred");
		expect(await wrapped.cancelDeferred()).toBe("cancelled");
		expect(await wrapped.generateImages()).toEqual({ type: "image", value: [] });
		expect(await wrapped.classify()).toEqual({ type: "classification", value: "ok" });
	});

	it("does not stack quota guards when the same provider runtime is wrapped again", () => {
		const provider = makeProvider();
		const firstEvaluate = vi.fn(() => ({ blocked: false }));
		const secondEvaluate = vi.fn(() => ({ blocked: false }));
		const twice = wrapProviderWithQuota(wrapProviderWithQuota(provider, firstEvaluate), secondEvaluate);
		expect(twice.streamSimple(model, context)).toBe("stream-simple");
		expect(firstEvaluate.mock.calls.length + secondEvaluate.mock.calls.length).toBe(1);
		expect(provider.streamSimple).toHaveBeenCalledTimes(1);
	});
});
