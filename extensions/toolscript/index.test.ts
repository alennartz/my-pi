import { describe, expect, it, vi } from "vitest";

const { startMock } = vi.hoisted(() => ({ startMock: vi.fn() }));

vi.mock("./client.ts", () => ({
	ToolscriptClient: class {
		start = startMock;
		stop = vi.fn(async () => {});
		constructor(_cwd: string) {}
	},
}));

const { default: toolscript } = await import("./index.ts");

type Handler = (event: any, ctx: any) => unknown;

interface StartResult {
	tools: Array<{ name: string; description?: string; inputSchema?: unknown }>;
	instructions?: string;
}

function makeStartResult(overrides: Partial<StartResult> = {}): StartResult {
	return {
		tools: [{ name: "search", description: "Search things", inputSchema: {} }],
		...overrides,
	};
}

function setup() {
	const handlers = new Map<string, Handler[]>();
	const pi = {
		on: vi.fn((event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		}),
		registerTool: vi.fn(),
	};
	toolscript(pi as any);
	return { handlers, pi };
}

function makeBeforeAgentStartEvent() {
	return {
		systemPromptOptions: { sections: {} as Record<string, string> },
	};
}

async function flush(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

async function bootSession(handlers: Map<string, Handler[]>, result?: Promise<StartResult>): Promise<void> {
	startMock.mockImplementation(() => result ?? Promise.resolve(makeStartResult()));
	await handlers.get("session_start")?.[0]({}, { cwd: "/tmp/toolscript-test" });
	await flush();
}

describe("toolscript instructions section", () => {
	it("contributes the toolscript section once the async boot resolves", async () => {
		const { handlers } = setup();
		await bootSession(handlers, Promise.resolve(makeStartResult({ instructions: "Be terse." })));

		const event = makeBeforeAgentStartEvent();
		await handlers.get("before_agent_start")?.[0](event, {});

		expect(event.systemPromptOptions.sections.toolscript).toBe("Be terse.");
	});

	it("omits the section until the boot resolves", async () => {
		const { handlers } = setup();
		let resolveStart!: (result: StartResult) => void;
		const pending = new Promise<StartResult>((resolve) => {
			resolveStart = resolve;
		});
		startMock.mockImplementation(() => pending);
		await handlers.get("session_start")?.[0]({}, { cwd: "/tmp/toolscript-test" });

		const before = makeBeforeAgentStartEvent();
		await handlers.get("before_agent_start")?.[0](before, {});
		expect(before.systemPromptOptions.sections.toolscript).toBeUndefined();

		resolveStart(makeStartResult({ instructions: "Be terse." }));
		await flush();

		const after = makeBeforeAgentStartEvent();
		await handlers.get("before_agent_start")?.[0](after, {});
		expect(after.systemPromptOptions.sections.toolscript).toBe("Be terse.");
	});

	it("omits the section when the server reports no instructions", async () => {
		const { handlers } = setup();
		await bootSession(handlers, Promise.resolve(makeStartResult()));

		const event = makeBeforeAgentStartEvent();
		await handlers.get("before_agent_start")?.[0](event, {});

		expect(event.systemPromptOptions.sections).toEqual({});
	});

	it("omits the section when the boot fails", async () => {
		const { handlers } = setup();
		startMock.mockImplementation(() => Promise.reject(new Error("boom")));
		await handlers.get("session_start")?.[0]({}, { cwd: "/tmp/toolscript-test" });
		await flush();

		const event = makeBeforeAgentStartEvent();
		await handlers.get("before_agent_start")?.[0](event, {});

		expect(event.systemPromptOptions.sections).toEqual({});
	});

	it("keeps the section value stable across turns", async () => {
		const { handlers } = setup();
		await bootSession(handlers, Promise.resolve(makeStartResult({ instructions: "Be terse." })));

		const first = makeBeforeAgentStartEvent();
		await handlers.get("before_agent_start")?.[0](first, {});
		const second = makeBeforeAgentStartEvent();
		second.systemPromptOptions.sections.toolscript = "Be terse.";
		await handlers.get("before_agent_start")?.[0](second, {});

		expect(second.systemPromptOptions.sections.toolscript).toBe("Be terse.");
	});

	it("registers tools with promptSnippet but no promptGuidelines", async () => {
		const { handlers, pi } = setup();
		await bootSession(handlers, Promise.resolve(makeStartResult({ instructions: "Be terse." })));

		expect(pi.registerTool).toHaveBeenCalledTimes(1);
		const definition = pi.registerTool.mock.calls[0][0] as Record<string, unknown>;
		expect(definition.promptSnippet).toBe("Search things");
		expect(definition).not.toHaveProperty("promptGuidelines");
	});
});
