import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const agentDirState = vi.hoisted(() => ({ dir: "" }));

vi.mock("@earendil-works/pi-coding-agent", () => ({
	getAgentDir: () => agentDirState.dir,
}));

import personaWorkspaces from "./index.ts";
import { markSubagentChildSession } from "../subagents/child-session-marker.ts";
import { resolveChildToolPolicy } from "../subagents/child-tool-policy.ts";

type Handler = (event: unknown, ctx: any) => unknown;

const WORKSPACE_FRONT_MATTER = ["kind: persona", "name: workspace-lead"];
const WORKSPACE_BODY = "You are the workspace lead.";

function workspaceWith(frontMatter: string[], body: string): string {
	const dir = mkdtempSync(join(tmpdir(), "persona-ws-"));
	writeFileSync(join(dir, "AGENTS.md"), `---\n${frontMatter.join("\n")}\n---\n\n${body}\n`);
	return dir;
}

function personaWorkspace(): string {
	return workspaceWith(WORKSPACE_FRONT_MATTER, WORKSPACE_BODY);
}

function plainDirectory(): string {
	const dir = mkdtempSync(join(tmpdir(), "persona-plain-"));
	writeFileSync(join(dir, "AGENTS.md"), "# Project context only\n");
	return dir;
}

function setup() {
	const handlers = new Map<string, Handler>();
	const setModel = vi.fn(async () => true);
	const setActiveTools = vi.fn();
	const setThinkingLevel = vi.fn();
	const pi = {
		on: (event: string, handler: Handler) => {
			handlers.set(event, handler);
		},
		registerMessageRenderer: vi.fn(),
		setModel,
		setActiveTools,
		setThinkingLevel,
	};
	personaWorkspaces(pi as any);

	return {
		setModel,
		setActiveTools,
		setThinkingLevel,
		sessionStart: (event: unknown, ctx: unknown) => handlers.get("session_start")!(event, ctx),
		beforeAgentStart: (event: unknown, ctx: unknown) =>
			handlers.get("before_agent_start")!(event, ctx),
	};
}

function ctxFor(
	cwd: string,
	options?: { sessionManager?: object; models?: unknown[] },
): Record<string, unknown> {
	return {
		cwd,
		sessionManager: options?.sessionManager ?? { getEntries: () => [] },
		modelRegistry: { getAvailable: () => options?.models ?? [] },
		isProjectTrusted: () => true,
		ui: { notify: vi.fn() },
	};
}

/** A fake child session manager whose transcript accumulates ingested notices. */
function transcriptSessionManager() {
	const entries: Array<Record<string, unknown>> = [];
	return {
		entries,
		sessionManager: {
			getEntries: () => entries,
		},
		ingest(message: unknown) {
			entries.push({ type: "custom_message", ...(message as object) });
		},
	};
}

function agentStartEvent(options?: {
	customPrompt?: string;
	contextFiles?: Array<{ path: string; content: string }>;
	skills?: Array<{ name: string }>;
}) {
	return {
		type: "before_agent_start",
		prompt: "do the thing",
		systemPrompt: "generic preamble",
		systemPromptOptions: {
			customPrompt: options?.customPrompt,
			contextFiles: options?.contextFiles ?? [{ path: "/elsewhere/NOTES.md", content: "notes" }],
			skills: options?.skills ?? [{ name: "alpha" }, { name: "beta" }],
		},
	};
}

