import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const agentDirState = vi.hoisted(() => ({ dir: "" }));

vi.mock("@earendil-works/pi-coding-agent", () => ({
	getAgentDir: () => agentDirState.dir,
}));

import autoflowAutostart from "./index.ts";
import { markSubagentChildSession } from "../subagents/child-session-marker.ts";

type Handler = (event: unknown, ctx: any) => unknown;

function setup(agentDir: string) {
	agentDirState.dir = agentDir;
	const handlers = new Map<string, Handler>();
	const pi = {
		on: (event: string, handler: Handler) => handlers.set(event, handler),
	};
	autoflowAutostart(pi as any);

	const notify = vi.fn();
	const ctx = {
		sessionManager: { getEntries: () => [] },
		ui: { notify },
	};
	return {
		notify,
		sessionStart: (event: unknown, startCtx: any = ctx) => handlers.get("session_start")!(event, startCtx),
		input: (event: unknown) => handlers.get("input")!(event, ctx),
		ctx,
	};
}

function agentDirWithConfig(config: unknown): string {
	const dir = mkdtempSync(join(tmpdir(), "autoflow-autostart-"));
	if (config !== undefined) writeFileSync(join(dir, "autoflow.json"), JSON.stringify(config));
	return dir;
}

describe("autoflow autostart", () => {
	it("rewrites the first message of a new session into an autoflow invocation", async () => {
		const s = setup(agentDirWithConfig({ autoStart: true }));
		await s.sessionStart({ type: "session_start", reason: "startup" });

		const result = await s.input({ type: "input", text: "build me a thing", source: "interactive" });

		expect(result).toEqual({ action: "transform", text: "/skill:autoflow build me a thing", images: undefined });
	});

	it("passes attached images through the rewrite", async () => {
		const s = setup(agentDirWithConfig({ autoStart: true }));
		await s.sessionStart({ type: "session_start", reason: "startup" });
		const images = [{ type: "image", data: "abc", mimeType: "image/png" }];

		const result = await s.input({ type: "input", text: "what is this?", images, source: "interactive" });

		expect(result).toEqual({ action: "transform", text: "/skill:autoflow what is this?", images });
	});

	it("fires only once per session", async () => {
		const s = setup(agentDirWithConfig({ autoStart: true }));
		await s.sessionStart({ type: "session_start", reason: "startup" });

		await s.input({ type: "input", text: "first", source: "interactive" });
		const second = await s.input({ type: "input", text: "second", source: "interactive" });

		expect(second).toEqual({ action: "continue" });
	});

	it("honors a configured invocation command", async () => {
		const s = setup(agentDirWithConfig({ autoStart: true, command: "/flow" }));
		await s.sessionStart({ type: "session_start", reason: "startup" });

		const result = await s.input({ type: "input", text: "go", source: "interactive" });

		expect(result).toEqual({ action: "transform", text: "/flow go", images: undefined });
	});

	it("does nothing when the opt-in is absent", async () => {
		const s = setup(agentDirWithConfig(undefined));
		await s.sessionStart({ type: "session_start", reason: "startup" });

		const result = await s.input({ type: "input", text: "build me a thing", source: "interactive" });

		expect(result).toEqual({ action: "continue" });
	});

	it("does nothing for a resumed session", async () => {
		const s = setup(agentDirWithConfig({ autoStart: true }));
		const ctx = { sessionManager: { getEntries: () => [{ type: "message" }] }, ui: { notify: s.notify } };
		await s.sessionStart({ type: "session_start", reason: "resume" }, ctx);

		const result = await s.input({ type: "input", text: "build me a thing", source: "interactive" });

		expect(result).toEqual({ action: "continue" });
	});

	it("still arms when only non-message entries were appended by other extensions", async () => {
		const s = setup(agentDirWithConfig({ autoStart: true }));
		const ctx = {
			sessionManager: { getEntries: () => [{ type: "custom", customType: "session-idle" }] },
			ui: { notify: s.notify },
		};
		await s.sessionStart({ type: "session_start", reason: "startup" }, ctx);

		const result = await s.input({ type: "input", text: "build me a thing", source: "interactive" });

		expect(result).toEqual({
			action: "transform",
			text: "/skill:autoflow build me a thing",
			images: undefined,
		});
	});

	it("does nothing in a subagent child session", async () => {
		const s = setup(agentDirWithConfig({ autoStart: true }));
		const childSessionManager = { getEntries: () => [] };
		markSubagentChildSession(childSessionManager);
		await s.sessionStart({ type: "session_start", reason: "startup" }, {
			sessionManager: childSessionManager,
			ui: { notify: s.notify },
		});

		const result = await s.input({ type: "input", text: "do the task", source: "rpc" });

		expect(result).toEqual({ action: "continue" });
	});

	it("lets the user invoke autoflow themselves as the first message", async () => {
		const s = setup(agentDirWithConfig({ autoStart: true }));
		await s.sessionStart({ type: "session_start", reason: "startup" });

		const result = await s.input({ type: "input", text: "/skill:autoflow build it", source: "interactive" });

		expect(result).toEqual({ action: "continue" });
		const next = await s.input({ type: "input", text: "and also this", source: "interactive" });
		expect(next).toEqual({ action: "continue" });
	});

	it("notifies once about a malformed config", async () => {
		const dir = mkdtempSync(join(tmpdir(), "autoflow-autostart-"));
		writeFileSync(join(dir, "autoflow.json"), "{nope");
		const s = setup(dir);

		await s.sessionStart({ type: "session_start", reason: "startup" });

		expect(s.notify).toHaveBeenCalledTimes(1);
		expect(s.notify.mock.calls[0][1]).toBe("warning");
	});
});
