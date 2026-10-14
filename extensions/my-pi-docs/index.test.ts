import { describe, expect, it, vi } from "vitest";
import myPiDocs, { EXTENSION_DOCS_PATH, EXTENSION_DOCS_SECTION } from "./index.ts";

type Handler = (event: any, ctx: any) => unknown;

function setup() {
	const handlers = new Map<string, Handler[]>();
	const pi = {
		on: vi.fn((event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		}),
	};
	myPiDocs(pi as any);
	return { handlers };
}

describe("my-pi documentation prompt section", () => {
	it("points agents to the canonical documentation file", () => {
		const { handlers } = setup();
		const event = { systemPromptOptions: { sections: {} as Record<string, string> } };

		handlers.get("before_agent_start")?.[0](event, {});

		expect(event.systemPromptOptions.sections["my-pi"]).toBe(EXTENSION_DOCS_SECTION);
		expect(event.systemPromptOptions.sections["my-pi"]).toContain(EXTENSION_DOCS_PATH);
	});
});
