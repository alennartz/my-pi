import { describe, expect, it } from "vitest";
import type { SubagentJsonObject, SubagentJsonValue, SubagentMessageInput, SubagentToolCallInput, SubagentToolExecution } from "@pimote/sdk/subagents";
import { createSubagentPresenters, messageCardDetails, SUBAGENT_CUSTOM_TYPE, SUBAGENT_TOOL_NAMES, toolCardDetails } from "./presenters.js";
import type { SubagentCard } from "./presenters.js";

const presenters = createSubagentPresenters({ runningToolProgress: () => undefined });
const owner = ["lead"];

function call(toolName: string, args: SubagentJsonObject, execution: SubagentToolExecution): SubagentToolCallInput {
	return { ownerPath: owner, toolName, toolCallId: "call-1", args, argsComplete: true, execution };
}

function message(details: SubagentJsonValue | undefined, customType = SUBAGENT_CUSTOM_TYPE): SubagentMessageInput {
	return { ownerPath: owner, customType, content: "notice", ...(details !== undefined ? { details } : undefined) };
}

/** Details as they read back from a saved session. */
function saved<T>(value: T): SubagentJsonValue {
	return structuredClone(value) as SubagentJsonValue;
}

const sendCard: SubagentCard = {
	kind: "send",
	state: "complete",
	data: { operation: "send", parameters: { to: "worker", message: "status?", expectResponse: true }, result: { phase: "complete", response: "all green" } },
};

const completionCard: SubagentCard = {
	kind: "completion",
	state: "complete",
	data: { operation: "completion", parameters: {}, result: { path: ["lead", "worker"], state: "idle", output: "done", sessionId: "s-1" } },
};

const teardownCard: SubagentCard = {
	kind: "teardown",
	state: "complete",
	data: {
		operation: "teardown",
		parameters: { agent: "worker", source: "user" },
		result: { affectedAgents: [{ path: ["lead", "worker"], sessionId: "s-1", state: "removed" }] },
	},
};

describe("presenter coverage", () => {
	it("covers the eight subagent tools and the subagents custom type", () => {
		expect([...presenters.toolNames].toSorted()).toEqual([...SUBAGENT_TOOL_NAMES].toSorted());
		expect(presenters.customTypes).toEqual(["subagents"]);
	});
});

