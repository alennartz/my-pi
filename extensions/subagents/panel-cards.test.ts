import { describe, expect, it } from "vitest";
import { statusesToCards } from "./panel-cards.js";
import { stateDetail } from "./status-display.js";
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

describe("statusesToCards", () => {
	it("returns no cards for no agents", () => {
		expect(statusesToCards([])).toEqual([]);
	});

	it("keys each card by the path-qualified agent id", () => {
		const [card] = statusesToCards([status({ id: "worker/scout" })]);
		expect(card.id).toBe("worker/scout");
		expect(card.header.title).toBe("worker/scout");
	});

	it("falls back to sane identity strings", () => {
		const [card] = statusesToCards([status({ agentDef: undefined, model: undefined })]);
		expect(card.body?.[0]).toEqual({ content: "default · —", style: "secondary" });
	});

	it("maps every state to a color and a plain-text tag", () => {
		const cases = [
			{ state: "running", color: "accent", tag: "running (2)" },
			{ state: "idle", color: "success", tag: "idle (2)" },
			{ state: "waiting", color: "warning", tag: "waiting (2)" },
			{ state: "errored", color: "error", tag: "errored (2)" },
			{ state: "dead", color: "error", tag: "dead (2)" },
		] as const;
		for (const { state, color, tag } of cases) {
			const [card] = statusesToCards([status({ state, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 2 } })]);
			expect(card.color).toBe(color);
			expect(card.header.tag).toBe(tag);
		}
	});

	it("omits the turn count when the agent has not run a turn yet", () => {
		const [card] = statusesToCards([status({ state: "idle" })]);
		expect(card.header.tag).toBe("idle");
	});

	it("marks a subgroup with plain text, never a nerd-font glyph", () => {
		const [card] = statusesToCards([status({ state: "running", hasSubgroup: true })]);
		expect(card.header.tag).toBe("running +sub");
		expect(card.header.tag).toMatch(/^[\x20-\x7e]+$/);
	});

	it("carries the shared state detail as the body's second line", () => {
		const errored = status({ state: "errored", lastError: "tool call failed: EACCES" });
		const [card] = statusesToCards([errored]);
		expect(card.body?.[1]).toEqual({ content: stateDetail(errored), style: "text" });
		expect(card.body).toHaveLength(2);
	});

	it("lists channels below the state line", () => {
		const [card] = statusesToCards([status({ channels: ["worker", "scout"] })]);
		expect(card.body?.[2]).toEqual({ content: "worker · scout", style: "secondary" });
	});

	it("omits the channels line when there are no channels", () => {
		const [card] = statusesToCards([status()]);
		expect(card.body).toHaveLength(2);
	});

	it("reports cumulative tokens, context fill, and cost in the footer", () => {
		const [card] = statusesToCards([status({
			usage: { input: 500, output: 200, cacheRead: 1500, cacheWrite: 1000, cost: 0.0123, turns: 1 },
			contextWindow: 100_000,
			lastTurnInput: 25_000,
		})]);
		expect(card.footer).toEqual(["↑3.0k", "↓200", "ctx:25%", "$0.01"]);
	});

	it("shows context fill even before the first turn input lands", () => {
		const [card] = statusesToCards([status({ contextWindow: 100_000 })]);
		expect(card.footer).toEqual(["ctx:0%"]);
	});

	it("omits footer entries for zero usage", () => {
		const [card] = statusesToCards([status()]);
		expect(card.footer).toEqual([]);
	});
});