describe("prompt binding", () => {
	it("binds the workspace persona body as the system prompt preamble", async () => {
		const s = setup();
		const cwd = personaWorkspace();
		await s.sessionStart({ type: "session_start", reason: "startup" }, ctxFor(cwd));

		const event = agentStartEvent();
		await s.beforeAgentStart(event, ctxFor(cwd));

		expect(event.systemPromptOptions.customPrompt).toContain(WORKSPACE_BODY);
	});

	it("drops the workspace AGENTS.md from context files so pi cannot append it twice", async () => {
		const s = setup();
		const cwd = personaWorkspace();
		const sourcePath = join(cwd, "AGENTS.md");
		await s.sessionStart({ type: "session_start", reason: "startup" }, ctxFor(cwd));

		const event = agentStartEvent({
			contextFiles: [
				{ path: sourcePath, content: "declaration" },
				{ path: "/elsewhere/NOTES.md", content: "notes" },
			],
		});
		await s.beforeAgentStart(event, ctxFor(cwd));

		expect(event.systemPromptOptions.contextFiles.map((file: { path: string }) => file.path)).toEqual([
			"/elsewhere/NOTES.md",
		]);
	});

	it("takes effect at the next run when the workspace declaration changes mid-session", async () => {
		const s = setup();
		const cwd = personaWorkspace();
		await s.sessionStart({ type: "session_start", reason: "startup" }, ctxFor(cwd));

		const first = agentStartEvent();
		await s.beforeAgentStart(first, ctxFor(cwd));
		writeFileSync(join(cwd, "AGENTS.md"), `---\nkind: persona\nname: workspace-lead\n---\n\nSecond body.\n`);
		const second = agentStartEvent();
		await s.beforeAgentStart(second, ctxFor(cwd));

		expect(first.systemPromptOptions.customPrompt).toContain(WORKSPACE_BODY);
		expect(second.systemPromptOptions.customPrompt).toContain("Second body.");
	});

	it("yields to an explicit --system-prompt and touches nothing", async () => {
		const s = setup();
		const cwd = personaWorkspace();
		await s.sessionStart({ type: "session_start", reason: "startup" }, ctxFor(cwd));

		const event = agentStartEvent({ customPrompt: "The user's own prompt." });
		const result = await s.beforeAgentStart(event, ctxFor(cwd));

		expect(event.systemPromptOptions.customPrompt).toBe("The user's own prompt.");
		expect(event.systemPromptOptions.contextFiles).toEqual([{ path: "/elsewhere/NOTES.md", content: "notes" }]);
		expect(result).toBeUndefined();
	});

	it("mutates nothing in a plain session", async () => {
		const s = setup();
		const cwd = plainDirectory();
		await s.sessionStart({ type: "session_start", reason: "startup" }, ctxFor(cwd));

		const event = agentStartEvent();
		const result = await s.beforeAgentStart(event, ctxFor(cwd));

		expect(event.systemPromptOptions.customPrompt).toBeUndefined();
		expect(event.systemPromptOptions.contextFiles).toEqual([{ path: "/elsewhere/NOTES.md", content: "notes" }]);
		expect(event.systemPromptOptions.skills.map((skill: { name: string }) => skill.name)).toEqual([
			"alpha",
			"beta",
		]);
		expect(result).toBeUndefined();
	});

	it("binds a spawned agent's definition in a subagent child", async () => {
		const s = setup();
		const cwd = plainDirectory();
		const { sessionManager } = transcriptSessionManager();
		markSubagentChildSession(sessionManager, { name: "scout", body: "Spawned scout body." });

		const event = agentStartEvent();
		await s.beforeAgentStart(event, ctxFor(cwd, { sessionManager }));

		expect(event.systemPromptOptions.customPrompt).toContain("Spawned scout body.");
	});

	it("lets the workspace persona win over a spawned agent definition, visibly", async () => {
		const s = setup();
		const cwd = personaWorkspace();
		const { sessionManager } = transcriptSessionManager();
		markSubagentChildSession(sessionManager, { name: "scout", body: "Spawned scout body." });

		const event = agentStartEvent();
		const result = (await s.beforeAgentStart(event, ctxFor(cwd, { sessionManager }))) as
			| { message?: { content?: unknown } }
			| undefined;

		expect(event.systemPromptOptions.customPrompt).toContain(WORKSPACE_BODY);
		expect(event.systemPromptOptions.customPrompt).not.toContain("Spawned scout body.");
		expect(String(result?.message?.content)).toContain("workspace-lead");
		expect(String(result?.message?.content)).toContain("scout");
	});
});

