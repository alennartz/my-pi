import { describe, expect, it } from "vitest";
import {
	AGENT_STATES,
	STATE_COLORS,
	STATE_DETAIL_COLORS,
	STATE_LABELS,
	stateDetail,
} from "./status-display.js";
import type { AgentStatus } from "./agent-set.js";

function status(overrides: Partial<AgentStatus> = {}): AgentStatus {
	return {
		id: "scout",
		state: "running",
		task: "investigate the flake",
		channels: [],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		pendingCorrelations: [],
		lastTurnInput: 0,
		hasSubgroup: false,
		waitingFor: [],
		...overrides,
	};
}

describe("stateDetail", () => {
	it("shows the running activity, falling back to a bare state line", () => {
		expect(stateDetail(status({ lastActivity: "reading foo.ts" }))).toBe("reading foo.ts");
		expect(stateDetail(status())).toBe("running");
	});

	it("shows what a waiting agent is waiting on, falling back when unknown", () => {
		expect(stateDetail(status({ state: "waiting", waitingFor: ["worker", "scout"] })))
			.toBe("waiting → worker, scout");
		expect(stateDetail(status({ state: "waiting" }))).toBe("waiting for response");
	});

	it("surfaces the error text on errored agents", () => {
		expect(stateDetail(status({ state: "errored", lastError: "tool call failed: EACCES" })))
			.toBe("errored: tool call failed: EACCES");
		expect(stateDetail(status({ state: "errored" }))).toBe("errored");
	});

	it("truncates long error text", () => {
		const detail = stateDetail(status({ state: "errored", lastError: "x".repeat(500) }));
		expect(detail).toBe(`errored: ${"x".repeat(200)}…`);
	});

	it("states the settled state plainly for idle and dead", () => {
		expect(stateDetail(status({ state: "idle" }))).toBe("idle");
		expect(stateDetail(status({ state: "dead" }))).toBe("dead");
	});
});

describe("state palettes", () => {
	it("names, frames, and colors every agent state", () => {
		expect(STATE_LABELS).toEqual({
			running: "running",
			idle: "idle",
			waiting: "waiting",
			errored: "errored",
			dead: "dead",
		});
		expect(STATE_COLORS).toEqual({
			running: "accent",
			idle: "success",
			waiting: "warning",
			errored: "error",
			dead: "error",
		});
		expect(STATE_DETAIL_COLORS).toEqual({
			running: "muted",
			idle: "success",
			waiting: "warning",
			errored: "error",
			dead: "error",
		});
	});

	it("iterates every state once", () => {
		expect([...AGENT_STATES].sort()).toEqual(["dead", "errored", "idle", "running", "waiting"]);
	});
});
