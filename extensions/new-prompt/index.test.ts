import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", () => ({
	mkdir: vi.fn(),
	readFile: vi.fn(),
	writeFile: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
	withFileMutationQueue: vi.fn(async (_path: string, operation: () => Promise<void>) => operation()),
}));

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import newPrompt, { parsePromptName } from "./index.ts";

type RegisteredCommand = {
	description: string;
	handler: (args: string, ctx: any) => Promise<void>;
};

function missingFile(): Error & { code: string } {
	const error = Object.assign(new Error("missing"), { code: "ENOENT" });
	return error;
}

function registerExtension() {
	let command: RegisteredCommand | undefined;
	const pi = {
		registerCommand: vi.fn((_name: string, registered: RegisteredCommand) => {
			command = registered;
		}),
	};
	newPrompt(pi as never);
	if (!command) throw new Error("nprompt command was not registered");
	return { command, pi };
}

function commandContext(overrides: Record<string, unknown> = {}) {
	return {
		hasUI: true,
		cwd: "/workspace",
		ui: {
			editor: vi.fn(),
			notify: vi.fn(),
		},
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(readFile).mockRejectedValue(missingFile());
	vi.mocked(mkdir).mockResolvedValue(undefined);
	vi.mocked(writeFile).mockResolvedValue(undefined);
});

describe("prompt name parsing", () => {
	it("accepts a simple name and an optional markdown suffix", () => {
		expect(parsePromptName("review")).toBe("review");
		expect(parsePromptName("review.md")).toBe("review");
		expect(parsePromptName("release-notes_v2")).toBe("release-notes_v2");
	});

	it("rejects missing, compound, and path-like arguments", () => {
		expect(parsePromptName("   ")).toBeUndefined();
		expect(parsePromptName("review extra")).toBeUndefined();
		expect(parsePromptName("../review")).toBeUndefined();
		expect(parsePromptName(".hidden")).toBeUndefined();
	});
});

describe("/nprompt", () => {
	it("registers the project prompt-template command", () => {
		const { command, pi } = registerExtension();

		expect(pi.registerCommand).toHaveBeenCalledWith("nprompt", command);
		expect(command.description).toContain("project prompt template");
	});

	it("opens a new project template for editing", async () => {
		const { command } = registerExtension();
		const ctx = commandContext();
		ctx.ui.editor.mockResolvedValue("edited prompt");

		await command.handler("review", ctx);

		expect(ctx.ui.editor).toHaveBeenCalledWith(".pi/prompts/review.md", expect.any(String));
		expect(writeFile).toHaveBeenCalledWith("/workspace/.pi/prompts/review.md", "edited prompt", "utf-8");
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Saved .pi/prompts/review.md. Run /reload to use /review.",
			"info",
		);
	});


	it("prefills an existing project template instead of replacing it blindly", async () => {
		vi.mocked(readFile).mockResolvedValue("existing template");
		const { command } = registerExtension();
		const ctx = commandContext();
		ctx.ui.editor.mockResolvedValue("updated template");

		await command.handler("review.md", ctx);

		expect(ctx.ui.editor).toHaveBeenCalledWith(".pi/prompts/review.md", "existing template");
		expect(writeFile).toHaveBeenCalledWith("/workspace/.pi/prompts/review.md", "updated template", "utf-8");
	});

	it("does not write when the user cancels the editor", async () => {
		const { command } = registerExtension();
		const ctx = commandContext();
		ctx.ui.editor.mockResolvedValue(undefined);

		await command.handler("review", ctx);

		expect(writeFile).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith("Cancelled .pi/prompts/review.md", "info");
	});

	it("reports usage without opening the editor for invalid arguments", async () => {
		const { command } = registerExtension();
		const ctx = commandContext();

		await command.handler("../outside", ctx);

		expect(ctx.ui.editor).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith("Usage: /nprompt <name>", "warning");
	});

	it("requires a UI", async () => {
		const { command } = registerExtension();
		const ctx = commandContext({ hasUI: false });

		await expect(command.handler("review", ctx)).rejects.toThrow(
			"nprompt requires an interactive terminal.",
		);
		expect(readFile).not.toHaveBeenCalled();
	});

	it("serializes the file write through Pi's mutation queue", async () => {
		const { command } = registerExtension();
		const ctx = commandContext();
		ctx.ui.editor.mockResolvedValue("content");

		await command.handler("review", ctx);

		expect(withFileMutationQueue).toHaveBeenCalledWith(
			"/workspace/.pi/prompts/review.md",
			expect.any(Function),
		);
	});
});
