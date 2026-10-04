/**
 * Shared state presentation for the subagents UI surfaces — the TUI
 * dashboard widget (widget.ts) and the pimote panel cards (panel-cards.ts).
 *
 * One home for how an agent state is named, described, and colored, so the
 * two surfaces cannot drift apart. Surface concerns — glyphs, layout, width
 * truncation — stay in the surfaces. Everything here is pure.
 */

import type { AgentState, AgentStatus } from "./agent-set.js";

/** Semantic state colors, valid for the TUI theme and the panel card palette. */
export type StateColor = "accent" | "success" | "warning" | "error";

/** Display order of the states, e.g. for aggregate counts. */
export const AGENT_STATES: readonly AgentState[] = ["running", "idle", "waiting", "errored", "dead"];

/** Plain state names, e.g. for badges and aggregate counts. */
export const STATE_LABELS: Record<AgentState, string> = {
	running: "running",
	idle: "idle",
	waiting: "waiting",
	errored: "errored",
	dead: "dead",
};

/** Framing color for a state: the TUI card border, the panel card accent bar. */
export const STATE_COLORS: Record<AgentState, StateColor> = {
	running: "accent",
	idle: "success",
	waiting: "warning",
	errored: "error",
	dead: "error",
};

/** Color for the state detail line. */
export const STATE_DETAIL_COLORS: Record<AgentState, StateColor | "muted"> = {
	running: "muted",
	idle: "success",
	waiting: "warning",
	errored: "error",
	dead: "error",
};

/** Longest error text carried in a state detail before truncation. */
const MAX_DETAIL_LENGTH = 200;

/** One line describing what the agent is doing right now. */
export function stateDetail(status: AgentStatus): string {
	switch (status.state) {
		case "running":
			return status.lastActivity || "running";
		case "waiting":
			return status.waitingFor.length > 0
				? `waiting → ${status.waitingFor.join(", ")}`
				: "waiting for response";
		case "errored":
			if (!status.lastError) return "errored";
			const error = status.lastError.length > MAX_DETAIL_LENGTH
				? `${status.lastError.slice(0, MAX_DETAIL_LENGTH)}…`
				: status.lastError;
			return `errored: ${error}`;
		case "idle":
		case "dead":
			return status.state;
	}
}
