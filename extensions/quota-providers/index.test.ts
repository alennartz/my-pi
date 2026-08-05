import { describe, expect, it, vi } from "vitest";
import { notifyQuotaBlocked } from "./index.js";

describe("notifyQuotaBlocked", () => {
	it("uses the extension UI even for headless child sessions", () => {
		const notify = vi.fn();
		notifyQuotaBlocked({ hasUI: false, ui: { notify } } as any, "quota soft cap exceeded");
		expect(notify).toHaveBeenCalledWith("quota soft cap exceeded", "error");
	});
});
