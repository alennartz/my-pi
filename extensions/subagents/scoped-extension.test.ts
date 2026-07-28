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
	it("registers the complete subagents tool surface for a root session", async () => {
		const pi = makePi();
		const factory = createSubagentsExtension({ kind: "root" });

		await factory(pi as any);

		const names = pi.registerTool.mock.calls.map(([tool]) => tool.name);
		expect([...names].sort()).toEqual([...ALL_TOOLS].sort());
	});

	it("teaches send users to reserve it for coordination, not completion reporting", async () => {
		const pi = makePi();
		await createSubagentsExtension({ kind: "root" })(pi as any);

		const sendTool = pi.registerTool.mock.calls.find(([tool]) => tool.name === "send")?.[0];
		expect(sendTool.promptGuidelines).toEqual(expect.arrayContaining([
			"Use send only for mid-task clarification or coordination (including peer handoffs), not as a completion or reporting channel.",
			"Never send a completed-task summary to the parent, with or without expectResponse; your final text is delivered automatically via <agent_idle>. Do not duplicate the final result in both send and your final output.",
		]));
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
