/**
 * TUI widget rendering for subagent group status.
 *
 * Renders one line per agent + aggregate summary line.
 * Uses ctx.ui.setWidget("subagents", lines) for display.
 */

import type { AgentStatus, AgentState } from "./group.js";

interface ThemeFg {
	(color: string, text: string): string;
}

const STATUS_ICONS: Record<AgentState, string> = {
	running: "⏳",
	idle: "✓",
	failed: "✗",
	waiting: "⏸",
};

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatActivity(status: AgentStatus, fg: ThemeFg): string {
	switch (status.state) {
		case "running":
			if (status.lastActivity) {
				return fg("muted", status.lastActivity.length > 30 ? status.lastActivity.slice(0, 30) + "…" : status.lastActivity);
			}
			return fg("muted", "running");
		case "waiting":
			// Show who we're waiting for from pendingCorrelations context
			return fg("warning", "waiting for response");
		case "idle":
			return fg("success", "idle");
		case "failed":
			return fg("error", "failed");
	}
}

function formatUsage(status: AgentStatus, fg: ThemeFg): string {
	const parts: string[] = [];
	if (status.usage.input > 0) parts.push(`↑${formatTokens(status.usage.input)}`);
	if (status.usage.output > 0) parts.push(`↓${formatTokens(status.usage.output)}`);
	if (status.usage.cost > 0) parts.push(`$${status.usage.cost.toFixed(2)}`);
	return fg("dim", parts.join(" "));
}

export function renderGroupWidget(statuses: AgentStatus[], fg: ThemeFg): string[] {
	if (statuses.length === 0) return [];

	const lines: string[] = [];

	// One line per agent
	for (const status of statuses) {
		const icon = STATUS_ICONS[status.state];
		const id = fg("accent", status.id.padEnd(10));
		const activity = formatActivity(status, fg);
		const usage = formatUsage(status, fg);
		lines.push(`${icon} ${id} ${activity}  ${usage}`);
	}

	// Aggregate line
	const counts: Record<AgentState, number> = { running: 0, idle: 0, failed: 0, waiting: 0 };
	let totalInput = 0;
	let totalOutput = 0;
	let totalCost = 0;

	for (const s of statuses) {
		counts[s.state]++;
		totalInput += s.usage.input;
		totalOutput += s.usage.output;
		totalCost += s.usage.cost;
	}

	const countParts: string[] = [];
	if (counts.idle > 0) countParts.push(`${counts.idle} idle`);
	if (counts.running > 0) countParts.push(`${counts.running} running`);
	if (counts.waiting > 0) countParts.push(`${counts.waiting} waiting`);
	if (counts.failed > 0) countParts.push(`${counts.failed} failed`);

	const usageParts: string[] = [];
	if (totalInput > 0) usageParts.push(`↑${formatTokens(totalInput)}`);
	if (totalOutput > 0) usageParts.push(`↓${formatTokens(totalOutput)}`);
	if (totalCost > 0) usageParts.push(`$${totalCost.toFixed(2)}`);

	const sep = fg("muted", "───");
	const summary = fg("muted", `${statuses.length} agents: ${countParts.join(", ")}`);
	const totalUsage = fg("dim", usageParts.join(" "));
	lines.push(`${sep} ${summary} │ ${totalUsage}`);

	return lines;
}
