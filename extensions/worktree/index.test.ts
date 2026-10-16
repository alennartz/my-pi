import { beforeEach, describe, expect, it, vi } from "vitest";

const { createSpy, cleanupSpy, execSyncSpy, dependencyBox } = vi.hoisted(() => ({
	createSpy: vi.fn(async () => undefined),
	cleanupSpy: vi.fn(async () => undefined),
	execSyncSpy: vi.fn(),
	dependencyBox: { current: undefined as { agent: { sendMergeInstruction(message: string): Promise<void> } } | undefined },
}));

vi.mock("./controller.ts", () => ({
	createWorktreeController: (dependencies: typeof dependencyBox.current) => {
		dependencyBox.current = dependencies ?? undefined;
		return {
			create: createSpy,
			cleanup: cleanupSpy,
		};
	},
}));

vi.mock("node:child_process", () => ({
	execSync: execSyncSpy,
}));

import worktreeExtension from "./index.ts";

type RegisteredCommand = Parameters<
	{
		registerCommand(name: string, command: unknown): void;
	}["registerCommand"]
>[1];

function registerExtension() {
	let registeredName: string | undefined;
	let registeredCommand: RegisteredCommand | undefined;
	const eventHandlers = new Map<string, () => void>();
	const sendUserMessage = vi.fn();

	worktreeExtension({
		registerCommand(name, command) {
			registeredName = name;
			registeredCommand = command;
		},
		// The extension subscribes to agent_start / agent_end at init to
		// implement reliable wait-for-turn-completion.
		on(event, handler) {
			eventHandlers.set(event, handler as () => void);
			return () => undefined;
		},
		sendUserMessage,
	} as never);

	if (!registeredCommand || !registeredName) {
		throw new Error("worktree extension did not register a command");
	}

	return {
		registeredName,
		registeredCommand: registeredCommand as {
			description: string;
			getArgumentCompletions(prefix: string): Array<{ value: string; label: string }> | null;
			handler(
				args: string,
				ctx: { ui: { notify(message: string, level: string): void }; waitForIdle(): Promise<void> },
			): Promise<void>;
		},
		eventHandlers,
		sendUserMessage,
		getDependencies: () => dependencyBox.current,
	};
}

describe("worktree extension entrypoint", () => {
	beforeEach(() => {
		createSpy.mockClear();
		cleanupSpy.mockClear();
		execSyncSpy.mockReset();
	});

	it("registers the /worktree command", () => {
		const { registeredName, registeredCommand } = registerExtension();

		expect(registeredName).toBe("worktree");
		expect(registeredCommand.description).toContain("git worktree sessions");
	});

	it("dispatches create requests to the controller", async () => {
		const { registeredCommand } = registerExtension();
		const ctx = {
			ui: {
				notify: vi.fn(),
			},
			waitForIdle: vi.fn(async () => undefined),
		};

		await registeredCommand.handler("create feature/worktree release/1.2", ctx);

		expect(createSpy).toHaveBeenCalledWith({
			branchName: "feature/worktree",
			baseBranch: "release/1.2",
		});
		expect(cleanupSpy).not.toHaveBeenCalled();
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});

	it("dispatches cleanup requests to the controller", async () => {
		const { registeredCommand } = registerExtension();
		const ctx = {
			ui: {
				notify: vi.fn(),
			},
			waitForIdle: vi.fn(async () => undefined),
		};

		await registeredCommand.handler("cleanup release/1.2", ctx);

		expect(cleanupSpy).toHaveBeenCalledWith({ mergeTarget: "release/1.2" });
		expect(createSpy).not.toHaveBeenCalled();
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});

	it("waits for the command context to become idle before sending the merge instruction", async () => {
		const { registeredCommand, eventHandlers, sendUserMessage, getDependencies } = registerExtension();
		let releaseIdle!: () => void;
		const idle = new Promise<void>((resolve) => {
			releaseIdle = resolve;
		});
		const ctx = {
			ui: {
				notify: vi.fn(),
			},
			waitForIdle: vi.fn(() => idle),
		};

		await registeredCommand.handler("cleanup release/1.2", ctx);
		const dependencies = getDependencies();
		if (!dependencies) {
			throw new Error("worktree dependencies were not captured");
		}

		const mergeTurn = dependencies.agent.sendMergeInstruction("merge this branch");
		await Promise.resolve();
		expect(ctx.waitForIdle).toHaveBeenCalledOnce();
		expect(sendUserMessage).not.toHaveBeenCalled();

		releaseIdle();
		await Promise.resolve();
		expect(sendUserMessage).toHaveBeenCalledWith("merge this branch");

		eventHandlers.get("agent_start")?.();
		eventHandlers.get("agent_end")?.();
		await mergeTurn;
	});

	it("notifies the user when parsing fails instead of calling the controller", async () => {
		const { registeredCommand } = registerExtension();
		const ctx = {
			ui: {
				notify: vi.fn(),
			},
			waitForIdle: vi.fn(async () => undefined),
		};

		await registeredCommand.handler("create", ctx);

		expect(ctx.ui.notify).toHaveBeenCalledWith("Usage: /worktree create <branch-name> [base-branch]", "warning");
		expect(createSpy).not.toHaveBeenCalled();
		expect(cleanupSpy).not.toHaveBeenCalled();
	});

	it("wires branch-list autocomplete through the command-surface helper", () => {
		execSyncSpy.mockReturnValue("main\nrelease/1.2\nstaging\n");
		const { registeredCommand } = registerExtension();

		expect(registeredCommand.getArgumentCompletions("cleanup re")).toEqual([
			{ value: "release/1.2", label: "release/1.2" },
		]);
		expect(execSyncSpy).toHaveBeenCalledWith("git branch --list --format='%(refname:short)'", {
			cwd: process.cwd(),
			encoding: "utf8",
		});
	});
});
