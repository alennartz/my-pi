import { describe, expect, it } from "vitest";
import agentsPhilosophy from "./index.ts";
import { AGENTS_MD_SECTION_TAG, renderAgentsMdPhilosophy } from "./philosophy.ts";

type Handler = (event: unknown) => unknown;

function setup() {
	const handlers = new Map<string, Handler>();
	const pi = {
		on: (event: string, handler: Handler) => handlers.set(event, handler),
	};
	agentsPhilosophy(pi as any);

	const event = {
		type: "before_agent_start",
		prompt: "hello",
		systemPrompt: "base prompt",
		systemPromptOptions: {
			sections: {} as Record<string, string>,
		},
	};

	return { event, beforeAgentStart: handlers.get("before_agent_start")! };
}

describe("agents-philosophy extension", () => {
	it("adds the philosophy as a system prompt section", () => {
		const { event, beforeAgentStart } = setup();

		const result = beforeAgentStart(event);

		expect(result).toBeUndefined();
		expect(event.systemPromptOptions.sections[AGENTS_MD_SECTION_TAG]).toBe(renderAgentsMdPhilosophy());
	});

	it("does not force-replace the system prompt", () => {
		const { event, beforeAgentStart } = setup();

		beforeAgentStart(event);

		expect(event.systemPrompt).toBe("base prompt");
		expect((event.systemPromptOptions as any).forceSystemPrompt).toBeUndefined();
	});

	it("leaves an already-populated section untouched", () => {
		const { event, beforeAgentStart } = setup();
		event.systemPromptOptions.sections[AGENTS_MD_SECTION_TAG] = "custom content";

		beforeAgentStart(event);

		expect(event.systemPromptOptions.sections[AGENTS_MD_SECTION_TAG]).toBe("custom content");
	});
});
