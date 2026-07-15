import { describe, expect, it, vi } from "vitest";
import type { MessagePort } from "./message-router.js";
import {
	createManagedChildSession,
	type ChildSessionConfig,
	type ChildSessionHooks,
	type ManagedChildSessionDependencies,
} from "./managed-child-session.js";

const uplink = {} as MessagePort;

function makeConfig(target: ChildSessionConfig["target"]): ChildSessionConfig {
	return {
		id: "worker",
		target,
		scope: {
			kind: "child",
			identity: {
				id: "worker",
				task: "inspect the change",
				channels: ["parent"],
				tools: ["read", "send"],
			},
			uplink,
		},
		modelRef: "provider/model",
		thinkingLevel: "medium",
		allowedTools: ["read", "send"],
		skillPaths: ["/repo/skills/debugging/SKILL.md"],
		appendSystemPrompt: ["You are a child session."],
	};
}

function makeDependencies(): ManagedChildSessionDependencies {
	return {
		agentDir: "/home/user/.pi/agent",
		authStorage: {} as ManagedChildSessionDependencies["authStorage"],
		modelRegistry: {} as ManagedChildSessionDependencies["modelRegistry"],
	};
}

function makeHooks(): ChildSessionHooks {
	return {
		onEvent: vi.fn(),
		onUiNotify: vi.fn(),
		onSessionChanged: vi.fn(),
		onShutdownRequested: vi.fn(),
	};
}

describe("createManagedChildSession construction", () => {
	it("creates a new target with a real runtime and session metadata", async () => {
		const child = await createManagedChildSession(
			makeConfig({ kind: "new", cwd: "/repo", sessionDir: "/repo/.subagents/sessions" }),
			makeDependencies(),
			makeHooks(),
		);

		expect(child.runtime).toBeDefined();
		expect(child.session).toBeDefined();
		expect(child.sessionId).toEqual(expect.any(String));
		expect(child.sessionFile).toEqual(expect.any(String));
	});

	it("opens an existing JSONL session for a resume target", async () => {
		const sessionFile = "/repo/.subagents/sessions/123_worker.jsonl";
		const child = await createManagedChildSession(
			makeConfig({ kind: "resume", sessionFile, sessionDir: "/repo/.subagents/sessions" }),
			makeDependencies(),
			makeHooks(),
		);

		expect(child.sessionFile).toBe(sessionFile);
	});

	it("forks from the captured source session while preserving child metadata", async () => {
		const child = await createManagedChildSession(
			makeConfig({
				kind: "fork",
				sourceSessionFile: "/repo/parent.jsonl",
				cwd: "/repo",
				sessionDir: "/repo/.subagents/sessions",
			}),
			makeDependencies(),
			makeHooks(),
		);

		expect(child.sessionId).toEqual(expect.any(String));
		expect(child.sessionFile).toEqual(expect.any(String));
	});
});

describe("ManagedChildSession prompt and cancellation surface", () => {
	it("submits text with the requested streaming behavior", async () => {
		const child = await createManagedChildSession(
			makeConfig({ kind: "new", cwd: "/repo", sessionDir: "/repo/.subagents/sessions" }),
			makeDependencies(),
			makeHooks(),
		);

		await expect(child.submit("continue", "steer")).resolves.toBeUndefined();
		await expect(child.submit("follow up", "followUp")).resolves.toBeUndefined();
	});

	it("delegates interruption to cooperative SDK cancellation", async () => {
		const child = await createManagedChildSession(
			makeConfig({ kind: "new", cwd: "/repo", sessionDir: "/repo/.subagents/sessions" }),
			makeDependencies(),
			makeHooks(),
		);

		await expect(child.abort()).resolves.toBeUndefined();
	});

	it("runs shutdown through dispose and makes repeated disposal safe", async () => {
		const child = await createManagedChildSession(
			makeConfig({ kind: "new", cwd: "/repo", sessionDir: "/repo/.subagents/sessions" }),
			makeDependencies(),
			makeHooks(),
		);

		await expect(child.dispose()).resolves.toBeUndefined();
		await expect(child.dispose()).resolves.toBeUndefined();
	});
});

describe("ManagedChildSession event and runtime boundary", () => {
	it("exposes the event bus and current AgentSession alongside the runtime", async () => {
		const child = await createManagedChildSession(
			makeConfig({ kind: "new", cwd: "/repo", sessionDir: "/repo/.subagents/sessions" }),
			makeDependencies(),
			makeHooks(),
		);

		expect(child.eventBus).toBeDefined();
		expect(child.session).toBeDefined();
		expect(child.runtime.session).toBe(child.session);
	});

	it("reports session replacement metadata through the session-changed hook", async () => {
		const hooks = makeHooks();
		const child = await createManagedChildSession(
			makeConfig({ kind: "new", cwd: "/repo", sessionDir: "/repo/.subagents/sessions" }),
			makeDependencies(),
			hooks,
		);

		await child.runtime.newSession();
		expect(hooks.onSessionChanged).toHaveBeenCalledWith(expect.objectContaining({ cwd: expect.any(String) }));
	});
});
