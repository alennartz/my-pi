/**
 * Tool result payloads for the subagent LLM tools: TypeScript interfaces,
 * matching TypeBox output schemas, and the shared builders that derive them
 * from manager state.
 *
 * `structuredContent` is what codemode scripts receive instead of the text
 * content; `details` carries the same object for renderers and HTML export.
 */

import { Type } from "typebox";
import type { Usage } from "@earendil-works/pi-ai";
import { formatTokenCount } from "./format.js";
import { addCostBreakdown, type AgentCostBreakdown } from "./agent-session-registry.js";
import type { AgentStatus, AgentUsage } from "./agent-set.js";
import { modelDisplayName } from "./status-display.js";
import type { AgentCompleteData } from "./messages.js";

/** Status vocabulary of <agent_idle> and <agent_torn_down> reports. */
export type LifecycleStatus = AgentCompleteData["status"];

const CostBreakdownSchema = Type.Object({
	input: Type.Number({ description: "Input-token cost in USD" }),
	output: Type.Number({ description: "Output-token cost in USD" }),
	cacheRead: Type.Number({ description: "Cache-read cost in USD" }),
	cacheWrite: Type.Number({ description: "Cache-write cost in USD" }),
});

const UsageSchema = Type.Object({
	input: Type.Number({ description: "Input tokens, excluding cache reads and writes" }),
	output: Type.Number({ description: "Output tokens" }),
	cacheRead: Type.Number(),
	cacheWrite: Type.Number(),
	cost: Type.Number({ description: "Cost in USD" }),
	costBreakdown: Type.Optional(CostBreakdownSchema),
	turns: Type.Number(),
});

export interface AgentRefData {
	id: string;
	status: string;
	output?: string;
	error?: string;
	sessionId?: string;
}

/** Covers both spawn acks (id + status) and completion reports (output/error/sessionId added). */
const AgentRefSchema = Type.Object({
	id: Type.String(),
	status: Type.String({ description: "Agent lifecycle state: running, waiting, idle, errored, or dead" }),
	output: Type.Optional(Type.String({ description: "Final message, truncated when over the output cap" })),
	error: Type.Optional(Type.String()),
	sessionId: Type.Optional(Type.String({ description: "Pass to resurrect to bring the agent back online" })),
});

export interface SpawnResultData {
	agents: AgentRefData[];
}

export const SpawnResultSchema = Type.Object({
	agents: Type.Array(AgentRefSchema),
});

/** Same shape as spawn/await results: the completion payload rides structuredContent. */
export const AwaitResultSchema = SpawnResultSchema;

export interface SendResultData {
	/** The peer's reply, or null when the wait was interrupted (the reply arrives later as a notification). */
	response: string | null;
	deferred: boolean;
	correlationId?: string;
}

export const SendResultSchema = Type.Object({
	response: Type.Union([Type.String(), Type.Null()]),
	deferred: Type.Boolean(),
	correlationId: Type.Optional(Type.String()),
});

export interface InterruptResultData {
	interrupted: string[];
	pending: string[];
	failed: string[];
}

export const InterruptResultSchema = Type.Object({
	interrupted: Type.Array(Type.String()),
	pending: Type.Array(Type.String(), { description: "Abort delivered but not yet settled" }),
	failed: Type.Array(Type.String()),
});

export interface ResurrectResultData {
	agents: { id: string; sessionId: string }[];
}

export const ResurrectResultSchema = Type.Object({
	agents: Type.Array(Type.Object({
		id: Type.String(),
		sessionId: Type.String(),
	})),
});

export interface StatusAgentData {
	id: string;
	state: string;
	task: string;
	channels: string[];
	agentDef?: string;
	model?: string;
	lastActivity?: string;
	lastOutputPreview?: string;
	pendingCorrelations: string[];
	lastTurnInput: number;
	contextWindow?: number;
	hasSubgroup: boolean;
	waitingFor: string[];
	usage: AgentUsage;
}

export const StatusResultSchema = Type.Object({
	agents: Type.Array(Type.Object({
		id: Type.String(),
		state: Type.String(),
		task: Type.String(),
		channels: Type.Array(Type.String()),
		agentDef: Type.Optional(Type.String()),
		model: Type.Optional(Type.String()),
		lastActivity: Type.Optional(Type.String()),
		lastOutputPreview: Type.Optional(Type.String()),
		pendingCorrelations: Type.Array(Type.String()),
		lastTurnInput: Type.Number(),
		contextWindow: Type.Optional(Type.Number()),
		hasSubgroup: Type.Boolean(),
		waitingFor: Type.Array(Type.String()),
		usage: UsageSchema,
	})),
});

export interface TeardownAgentData {
	id: string;
	status: LifecycleStatus;
	sessionId?: string;
	/** Usage since the agent was spawned, resurrected, or reattached, including its live subtree. */
	usage: AgentUsage;
	/** Baseline the delta was measured from; present only when non-zero (parent-session restore). */
	usageBaseline?: AgentUsage;
}

export interface TeardownResultData {
	agents: TeardownAgentData[];
}