describe("takeover notices", () => {
	it("announces the takeover with a persona-notice message naming the persona and its source file", async () => {
		const s = setup();
		const cwd = personaWorkspace();
		const sourcePath = join(cwd, "AGENTS.md");
		const transcript = transcriptSessionManager();
		await s.sessionStart({ type: "session_start", reason: "startup" }, ctxFor(cwd, { sessionManager: transcript.sessionManager }));

		const event = agentStartEvent();
		const result = (await s.beforeAgentStart(event, ctxFor(cwd, { sessionManager: transcript.sessionManager }))) as
			| { message?: { customType?: string; content?: unknown; display?: boolean } }
			| undefined;

		expect(result?.message?.customType).toBe("persona-notice");
		expect(result?.message?.display).toBe(true);
		expect(String(result?.message?.content)).toContain("workspace-lead");
		expect(String(result?.message?.content)).toContain(sourcePath);
	});

	it("emits the boot notice at most once per session instance", async () => {
		const s = setup();
		const cwd = personaWorkspace();
		const transcript = transcriptSessionManager();
		const ctx = ctxFor(cwd, { sessionManager: transcript.sessionManager });
		await s.sessionStart({ type: "session_start", reason: "startup" }, ctx);

		const first = (await s.beforeAgentStart(agentStartEvent(), ctx)) as
			| { message?: unknown }
			| undefined;
		if (first?.message) transcript.ingest(first.message);
		const second = (await s.beforeAgentStart(agentStartEvent(), ctx)) as
			| { message?: unknown }
			| undefined;

		expect(first?.message).toBeDefined();
		expect(second?.message).toBeUndefined();
	});

	it("binds and announces on genuine fresh starts (startup, new)", async () => {
		for (const reason of ["startup", "new"]) {
			const s = setup();
			const cwd = personaWorkspace();
			const transcript = transcriptSessionManager();
			const ctx = ctxFor(cwd, { sessionManager: transcript.sessionManager });
			await s.sessionStart({ type: "session_start", reason }, ctx);

			const result = (await s.beforeAgentStart(agentStartEvent(), ctx)) as
				| { message?: { customType?: string } }
				| undefined;

			expect(result?.message?.customType, `reason=${reason}`).toBe("persona-notice");
		}
	});

	it("does not re-fire notices on a resumed session whose transcript already has one", async () => {
		const s = setup();
		const cwd = personaWorkspace();
		const transcript = transcriptSessionManager();
		transcript.ingest({ customType: "persona-notice", content: "earlier boot notice" });
		const ctx = ctxFor(cwd, { sessionManager: transcript.sessionManager });
		await s.sessionStart({ type: "session_start", reason: "resume" }, ctx);

		const event = agentStartEvent();
		const result = await s.beforeAgentStart(event, ctx);

		expect(result).toBeUndefined();
		expect(event.systemPromptOptions.customPrompt).toContain(WORKSPACE_BODY);
	});
});

describe("skills filter", () => {
	it("declares only the listed skills to the model", async () => {
		const s = setup();
		const cwd = workspaceWith(
			["kind: persona", "name: workspace-lead", "skills: alpha"],
			WORKSPACE_BODY,
		);
		await s.sessionStart({ type: "session_start", reason: "startup" }, ctxFor(cwd));

		const event = agentStartEvent();
		await s.beforeAgentStart(event, ctxFor(cwd));

		expect(event.systemPromptOptions.skills.map((skill: { name: string }) => skill.name)).toEqual([
			"alpha",
		]);
	});

	it("leaves the skill list untouched when the declaration lists none", async () => {
		const s = setup();
		const cwd = personaWorkspace();
		await s.sessionStart({ type: "session_start", reason: "startup" }, ctxFor(cwd));

		const event = agentStartEvent();
		await s.beforeAgentStart(event, ctxFor(cwd));

		expect(event.systemPromptOptions.skills.map((skill: { name: string }) => skill.name)).toEqual([
			"alpha",
			"beta",
		]);
	});
});

