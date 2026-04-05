import { beforeEach, describe, expect, it, vi } from "vitest";

const { createSpy, cleanupSpy, execSyncSpy } = vi.hoisted(() => ({
	createSpy: vi.fn(async () => undefined),
	cleanupSpy: vi.fn(async () => undefined),
	execSyncSpy: vi.fn(),
}));

vi.mock("./controller.ts", () => ({
	createWorktreeController: () => ({
		create: createSpy,
		cleanup: cleanupSpy,
	}),
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

	worktreeExtension({
		registerCommand(name, command) {
			registeredName = name;
			registeredCommand = command;
		},
	} as never);

	if (!registeredCommand || !registeredName) {
		throw new Error("worktree extension did not register a command");
	}

	return {
		registeredName,
		registeredCommand: registeredCommand as {
			description: string;
			getArgumentCompletions(prefix: string): Array<{ value: string; label: string }> | null;
			handler(args: string, ctx: { ui: { notify(message: string, level: string): void } }): Promise<void>;
		},
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
		};

		await registeredCommand.handler("cleanup release/1.2", ctx);

		expect(cleanupSpy).toHaveBeenCalledWith({ mergeTarget: "release/1.2" });
		expect(createSpy).not.toHaveBeenCalled();
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});

	it("notifies the user when parsing fails instead of calling the controller", async () => {
		const { registeredCommand } = registerExtension();
		const ctx = {
			ui: {
				notify: vi.fn(),
			},
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
