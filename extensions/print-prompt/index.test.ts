import { describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-tui", () => ({
	Box: class Box {},
	Text: class Text {},
}), { virtual: true });

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
		await command.handler("", {
			getSystemPrompt: () => "base prompt",
			ui: { notify: vi.fn() },
		});

		expect(pi.appendEntry).toHaveBeenCalledWith("print-prompt", { text: latestPrompt });
	});

	it("falls back to the current system prompt before any agent run", async () => {
		const { command, pi } = setup();
		await command.handler("", {
			getSystemPrompt: () => "base prompt",
			ui: { notify: vi.fn() },
		});

		expect(pi.appendEntry).toHaveBeenCalledWith("print-prompt", { text: "base prompt" });
	});
});
