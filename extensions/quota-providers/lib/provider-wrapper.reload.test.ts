import { describe, expect, it, vi } from "vitest";
import {
	isQuotaWrappedProvider,
	quotaGuardChain,
	wrapProviderWithQuota,
} from "./provider-wrapper.js";

/** A provider whose members rely on `this`, as pi's composer builds them. */
function makeProvider() {
	return {
		id: "reload-provider",
		name: "Reload",
		getModels() { return [{ id: `${this.id}-model` }]; },
		stream: () => "native stream",
		streamSimple: vi.fn(() => "stream-simple"),
	} as never;
}

describe("wrapper state across a module reload", () => {
	it("recognizes and reuses a wrapper built by a fresh module instance", () => {
		const provider = makeProvider();
		const firstEvaluate = vi.fn(() => ({ blocked: false }));

		// First module instance wraps the provider.
		const wrapped = wrapProviderWithQuota(provider, firstEvaluate);
		expect(isQuotaWrappedProvider(wrapped)).toBe(true);

		// A /reload loads this module again. The new instance must recognize
		// the existing wrapper through the Symbol.for slot, adopt it, and keep
		// one guard instead of stacking a second.
		const secondEvaluate = vi.fn(() => ({ blocked: false }));
		const reused = wrapProviderWithQuota(wrapped, secondEvaluate);
		expect(reused).toBe(wrapped);
		expect(isQuotaWrappedProvider(reused)).toBe(true);
		expect(quotaGuardChain(wrapped)?.depth).toBe(0);

		reused.streamSimple({ id: "m" } as never, {} as never);
		expect(firstEvaluate.mock.calls.length + secondEvaluate.mock.calls.length).toBe(1);
		expect(provider.streamSimple).toHaveBeenCalledTimes(1);
	});
});
