import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { showNumberedSelect } from "./numbered-select.ts";

function makeCtx(overrides: Partial<{ custom: ReturnType<typeof vi.fn>; select: ReturnType<typeof vi.fn> }> = {}) {
	return {
		ui: {
			custom: overrides.custom ?? vi.fn(),
			select: overrides.select ?? vi.fn(),
		},
	} as unknown as ExtensionContext;
}

const options = [{ label: "alpha" }, { label: "beta", description: "second" }];

describe("showNumberedSelect", () => {
	it("shows the dialog as a full-width bottom-anchored overlay", async () => {
		const custom = vi.fn().mockResolvedValue({ index: 0, label: "alpha" });
		const ctx = makeCtx({ custom });

		await showNumberedSelect(ctx, "pick one", options);

		expect(custom).toHaveBeenCalledTimes(1);
		const [factory, opts] = custom.mock.calls[0]!;
		expect(typeof factory).toBe("function");
		expect(opts).toEqual({
			overlay: true,
			overlayOptions: {
				width: "100%",
				maxHeight: "80%",
				anchor: "bottom-center",
				margin: { bottom: 1 },
			},
		});
	});

	it("resolves the selection result from the custom component", async () => {
		const custom = vi.fn().mockResolvedValue({ index: 1, label: "beta", annotation: "note" });
		const ctx = makeCtx({ custom });
		const select = vi.fn();

		const result = await showNumberedSelect(ctx, "pick one", options);

		expect(result).toEqual({ index: 1, label: "beta", annotation: "note" });
		expect(select).not.toHaveBeenCalled();
	});

	it("treats null (user cancelled) as cancellation without falling back", async () => {
		const custom = vi.fn().mockResolvedValue(null);
		const ctx = makeCtx({ custom });
		const select = vi.fn();

		const result = await showNumberedSelect(ctx, "pick one", options);

		expect(result).toBeUndefined();
		expect(select).not.toHaveBeenCalled();
	});

	it("falls back to ctx.ui.select when custom components are unavailable", async () => {
		const custom = vi.fn().mockResolvedValue(undefined);
		const select = vi.fn().mockResolvedValue("2. beta — second");
		const ctx = makeCtx({ custom, select });

		const result = await showNumberedSelect(ctx, "pick one", options);

		expect(select).toHaveBeenCalledWith("pick one", ["1. alpha", "2. beta — second"]);
		expect(result).toEqual({ index: 1, label: "beta" });
	});

	it("returns undefined when the fallback select is dismissed", async () => {
		const custom = vi.fn().mockResolvedValue(undefined);
		const select = vi.fn().mockResolvedValue(undefined);
		const ctx = makeCtx({ custom, select });

		const result = await showNumberedSelect(ctx, "pick one", options);

		expect(result).toBeUndefined();
	});

	it("rejects empty and oversized option lists", async () => {
		const ctx = makeCtx();

		await expect(showNumberedSelect(ctx, "pick one", [])).rejects.toThrow(/must not be empty/);
		const tooMany = Array.from({ length: 10 }, (_, i) => ({ label: `o${i}` }));
		await expect(showNumberedSelect(ctx, "pick one", tooMany)).rejects.toThrow(/9 or fewer/);
	});
});