describe("presentToolCall", () => {
	it("returns undefined for a tool it does not cover", () => {
		expect(presenters.presentToolCall(call("bash", { command: "ls" }, { state: "pending" }))).toBeUndefined();
	});

	it("returns undefined for unreadable input without throwing", () => {
		const unreadable = [
			null,
			{ ...call("send", {}, { state: "pending" }), ownerPath: "lead" },
			{ ...call("send", {}, { state: "pending" }), execution: undefined },
		] as unknown as SubagentToolCallInput[];
		for (const input of unreadable) {expect(presenters.presentToolCall(input)).toBeUndefined();}
	});

	it("shows the card the final result stored, at the owner path", () => {
		const input = call("send", { to: "worker", message: "status?", expectResponse: true }, { state: "complete", details: saved(toolCardDetails(sendCard)), text: "all green" });
		expect(presenters.presentToolCall(input)).toEqual({ ...sendCard, path: owner });
	});

	it("falls back to the arguments when the stored card fails validation", () => {
		const broken = saved({ subagent: { kind: "send", state: "complete", data: { operation: "send", parameters: { to: 3 }, result: {} } } });
		const mismatched = saved(toolCardDetails(completionCard));
		for (const details of [broken, mismatched]) {
			const card = presenters.presentToolCall(call("send", { to: "worker", message: "hi" }, { state: "complete", details, text: "Message sent to worker." }));
			expect(card).toMatchObject({ kind: "send", state: "complete", data: { parameters: { to: "worker", message: "hi", expectResponse: false } } });
		}
	});

	it("shows running progress as an active card", () => {
		const progress: SubagentCard = { ...sendCard, state: "active", data: { ...sendCard.data, result: { phase: "responding", response: "all gr" } } as SubagentCard["data"] };
		const card = presenters.presentToolCall(call("send", { to: "worker", message: "status?", expectResponse: true }, { state: "running", progress: saved(toolCardDetails(progress)) }));
		expect(card).toEqual({ ...progress, path: owner });
	});

	it("derives an active card from partial arguments while they stream", () => {
		const card = presenters.presentToolCall({ ...call("send", { to: "wor" }, { state: "pending" }), argsComplete: false });
		expect(card).toEqual({
			kind: "send",
			state: "active",
			path: owner,
			data: { operation: "send", parameters: { to: "wor", message: "", expectResponse: false }, result: { phase: "sending" } },
		});
	});

	it.each([
		{
			name: "a blocking send shows the result text as the response",
			toolName: "send",
			args: { to: "worker", message: "status?", expectResponse: true },
			execution: { state: "complete", text: "all green" },
			data: { operation: "send", parameters: { to: "worker", message: "status?", expectResponse: true }, result: { phase: "complete", response: "all green" } },
		},
		{
			name: "a failed send shows the result text as the error",
			toolName: "send",
			args: { to: "worker", message: "status?" },
			execution: { state: "error", text: "Agent not found" },
			data: { operation: "send", parameters: { to: "worker", message: "status?", expectResponse: false }, result: { phase: "complete", error: "Agent not found" } },
		},
		{
			name: "respond",
			toolName: "respond",
			args: { message: "yes" },
			execution: { state: "complete", text: "Response sent." },
			data: { operation: "respond", parameters: { message: "yes" }, result: {} },
		},
		{
			name: "await_agents",
			toolName: "await_agents",
			args: { agents: ["worker"] },
			execution: { state: "error", text: "No agents running" },
			data: { operation: "await", parameters: { agents: ["worker"] }, result: { statuses: [], error: "No agents running" } },
		},
		{
			name: "subagent reads the legacy agent key as the persona",
			toolName: "subagent",
			args: { agents: [{ id: "a", task: "scan", agent: "scout" }, { id: "b", task: "fix", persona: "coder", model: "cheap", cwd: "pkg", channels: ["a"] }] },
			execution: { state: "complete", text: "Spawned" },
			data: {
				operation: "delegation",
				parameters: { fork: false, agents: [{ id: "a", task: "scan", persona: "scout" }, { id: "b", task: "fix", persona: "coder", model: "cheap", cwd: "pkg", channels: ["a"] }] },
				result: { children: [] },
			},
		},
		{
			name: "fork",
			toolName: "fork",
			args: { id: "side", task: "explore" },
			execution: { state: "complete", text: "Forked" },
			data: { operation: "delegation", parameters: { fork: true, agents: [{ id: "side", task: "explore" }] }, result: { children: [] } },
		},
		{
			name: "interrupt",
			toolName: "interrupt",
			args: {},
			execution: { state: "complete", text: "Interrupted" },
			data: { operation: "interrupt", parameters: {}, result: { interrupted: [], pending: [], failed: [] } },
		},
		{
			name: "teardown",
			toolName: "teardown",
			args: { agent: "worker" },
			execution: { state: "complete", text: "Removed" },
			data: { operation: "teardown", parameters: { agent: "worker", source: "model" }, result: { affectedAgents: [] } },
		},
		{
			name: "resurrect",
			toolName: "resurrect",
			args: { agents: [{ sessionId: "s-1", id: "worker", task: "resume", channels: [] }] },
			execution: { state: "error", text: "Session not found" },
			data: {
				operation: "resurrect",
				parameters: { source: "model", agents: [{ sessionId: "s-1", id: "worker", task: "resume", channels: [] }] },
				result: { affectedAgents: [], error: "Session not found" },
			},
		},
	] as const)("derives $name from the arguments", ({ toolName, args, execution, data }) => {
		const card = presenters.presentToolCall(call(toolName, args as unknown as SubagentJsonObject, execution));
		expect(card).toEqual({ kind: data.operation, state: execution.state, path: owner, data });
	});

	it("marks a call without a result as aborted", () => {
		const card = presenters.presentToolCall(call("await_agents", {}, { state: "aborted" }));
		expect(card).toMatchObject({ kind: "await", state: "aborted", path: owner });
	});

	it("never outputs correlation identifiers", () => {
		const respond = presenters.presentToolCall(call("respond", { correlationId: "route-7", message: "yes" }, { state: "error", text: "No pending request route-7" }));
		expect(respond?.data).toEqual({ operation: "respond", parameters: { message: "yes" }, result: { error: "No pending request [redacted]" } });

		const leaky = saved({
			subagent: {
				...sendCard,
				data: { ...sendCard.data, correlationId: "corr-ab12-3", result: { phase: "complete", response: "see corr-ab12-3", correlation_id: "corr-ab12-3" } },
			},
		});
		const send = presenters.presentToolCall(call("send", { to: "worker", message: "status?", expectResponse: true }, { state: "complete", details: leaky, text: "" }));
		expect(send?.data).toEqual({ ...sendCard.data, result: { phase: "complete", response: "see [redacted]" } });
		expect(JSON.stringify(send)).not.toMatch(/corr-|correlation/i);
	});
});

describe("presentMessage", () => {
	it("returns undefined for a custom type it does not cover", () => {
		expect(presenters.presentMessage(message(saved(messageCardDetails([completionCard])), "other"))).toBeUndefined();
	});

	it("shows the stored cards in order at the owner path", () => {
		const cards = presenters.presentMessage(message(saved(messageCardDetails([completionCard, teardownCard]))));
		expect(cards).toEqual([{ ...completionCard, path: owner }, { ...teardownCard, path: owner }]);
	});

	it("skips invalid cards and returns undefined when none is valid", () => {
		const invalid = { kind: "completion", state: "complete", data: { operation: "teardown", parameters: {}, result: {} } };
		expect(presenters.presentMessage(message(saved({ subagent: [invalid, teardownCard, 7] })))).toEqual([{ ...teardownCard, path: owner }]);
		expect(presenters.presentMessage(message(saved({ subagent: [invalid] })))).toBeUndefined();
	});

	it("returns undefined when the message carries no cards", () => {
		expect(presenters.presentMessage(message(undefined))).toBeUndefined();
		expect(presenters.presentMessage(message({}))).toBeUndefined();
	});
});

describe("runningToolProgress", () => {
	it("returns the latest progress the injected registry holds", () => {
		const progress = saved(toolCardDetails({ ...sendCard, state: "active" }));
		const withProgress = createSubagentPresenters({
			runningToolProgress: ({ sessionId, toolCallId }) => (sessionId === "s-1" && toolCallId === "call-1" ? progress : undefined),
		});
		expect(withProgress.runningToolProgress({ sessionId: "s-1", toolCallId: "call-1" })).toEqual(progress);
		expect(withProgress.runningToolProgress({ sessionId: "s-1", toolCallId: "call-2" })).toBeUndefined();
	});
});
