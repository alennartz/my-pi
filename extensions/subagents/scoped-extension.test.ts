import { describe, expect, it, vi } from "vitest";
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

function childScope(tools?: string[]): SubagentScope {
	return {
		kind: "child",
		identity: {
			id: "worker",
			task: "do the work",
			channels: ["parent"],
			...(tools ? { tools } : {}),
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
	it("applies persona tool restrictions while retaining respond as infrastructure", async () => {
		const pi = makePi();
		await createSubagentsExtension(childScope(["send"]))(pi as any);

		const names = pi.registerTool.mock.calls.map(([tool]) => tool.name);
		expect([...names].sort()).toEqual(["respond", "send"]);
	});

	it("allows an unrestricted child to expose the same scoped tool surface", async () => {
		const pi = makePi();
		await createSubagentsExtension(childScope())(pi as any);

		const names = pi.registerTool.mock.calls.map(([tool]) => tool.name);
		expect([...names].sort()).toEqual([...ALL_TOOLS].sort());
	});

	it("does not share mutable registrations between independently constructed scopes", async () => {
		const first = makePi();
		const second = makePi();
		const firstFactory = createSubagentsExtension(childScope(["send"]));
		const secondFactory = createSubagentsExtension(childScope(["check_status"]));

		await firstFactory(first as any);
		await secondFactory(second as any);

		const firstNames = first.registerTool.mock.calls.map(([tool]) => tool.name);
		const secondNames = second.registerTool.mock.calls.map(([tool]) => tool.name);
		expect([...firstNames].sort()).toEqual(["respond", "send"]);
		expect([...secondNames].sort()).toEqual(["check_status", "respond"]);
	});
});
