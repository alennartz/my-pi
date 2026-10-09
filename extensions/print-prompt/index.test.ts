import { describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-tui", () => ({
	Box: class Box {},
	Text: class Text {},
}), { virtual: true });

// The workspace persona projection reads a fixture directory, not the real cwd.
vi.mock("../persona-workspaces/declaration.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../persona-workspaces/declaration.js")>();
	return {
		...original,
		loadWorkspacePersona: vi.fn((cwd: string) =>
			cwd === "/repo/pm-workspace"
				? {
					kind: "persona" as const,
					name: "product-manager",
					body: "you are the product manager for pimote the ai native ide",
					sourcePath: "/repo/pm-workspace/AGENTS.md",
				}
				: undefined),
	};
});

const { default: printPrompt } = await import("./index.js");

type Handler = (...args: any[]) => unknown;

function setup() {
	const handlers = new Map<string, Handler[]>();
	const pi = {
		on: vi.fn((event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		}),
		registerCommand: vi.fn(),
		registerEntryRenderer: vi.fn(),
		appendEntry: vi.fn(),
	};
	printPrompt(pi as any);
	const command = pi.registerCommand.mock.calls[0]?.[1];
	if (!command) throw new Error("/sysprompt command was not registered");
	return { handlers, pi, command };
}

function commandCtx(overrides: Record<string, unknown> = {}) {
	return {
		getSystemPrompt: () => "base prompt",
		cwd: "/nowhere",
		sessionManager: {},
		ui: { notify: vi.fn() },
		...overrides,
	};
}

describe("/sysprompt", () => {
	it("prints the prompt that was rendered after before_agent_start hooks ran", async () => {
		const { command, handlers, pi } = setup();
		const renderedPrompt = "base prompt\n\n## Available Agent Definitions\n- scout";
		const agentStart = handlers.get("agent_start")?.[0];
		if (!agentStart) throw new Error("agent_start snapshot handler was not registered");

		await agentStart({}, {
			getSystemPrompt: () => renderedPrompt,
		});
		const latestPrompt = `${renderedPrompt}\n\nlatest turn`;
		await agentStart({}, {
			getSystemPrompt: () => latestPrompt,
		});
		await command.handler("", commandCtx());

		expect(pi.appendEntry).toHaveBeenCalledWith("print-prompt", { text: latestPrompt });
	});

	it("falls back to the current system prompt before any agent run", async () => {
		const { command, pi } = setup();
		await command.handler("", commandCtx());

		expect(pi.appendEntry).toHaveBeenCalledWith("print-prompt", { text: "base prompt" });
	});

	it("projects the workspace persona preamble before the first run", async () => {
		const { command, pi } = setup();
		const base =
			"You are an expert coding assistant operating inside pi, a coding agent harness.\n\n<tools>\n- read\n</tools>";
		await command.handler("", commandCtx({
			getSystemPrompt: () => base,
			getSystemPromptOptions: () => ({}),
			cwd: "/repo/pm-workspace",
		}));

		const entry = pi.appendEntry.mock.calls.at(-1)?.[1] as { text: string };
		expect(entry.text).toContain("[projected — persona binds at the first turn]");
		expect(entry.text).toContain("you are the product manager");
		expect(entry.text).toContain("\n<tools>");
		expect(entry.text).not.toContain("expert coding assistant");
	});

	it("projects a spawn-declared persona for subagent children before the first run", async () => {
		const { getSubagentPersona, markSubagentChildSession } = await import(
			"../subagents/child-session-marker.js"
		);
		expect(getSubagentPersona).toBeDefined();
		const { command, pi } = setup();
		const manager = {};
		markSubagentChildSession(manager, { name: "scout", body: "Read-only search specialist." });

		await command.handler("", commandCtx({
			getSystemPrompt: () => "generic preamble\n\n<rules>\n- be concise\n</rules>",
			getSystemPromptOptions: () => ({}),
			sessionManager: manager,
		}));

		const entry = pi.appendEntry.mock.calls.at(-1)?.[1] as { text: string };
		expect(entry.text).toContain("Read-only search specialist.");
		expect(entry.text).not.toContain("generic preamble");
	});

	it("leaves the base prompt alone when an explicit --system-prompt outranks the persona", async () => {
		const { command, pi } = setup();
		await command.handler("", commandCtx({
			getSystemPromptOptions: () => ({ customPrompt: "user's own prompt" }),
			cwd: "/repo/pm-workspace",
		}));

		expect(pi.appendEntry).toHaveBeenCalledWith("print-prompt", { text: "base prompt" });
	});
});
