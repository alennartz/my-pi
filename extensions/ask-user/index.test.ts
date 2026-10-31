import { describe, expect, it, vi } from "vitest";
import askUser from "./index.ts";

describe("ask_user tool", () => {
	it("marks itself model-only and refuses execution without UI", async () => {
		const registerTool = vi.fn();
		askUser({ registerTool } as any);

		const tool = registerTool.mock.calls[0]![0];
		expect(tool.exposure).toBe("model-only");
		await expect(tool.execute(
			"call-1",
			{ title: "Choose", options: [{ label: "Continue" }] },
			undefined,
			undefined,
			{ hasUI: false },
		)).rejects.toThrow("ask_user requires an interactive terminal.");
	});
});