/** Sum the usage summaries that a teardown result reports for its subtree. */
export function sumAgentUsage(usages: readonly AgentUsage[]): AgentUsage {
	return usages.reduce<AgentUsage>(
		(total, usage) => {
			const costBreakdown = addCostBreakdown(total.costBreakdown, usage.costBreakdown);
			return {
				input: total.input + usage.input,
				output: total.output + usage.output,
				cacheRead: total.cacheRead + usage.cacheRead,
				cacheWrite: total.cacheWrite + usage.cacheWrite,
				cost: total.cost + usage.cost,
				turns: total.turns + usage.turns,
				...(costBreakdown !== undefined ? { costBreakdown } : {}),
			};
		},
		{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
	);
}

/** Adapt the local cumulative summary to pi's ToolResultMessage usage contract. */
export function toPiUsage(usage: AgentUsage): Usage {
	const costBreakdown: AgentCostBreakdown = usage.costBreakdown ?? {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
	};
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		totalTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
		cost: {
			input: costBreakdown.input,
			output: costBreakdown.output,
			cacheRead: costBreakdown.cacheRead,
			cacheWrite: costBreakdown.cacheWrite,
			total: usage.cost,
		},
	};
}

export const TeardownResultSchema = Type.Object({
	agents: Type.Array(Type.Object({
		id: Type.String(),
		status: Type.String({ description: "idle when the agent had settled, errored or dead otherwise" }),
		sessionId: Type.Optional(Type.String({ description: "Pass to resurrect to bring the agent back online" })),
		usage: UsageSchema,
		usageBaseline: Type.Optional(UsageSchema, { description: "Pre-attach usage the delta excludes; present only when non-zero" }),
	})),
});

export interface ModelRowData {
	ref: string;
	contextWindow: number | null;
	inputCostPerMtok: number | null;
	outputCostPerMtok: number | null;
	cacheReadCostPerMtok: number | null;
}

export interface ModelsResultData {
	models: ModelRowData[];
}

export const ModelsResultSchema = Type.Object({
	models: Type.Array(Type.Object({
		ref: Type.String({ description: "provider/id, usable as a subagent model override" }),
		contextWindow: Type.Union([Type.Number(), Type.Null()]),
		inputCostPerMtok: Type.Union([Type.Number(), Type.Null()]),
		outputCostPerMtok: Type.Union([Type.Number(), Type.Null()]),
		cacheReadCostPerMtok: Type.Union([Type.Number(), Type.Null()]),
	})),
});

export interface ManagerLookup {
	getAgentStatus(agentId: string): AgentStatus | undefined;
	getSessionId(agentId: string): string | undefined;
}

/** Map lifecycle state to the idle/errored/dead vocabulary of the reports. */
export function lifecycleStatus(state: string): LifecycleStatus {
	return state === "errored" || state === "dead" ? state : "idle";
}

/** Build completion payloads from manager statuses for agents that may never have queued a notification. */
export function completionDataFor(ids: string[], manager: ManagerLookup): AgentCompleteData[] {
	return ids.map((id) => {
		const status = manager.getAgentStatus(id);
		return {
			id,
			status: status ? lifecycleStatus(status.state) : "idle",
			output: status?.lastOutput,
			error: status?.lastError,
			sessionId: manager.getSessionId(id),
		};
	});
}

export function statusData(status: AgentStatus): StatusAgentData {
	return {
		id: status.id,
		state: status.state,
		task: status.task,
		channels: [...status.channels],
		agentDef: status.agentDef,
		model: status.model ? modelDisplayName(status.model, status.thinkingLevel) : undefined,
		lastActivity: status.lastActivity,
		lastOutputPreview: outputPreview(status.lastOutput),
		pendingCorrelations: [...status.pendingCorrelations],
		lastTurnInput: status.lastTurnInput,
		contextWindow: status.contextWindow,
		hasSubgroup: status.hasSubgroup,
		waitingFor: [...status.waitingFor],
		usage: {
			...status.usage,
			...(status.usage.costBreakdown
				? { costBreakdown: { ...status.usage.costBreakdown } }
				: {}),
		},
	};
}

/** Same 200-char bound as the check_status text output. */
export function outputPreview(text: string | undefined): string | undefined {
	if (!text) return undefined;
	return text.length > 200 ? text.slice(0, 200) + "..." : text;
}

export function isZeroUsage(usage: AgentUsage): boolean {
	return usage.input === 0 && usage.output === 0 && usage.cacheRead === 0
		&& usage.cacheWrite === 0 && usage.cost === 0 && usage.turns === 0
		&& (usage.costBreakdown === undefined
			|| (usage.costBreakdown.input === 0 && usage.costBreakdown.output === 0
				&& usage.costBreakdown.cacheRead === 0 && usage.costBreakdown.cacheWrite === 0));
}

/** One-line usage report for tool result text, noting the excluded baseline when non-zero. */
export function formatUsageLine(delta: AgentUsage, baseline?: AgentUsage): string {
	const total = delta.input + delta.cacheRead + delta.cacheWrite;
	let line = `Usage: ↑${formatTokenCount(total)} ↓${formatTokenCount(delta.output)} $${delta.cost.toFixed(4)} (${delta.turns} turns)`;
	if (baseline && !isZeroUsage(baseline)) {
		const baselineTotal = baseline.input + baseline.cacheRead + baseline.cacheWrite;
		line += ` — delta since attach; pre-attach baseline was ↑${formatTokenCount(baselineTotal)} ↓${formatTokenCount(baseline.output)} $${baseline.cost.toFixed(4)}`;
	}
	return line;
}

