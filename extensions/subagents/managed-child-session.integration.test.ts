import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { childAgentPath, formatAgentPath, type AgentPath } from "./agent-path.js";
import { createManagedChildSession, type ChildSessionConfig } from "./managed-child-session.js";
import type { MessagePort } from "./message-router.js";

const registry = {} as ChildSessionConfig["scope"]["registry"];

let tmpRoot: string | undefined;

afterEach(() => {
	if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
	tmpRoot = undefined;
});

function childConfig(sessionFile: string, sessionDir: string, agentPath: AgentPath): ChildSessionConfig {
	return {
		path: agentPath,
		target: { kind: "resume", sessionFile, sessionDir },
		scope: {
			kind: "child",
			registry,
			path: agentPath,
			identity: {
				id: "legacy-worker",
				task: "resume the prior task",
				channels: ["parent"],
			},
			uplink: {} as MessagePort,
		},
		toolPolicy: { allowedTools: undefined, excludeTools: ["ask_user"] },
		skillPaths: [],
		appendSystemPrompt: [],
	};
}

describe("ManagedChildSession legacy RPC-session compatibility", () => {
	it("opens an existing persisted JSONL directly without migrating its identity or cwd", async () => {
		tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-legacy-session-"));
		const cwd = path.join(tmpRoot, "legacy-project");
		const sessionDir = path.join(tmpRoot, "parent.subagents", "sessions");
		const agentDir = path.join(tmpRoot, "agent");
		fs.mkdirSync(cwd, { recursive: true });
		fs.mkdirSync(agentDir, { recursive: true });

		// RPC children wrote ordinary pi JSONL session files. Seed one through the
		// real SDK, then require the managed SDK path to reopen that exact file.
		const legacy = SessionManager.create(cwd, sessionDir, { id: "11111111-1111-4111-8111-111111111111" });
		legacy.appendSessionInfo("old-rpc-child-name");
		// Materialize the ordinary JSONL file. Pi intentionally defers flushing a
		// session that has no assistant message yet; a real RPC child always emits
		// at least one assistant turn before its persisted session is reopened.
		legacy.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "legacy child" }],
			api: "openai-completions",
			provider: "legacy-provider",
			model: "legacy-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
		const sessionFile = legacy.getSessionFile()!;
		const agentPath = childAgentPath(["legacy/project"], "legacy-worker");
		const sessionId = legacy.getSessionId();
		const originalHeader = legacy.getHeader();

		const child = await createManagedChildSession(
			childConfig(sessionFile, sessionDir, agentPath),
			{ agentDir },
			{
				onEvent: () => {},
				onUiNotify: () => {},
				onSessionChanged: () => {},
				onShutdownRequested: () => {},
			},
		);

		try {
			expect(child.sessionFile).toBe(sessionFile);
			expect(child.sessionId).toBe(sessionId);
			expect(child.session.sessionManager.getCwd()).toBe(cwd);
			expect(child.session.sessionManager.getHeader()).toEqual(originalHeader);
			expect(child.session.sessionManager.getSessionName()).toBe(formatAgentPath(agentPath));
		} finally {
			await child.dispose();
		}
	});
});