describe("front-matter binding at session start", () => {
	const AVAILABLE_MODELS = [{ id: "work-model", provider: "prov" }];

	it("binds the declared model when the session binds (startup, new, fork)", async () => {
		for (const reason of ["startup", "new", "fork"]) {
			const s = setup();
			const cwd = workspaceWith(
				["kind: persona", "name: workspace-lead", "model: work-model"],
				WORKSPACE_BODY,
			);

			await s.sessionStart({ type: "session_start", reason }, ctxFor(cwd, { models: AVAILABLE_MODELS }));

			expect(s.setModel, `reason=${reason}`).toHaveBeenCalledTimes(1);
			expect(s.setModel, `reason=${reason}`).toHaveBeenCalledWith(
				expect.objectContaining({ id: "work-model" }),
			);
		}
	});

	it("applies the thinking level carried by a :<level> suffix", async () => {
		const s = setup();
		const cwd = workspaceWith(
			["kind: persona", "name: workspace-lead", "model: work-model:high"],
			WORKSPACE_BODY,
		);

		await s.sessionStart({ type: "session_start", reason: "startup" }, ctxFor(cwd, { models: AVAILABLE_MODELS }));

		expect(s.setModel).toHaveBeenCalledWith(expect.objectContaining({ id: "work-model" }));
		expect(s.setThinkingLevel).toHaveBeenCalledWith("high");
	});

	it("resolves a tier name through the model-tiers config", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "persona-agentdir-"));
		writeFileSync(join(agentDir, "model-tiers.json"), JSON.stringify({ smart: "work-model" }));
		agentDirState.dir = agentDir;
		const s = setup();
		const cwd = workspaceWith(
			["kind: persona", "name: workspace-lead", "model: smart"],
			WORKSPACE_BODY,
		);

		await s.sessionStart({ type: "session_start", reason: "startup" }, ctxFor(cwd, { models: AVAILABLE_MODELS }));

		expect(s.setModel).toHaveBeenCalledWith(expect.objectContaining({ id: "work-model" }));
	});

	it("binds the declared tools through the child tool policy normalization", async () => {
		const s = setup();
		const cwd = workspaceWith(
			["kind: persona", "name: workspace-lead", "tools: read, bash"],
			WORKSPACE_BODY,
		);

		await s.sessionStart({ type: "session_start", reason: "startup" }, ctxFor(cwd, { models: AVAILABLE_MODELS }));

		expect(s.setActiveTools).toHaveBeenCalledWith(
			resolveChildToolPolicy({ kind: "persona", tools: ["read", "bash"] }).allowedTools,
		);
	});

	it("rebinds model, thinking, and tools at every continuation and stays silent (resume, reload, CLI resume)", async () => {
		for (const [label, reason] of [
			["in-process resume", "resume"],
			["reload", "reload"],
			["CLI resume (startup over a lived-in transcript)", "startup"],
		] as const) {
			const s = setup();
			const cwd = workspaceWith(
				["kind: persona", "name: workspace-lead", "model: work-model:high", "tools: read, bash"],
				WORKSPACE_BODY,
			);
			const transcript = transcriptSessionManager();
			transcript.entries.push({ type: "message", message: { role: "user", content: "earlier turn" } });
			const ctx = ctxFor(cwd, { sessionManager: transcript.sessionManager, models: AVAILABLE_MODELS });

			await s.sessionStart({ type: "session_start", reason }, ctx);
			const result = await s.beforeAgentStart(agentStartEvent(), ctx);

			expect(s.setModel, label).toHaveBeenCalledWith(expect.objectContaining({ id: "work-model" }));
			expect(s.setThinkingLevel, label).toHaveBeenCalledWith("high");
			expect(s.setActiveTools, label).toHaveBeenCalledWith(
				resolveChildToolPolicy({ kind: "persona", tools: ["read", "bash"] }).allowedTools,
			);
			expect(result, label).toBeUndefined();
		}
	});

	it("carries the persona over silently at fork when the parent's transcript carries the notice", async () => {
		const s = setup();
		const cwd = workspaceWith(
			["kind: persona", "name: workspace-lead", "model: work-model", "tools: read, bash"],
			WORKSPACE_BODY,
		);
		const transcript = transcriptSessionManager();
		transcript.ingest({ customType: "persona-notice", content: "Persona takeover: earlier boot notice" });
		const ctx = ctxFor(cwd, { sessionManager: transcript.sessionManager, models: AVAILABLE_MODELS });

		await s.sessionStart({ type: "session_start", reason: "fork" }, ctx);
		const result = await s.beforeAgentStart(agentStartEvent(), ctx);

		expect(s.setModel).toHaveBeenCalledWith(expect.objectContaining({ id: "work-model" }));
		expect(s.setActiveTools).toHaveBeenCalledWith(
			resolveChildToolPolicy({ kind: "persona", tools: ["read", "bash"] }).allowedTools,
		);
		expect(result).toBeUndefined();
	});

	it("announces at fork when the persona is new to the lineage", async () => {
		const s = setup();
		const cwd = personaWorkspace();
		const transcript = transcriptSessionManager();
		transcript.entries.push({ type: "message", message: { role: "user", content: "earlier turn" } });
		const ctx = ctxFor(cwd, { sessionManager: transcript.sessionManager });

		await s.sessionStart({ type: "session_start", reason: "fork" }, ctx);
		const result = (await s.beforeAgentStart(agentStartEvent(), ctx)) as
			| { message?: { customType?: string } }
			| undefined;

		expect(result?.message?.customType).toBe("persona-notice");
	});

	it("binds nothing when the front matter declares neither model nor tools", async () => {
		const s = setup();
		const cwd = personaWorkspace();

		await s.sessionStart({ type: "session_start", reason: "startup" }, ctxFor(cwd, { models: AVAILABLE_MODELS }));

		expect(s.setModel).not.toHaveBeenCalled();
		expect(s.setActiveTools).not.toHaveBeenCalled();
	});
});
