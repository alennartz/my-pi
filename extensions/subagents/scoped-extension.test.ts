import { describe, expect, it, vi } from "vitest";
import type { AgentPath } from "./agent-path.js";
import type { AgentSessionRegistry } from "./agent-session-registry.js";
import { createSubagentsExtension, type SubagentScope } from "./scoped-extension.js";
import type { MessagePort } from "./message-router.js";

const ALL_TOOLS = [
	"list_models",
	"subagent",
	"fork",
	"send",
	"respond",
	"check_status",
	"teardown",
	"resurrect",
	"await_agents",
	"interrupt",
];

function makePi(): { registerTool: ReturnType<typeof vi.fn> } {
	return { registerTool: vi.fn() };
}

const registry = {} as AgentSessionRegistry;

function childScope(path: AgentPath = ["worker"]): SubagentScope {
	return {
		kind: "child",
		registry,
		path,
		identity: {
			id: path[path.length - 1] ?? "worker",
			task: "do the work",
			channels: ["parent"],
		},
		uplink: {} as MessagePort,
	};
}

describe("createSubagentsExtension root scope", () => {
	it("treats empty optional parameters as omission via prepareArguments", async () => {
		const pi = makePi();
		await createSubagentsExtension({ kind: "root" })(pi as any);

		const tools = pi.registerTool.mock.calls.map(([tool]) => tool);
		const teardown = tools.find((tool) => tool.name === "teardown");
		expect(teardown).toBeDefined();
		// The empty-string failure mode: committed-but-empty equals omitted.
		expect(teardown!.prepareArguments({ agent: "" })).toEqual({});
		expect(teardown!.prepareArguments({ agent: "worker" })).toEqual({ agent: "worker" });
		expect(teardown!.prepareArguments({})).toEqual({});

		// Optional arrays: empty array equals omission too.
		const awaitAgents = tools.find((tool) => tool.name === "await_agents");
		expect(awaitAgents).toBeDefined();
		expect(awaitAgents!.prepareArguments({ agents: [] })).toEqual({});

		// Nested optional item fields are cleaned as well.
		const subagent = tools.find((tool) => tool.name === "subagent");
		expect(subagent).toBeDefined();
		expect(
			subagent!.prepareArguments({ agents: [{ id: "a", task: "t", agent: "", model: "" }] }),
		).toEqual({ agents: [{ id: "a", task: "t" }] });
	});

	it("registers the complete subagents tool surface for a root session", async () => {
		const pi = makePi();
		const factory = createSubagentsExtension({ kind: "root" });

		await factory(pi as any);

		const names = pi.registerTool.mock.calls.map(([tool]) => tool.name);
		expect([...names].sort()).toEqual([...ALL_TOOLS].sort());
	});

	it("fails clearly instead of lazily constructing session state before session_start", async () => {
		const pi = makePi();
		await createSubagentsExtension({ kind: "root" })(pi as any);
		const subagent = pi.registerTool.mock.calls
			.map(([tool]) => tool)
			.find((tool) => tool.name === "subagent");

		await expect(subagent!.execute("call", { agents: [{ id: "worker", task: "work" }] }, undefined, undefined, {}))
			.rejects.toThrow(/session_start|not started/i);
	});

	it("keeps root scope independent from process-wide parent-link state", async () => {
		const previous = process.env.PI_PARENT_LINK;
		process.env.PI_PARENT_LINK = JSON.stringify({ id: "stale-child", tools: ["send"] });
		try {
			const pi = makePi();
			await createSubagentsExtension({ kind: "root" })(pi as any);
			const names = pi.registerTool.mock.calls.map(([tool]) => tool.name);
			expect([...names].sort()).toEqual([...ALL_TOOLS].sort());
		} finally {
			if (previous === undefined) delete process.env.PI_PARENT_LINK;
			else process.env.PI_PARENT_LINK = previous;
		}
	});
});

describe("createSubagentsExtension child scope", () => {
	it("registers the same tool definitions for a child; SDK policy decides availability", async () => {
		const pi = makePi();
		await createSubagentsExtension(childScope(["researcher", "worker"]))(pi as any);

		const names = pi.registerTool.mock.calls.map(([tool]) => tool.name);
		expect([...names].sort()).toEqual([...ALL_TOOLS].sort());
	});

	it("does not share mutable registrations between independently constructed scopes", async () => {
		const first = makePi();
		const second = makePi();
		const firstFactory = createSubagentsExtension(childScope(["left", "worker"]));
		const secondFactory = createSubagentsExtension(childScope(["right", "worker"]));

		await firstFactory(first as any);
		await secondFactory(second as any);

		const firstNames = first.registerTool.mock.calls.map(([tool]) => tool.name);
		const secondNames = second.registerTool.mock.calls.map(([tool]) => tool.name);
		expect([...firstNames].sort()).toEqual([...ALL_TOOLS].sort());
		expect([...secondNames].sort()).toEqual([...ALL_TOOLS].sort());
	});
});
