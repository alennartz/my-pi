import { describe, expect, it } from "vitest";
import type { AgentStatus } from "./agent-set.js";
import type { AgentCompleteData } from "./messages.js";
import {
	completionDataFor,
	formatUsageLine,
	isZeroUsage,
	lifecycleStatus,
	outputPreview,
	statusData,
	sumAgentUsage,
	toPiUsage,
	type ManagerLookup,
} from "./tool-results.js";

function statusOf(overrides: Partial<AgentStatus> = {}): AgentStatus {
	return {
		id: "a",
		state: "idle",
		task: "do things",
		channels: [],
		usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0.01, turns: 2 },
		pendingCorrelations: [],
		lastTurnInput: 120,
		hasSubgroup: false,
		waitingFor: [],
		...overrides,
	};
}

describe("lifecycleStatus", () => {
	it("keeps errored and dead, maps everything else to idle", () => {
		expect(lifecycleStatus("errored")).toBe("errored");
		expect(lifecycleStatus("dead")).toBe("dead");
		expect(lifecycleStatus("idle")).toBe("idle");
		expect(lifecycleStatus("running")).toBe("idle");
		expect(lifecycleStatus("waiting")).toBe("idle");
	});
});

describe("outputPreview", () => {
	it("passes short text through and bounds long text at 200 chars", () => {
		expect(outputPreview(undefined)).toBeUndefined();
		expect(outputPreview("short")).toBe("short");
		const long = "a".repeat(201);
		const preview = outputPreview(long)!;
		expect(preview.length).toBe(203);
		expect(preview.endsWith("...")).toBe(true);
	});
});

describe("isZeroUsage", () => {
	it("detects zero and non-zero usage", () => {
		expect(isZeroUsage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 })).toBe(true);
		expect(isZeroUsage({ input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 })).toBe(false);
		expect(isZeroUsage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.0001, turns: 0 })).toBe(false);
	});
});

describe("sumAgentUsage and toPiUsage", () => {
	it("preserves category costs and maps them into pi usage", () => {
		const usage = sumAgentUsage([
			{
				input: 100,
				output: 20,
				cacheRead: 10,
				cacheWrite: 5,
				cost: 0.01,
				costBreakdown: { input: 0.002, output: 0.003, cacheRead: 0.004, cacheWrite: 0.001 },
				turns: 1,
			},
			{
				input: 4,
				output: 2,
				cacheRead: 1,
				cacheWrite: 0,
				cost: 0.005,
				costBreakdown: { input: 0.001, output: 0.001, cacheRead: 0.002, cacheWrite: 0 },
				turns: 1,
			},
		]);
		expect(usage.costBreakdown).toEqual({ input: 0.003, output: 0.004, cacheRead: 0.006, cacheWrite: 0.001 });
		expect(toPiUsage(usage)).toEqual({
			input: 104,
			output: 22,
			cacheRead: 11,
			cacheWrite: 5,
			totalTokens: 142,
			cost: { input: 0.003, output: 0.004, cacheRead: 0.006, cacheWrite: 0.001, total: 0.015 },
		});
	});

	it("keeps the old zero category fallback for scalar-only summaries", () => {
		expect(toPiUsage({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.5, turns: 1 }).cost).toEqual({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0.5,
		});
	});
});

describe("formatUsageLine", () => {
	it("reports the delta without a baseline note when baseline is zero", () => {
		const line = formatUsageLine(
			{ input: 120, output: 40, cacheRead: 80, cacheWrite: 0, cost: 0.01, turns: 2 },
			{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		);
		expect(line).toBe("Usage: ↑200 ↓40 $0.0100 (2 turns)");
	});

	it("notes the excluded baseline when non-zero", () => {
		const line = formatUsageLine(
			{ input: 300, output: 40, cacheRead: 0, cacheWrite: 0, cost: 0.005, turns: 1 },
			{ input: 1200, output: 900, cacheRead: 0, cacheWrite: 0, cost: 0.09, turns: 6 },
		);
		expect(line).toContain("delta since attach");
		expect(line).toContain("baseline was ↑1.2k ↓900 $0.0900");
		expect(line).toBe(
			"Usage: ↑300 ↓40 $0.0050 (1 turns) — delta since attach; pre-attach baseline was ↑1.2k ↓900 $0.0900",
		);
	});
});

describe("completionDataFor", () => {
	const statuses = new Map<string, AgentStatus>([
		["a", statusOf({ id: "a", state: "idle", lastOutput: "final" })],
		["b", statusOf({ id: "b", state: "errored", lastError: "boom" })],
	]);
	const manager: ManagerLookup = {
		getAgentStatus: (id) => statuses.get(id),
		getSessionId: (id) => (id === "a" ? "sess-a" : undefined),
	};

	it("builds completion payloads from statuses, including unknown agents as idle", () => {
		const data: AgentCompleteData[] = completionDataFor(["a", "b", "ghost"], manager);
		expect(data).toEqual([
			{ id: "a", status: "idle", output: "final", error: undefined, sessionId: "sess-a" },
			{ id: "b", status: "errored", output: undefined, error: "boom", sessionId: undefined },
			{ id: "ghost", status: "idle", output: undefined, error: undefined, sessionId: undefined },
		]);
	});
});

describe("statusData", () => {
	it("projects a status with a bounded output preview and copied arrays", () => {
		const status = statusOf({
			lastOutput: "x".repeat(300),
			channels: ["parent"],
			pendingCorrelations: ["c1"],
			waitingFor: ["b"],
		});
		const data = statusData(status);
		expect(data.id).toBe("a");
		expect(data.lastOutputPreview).toHaveLength(203);
		expect(data.channels).toEqual(["parent"]);
		expect(data.pendingCorrelations).toEqual(["c1"]);
		expect(data.waitingFor).toEqual(["b"]);
		expect(data.usage).toEqual(status.usage);
		expect(data.usage).not.toBe(status.usage);
	});
});
