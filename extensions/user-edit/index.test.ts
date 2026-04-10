import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock("fs/promises", () => ({
	readFile: vi.fn(),
	writeFile: vi.fn(),
	mkdir: vi.fn(),
}));

vi.mock("@mariozechner/pi-coding-agent", () => ({
	withFileMutationQueue: vi.fn((_path: string, fn: () => Promise<any>) => fn()),
}));

import { readFile, writeFile, mkdir } from "fs/promises";
import { withFileMutationQueue } from "@mariozechner/pi-coding-agent";

// ─── Helpers ─────────────────────────────────────────────────────────────────

type ToolDef = {
	name: string;
	execute: (toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) => Promise<any>;
};

let tool: ToolDef;

function mockCtx(overrides: Record<string, any> = {}) {
	return {
		hasUI: true,
		cwd: "/workspace",
		ui: {
			editor: vi.fn(),
		},
		...overrides,
	};
}

function text(result: { content: { type: string; text: string }[] }): string {
	return result.content[0].text;
}

beforeEach(async () => {
	vi.clearAllMocks();

	// Capture the registered tool
	const registerTool = vi.fn();
	const mod = await import("./index.ts");
	mod.default({ registerTool } as any);
	tool = registerTool.mock.calls[0][0];
});

// ─── No UI ───────────────────────────────────────────────────────────────────

describe("user_edit — no UI", () => {
	it("throws when hasUI is false", async () => {
		const ctx = mockCtx({ hasUI: false });
		await expect(tool.execute("1", { path: "foo.ts" }, undefined, undefined, ctx)).rejects.toThrow(
			"user_edit requires an interactive terminal.",
		);
	});
});

// ─── Path handling ───────────────────────────────────────────────────────────

describe("user_edit — path handling", () => {
	it("strips leading @ from path", async () => {
		vi.mocked(readFile).mockResolvedValue("content");
		const ctx = mockCtx();
		ctx.ui.editor.mockResolvedValue(undefined);

		await tool.execute("1", { path: "@src/file.ts" }, undefined, undefined, ctx);

		// Editor title should be the stripped path
		expect(ctx.ui.editor).toHaveBeenCalledWith("src/file.ts", "content");
		// readFile should use the resolved absolute path
		expect(readFile).toHaveBeenCalledWith("/workspace/src/file.ts", "utf-8");
	});

	it("resolves path relative to ctx.cwd", async () => {
		vi.mocked(readFile).mockResolvedValue("hello");
		const ctx = mockCtx({ cwd: "/project" });
		ctx.ui.editor.mockResolvedValue(undefined);

		await tool.execute("1", { path: "lib/util.ts" }, undefined, undefined, ctx);

		expect(readFile).toHaveBeenCalledWith("/project/lib/util.ts", "utf-8");
	});
});

// ─── Existing file ───────────────────────────────────────────────────────────

describe("user_edit — existing file", () => {
	it("passes file content as editor prefill", async () => {
		vi.mocked(readFile).mockResolvedValue("existing content");
		const ctx = mockCtx();
		ctx.ui.editor.mockResolvedValue("edited content");
		vi.mocked(writeFile).mockResolvedValue(undefined);
		vi.mocked(mkdir).mockResolvedValue(undefined);

		await tool.execute("1", { path: "file.txt" }, undefined, undefined, ctx);

		expect(ctx.ui.editor).toHaveBeenCalledWith("file.txt", "existing content");
	});
});

// ─── New file ────────────────────────────────────────────────────────────────

describe("user_edit — new file", () => {
	it("opens editor with empty string for non-existent file", async () => {
		const err: any = new Error("ENOENT");
		err.code = "ENOENT";
		vi.mocked(readFile).mockRejectedValue(err);
		const ctx = mockCtx();
		ctx.ui.editor.mockResolvedValue("new content");
		vi.mocked(writeFile).mockResolvedValue(undefined);
		vi.mocked(mkdir).mockResolvedValue(undefined);

		await tool.execute("1", { path: "new-file.ts" }, undefined, undefined, ctx);

		expect(ctx.ui.editor).toHaveBeenCalledWith("new-file.ts", "");
	});
});

// ─── Cancel ──────────────────────────────────────────────────────────────────

describe("user_edit — cancel", () => {
	it("returns cancel message when editor returns undefined", async () => {
		vi.mocked(readFile).mockResolvedValue("content");
		const ctx = mockCtx();
		ctx.ui.editor.mockResolvedValue(undefined);

		const result = await tool.execute("1", { path: "file.ts" }, undefined, undefined, ctx);

		expect(text(result)).toBe("User cancelled editing file.ts");
		expect(writeFile).not.toHaveBeenCalled();
	});
});

// ─── Save ────────────────────────────────────────────────────────────────────

describe("user_edit — save", () => {
	it("writes edited content and returns save message", async () => {
		vi.mocked(readFile).mockResolvedValue("original");
		const ctx = mockCtx();
		ctx.ui.editor.mockResolvedValue("modified");
		vi.mocked(writeFile).mockResolvedValue(undefined);
		vi.mocked(mkdir).mockResolvedValue(undefined);

		const result = await tool.execute("1", { path: "file.ts" }, undefined, undefined, ctx);

		expect(text(result)).toBe("User saved file.ts");
		expect(writeFile).toHaveBeenCalledWith("/workspace/file.ts", "modified", "utf-8");
	});

	it("creates parent directories before writing", async () => {
		vi.mocked(readFile).mockResolvedValue("");
		const ctx = mockCtx();
		ctx.ui.editor.mockResolvedValue("content");
		vi.mocked(writeFile).mockResolvedValue(undefined);
		vi.mocked(mkdir).mockResolvedValue(undefined);

		await tool.execute("1", { path: "deep/nested/file.ts" }, undefined, undefined, ctx);

		expect(mkdir).toHaveBeenCalledWith("/workspace/deep/nested", { recursive: true });
	});

	it("uses withFileMutationQueue for the write", async () => {
		vi.mocked(readFile).mockResolvedValue("content");
		const ctx = mockCtx();
		ctx.ui.editor.mockResolvedValue("edited");
		vi.mocked(writeFile).mockResolvedValue(undefined);
		vi.mocked(mkdir).mockResolvedValue(undefined);

		await tool.execute("1", { path: "file.ts" }, undefined, undefined, ctx);

		expect(withFileMutationQueue).toHaveBeenCalledWith("/workspace/file.ts", expect.any(Function));
	});
});

// ─── Errors ──────────────────────────────────────────────────────────────────

describe("user_edit — errors", () => {
	it("throws on non-ENOENT read errors", async () => {
		const err: any = new Error("Permission denied");
		err.code = "EACCES";
		vi.mocked(readFile).mockRejectedValue(err);
		const ctx = mockCtx();

		await expect(tool.execute("1", { path: "restricted.ts" }, undefined, undefined, ctx)).rejects.toThrow(
			"Permission denied",
		);
	});
});
