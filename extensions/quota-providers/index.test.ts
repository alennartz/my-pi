import { describe, expect, it, vi } from "vitest";
import { notifyQuotaBlocked, refreshStatusline } from "./index.js";

describe("notifyQuotaBlocked", () => {
	it("uses the extension UI even for headless child sessions", () => {
		const notify = vi.fn();
		notifyQuotaBlocked({ hasUI: false, ui: { notify } } as any, "quota soft cap exceeded");
		expect(notify).toHaveBeenCalledWith("quota soft cap exceeded", "error");
	});
});

describe("refreshStatusline", () => {
	it("does not throw when an embedding host supplies a partial UI context", () => {
		expect(() => refreshStatusline(undefined, { hasUI: true, ui: {} } as any)).not.toThrow();
	});
});
