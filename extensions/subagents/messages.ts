/**
 * Structured message formats for inter-agent communication.
 *
 * LLM-facing messages use XML serialization.
 * Broker wire protocol uses JSONL (newline-delimited JSON) over unix sockets.
 */

// ─── LLM-facing XML types and serializers ────────────────────────────────────

export interface AgentMessageData {
	from: string;
	content: string;
	correlationId?: string;
	responseExpected: boolean;
}

export interface AgentCompleteData {
	id: string;
	status: "idle" | "failed";
	output?: string;
	error?: string;
	sessionId?: string;
	/**
	 * True iff an <agent_idle> notification was already delivered to the parent
	 * for this agent (i.e. it idled or crashed on its own). Used by teardown
	 * serializers to avoid re-emitting output the model has already seen.
	 */
	alreadyNotified?: boolean;
}

const RESURRECT_HINT_SINGLE = "Pass session_id to the resurrect tool to bring this agent back online with its prior conversation.";
const RESURRECT_HINT_GROUP = "Pass any session_id above to the resurrect tool to bring an agent back online with its prior conversation.";

export interface UsageData {
	input: string;
	output: string;
	cost: string;
}

export interface ActiveAgentsCompleteData {
	agents: AgentCompleteData[];
	usage: UsageData;
}

export interface PeerData {
	id: string;
	description?: string;
	isDefault?: boolean;
}

export interface SubagentIdentityData {
	id: string;
	task: string;
	peers: PeerData[];
}

function escapeXml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function serializeAgentMessage(data: AgentMessageData): string {
	const attrs: string[] = [`from="${escapeXml(data.from)}"`];
	if (data.correlationId) {
		attrs.push(`correlation_id="${escapeXml(data.correlationId)}"`);
	}
	attrs.push(`response_expected="${data.responseExpected ? "true" : "false"}"`);
	return `<agent_message ${attrs.join(" ")}>\n${data.content}\n</agent_message>`;
}

function serializeAgentForXml(agent: AgentCompleteData): string {
	const sessionAttr = agent.sessionId ? ` session_id="${escapeXml(agent.sessionId)}"` : "";
	const hint = agent.sessionId ? `<hint>${RESURRECT_HINT_SINGLE}</hint>\n` : "";
	if (agent.status === "failed") {
		const errorContent = agent.error ? `\n<error>${agent.error}</error>\n` : "";
		return `<agent_idle id="${escapeXml(agent.id)}" status="failed"${sessionAttr}>${errorContent}${hint}</agent_idle>`;
	}
	const output = agent.output ?? "(no output)";
	return `<agent_idle id="${escapeXml(agent.id)}" status="idle"${sessionAttr}>\n${output}\n${hint}</agent_idle>`;
}

export function serializeAgentComplete(data: AgentCompleteData): string {
	return serializeAgentForXml(data);
}

/**
 * Teardown report for a single agent. Distinct element name from <agent_idle>
 * so the model recognizes the lifecycle event. When the agent already idled
 * (alreadyNotified=true), output is omitted — the model has already seen it
 * via the prior <agent_idle> notification. When an agent is torn down while
 * still running (no prior idle notification), we still surface its last output
 * / error so it isn't lost.
 */
export function serializeAgentTorndown(data: AgentCompleteData): string {
	const sessionAttr = data.sessionId ? ` session_id="${escapeXml(data.sessionId)}"` : "";
	const hint = data.sessionId ? `<hint>${RESURRECT_HINT_SINGLE}</hint>` : "";
	const openTag = `<agent_torn_down id="${escapeXml(data.id)}" status="${data.status}"${sessionAttr}>`;
	if (data.alreadyNotified) {
		return hint ? `${openTag}\n${hint}\n</agent_torn_down>` : `${openTag}\n</agent_torn_down>`;
	}
	// Not yet notified — include body.
	const bodyParts: string[] = [];
	if (data.status === "failed") {
		if (data.error) bodyParts.push(`<error>${escapeXml(data.error)}</error>`);
	} else {
		bodyParts.push(data.output ?? "(no output)");
	}
	if (hint) bodyParts.push(hint);
	return `${openTag}\n${bodyParts.join("\n")}\n</agent_torn_down>`;
}

/**
 * Teardown report for the full agent group. Mirrors <group_complete> but uses
 * a distinct element so the model recognizes the lifecycle event. Per-agent
 * entries are slim by default (id/status/session_id) since each agent already
 * had an individual <agent_idle> notification when it settled. For any agent
 * that was torn down before it idled, its last output / error is included.
 */
export function serializeGroupTorndown(data: ActiveAgentsCompleteData): string {
	const summary = (() => {
		const counts: Record<string, number> = {};
		for (const a of data.agents) {
			counts[a.status] = (counts[a.status] || 0) + 1;
		}
		return Object.entries(counts)
			.map(([status, count]) => `${count} ${status}`)
			.join(", ");
	})();

	const lines: string[] = ["<group_torn_down>"];
	lines.push(`  <summary>${escapeXml(summary)}</summary>`);
	let anySessionId = false;
	for (const agent of data.agents) {
		const sessionAttr = agent.sessionId ? ` session_id="${escapeXml(agent.sessionId)}"` : "";
		if (agent.sessionId) anySessionId = true;
		if (agent.alreadyNotified) {
			lines.push(`  <agent id="${escapeXml(agent.id)}" status="${agent.status}"${sessionAttr} />`);
			continue;
		}
		// Not yet notified — include body so output/error isn't lost.
		lines.push(`  <agent id="${escapeXml(agent.id)}" status="${agent.status}"${sessionAttr}>`);
		if (agent.status === "failed") {
			if (agent.error) lines.push(`    <error>${escapeXml(agent.error)}</error>`);
		} else {
			lines.push(`    <output>${escapeXml(agent.output ?? "(no output)")}</output>`);
		}
		lines.push(`  </agent>`);
	}
	if (anySessionId) {
		lines.push(`  <hint>${RESURRECT_HINT_GROUP}</hint>`);
	}
	lines.push(`  <usage input="${escapeXml(data.usage.input)}" output="${escapeXml(data.usage.output)}" cost="${escapeXml(data.usage.cost)}" />`);
	lines.push("</group_torn_down>");
	return lines.join("\n");
}

export function serializeGroupComplete(data: ActiveAgentsCompleteData): string {
	const summary = (() => {
		const counts: Record<string, number> = {};
		for (const a of data.agents) {
			counts[a.status] = (counts[a.status] || 0) + 1;
		}
		return Object.entries(counts)
			.map(([status, count]) => `${count} ${status}`)
			.join(", ");
	})();

	const lines: string[] = ["<group_complete>"];
	lines.push(`  <summary>${escapeXml(summary)}</summary>`);
	let anySessionId = false;
	for (const agent of data.agents) {
		const sessionAttr = agent.sessionId ? ` session_id="${escapeXml(agent.sessionId)}"` : "";
		if (agent.sessionId) anySessionId = true;
		lines.push(`  <agent id="${escapeXml(agent.id)}" status="${agent.status}"${sessionAttr} />`);
	}
	if (anySessionId) {
		lines.push(`  <hint>${RESURRECT_HINT_GROUP}</hint>`);
	}
	lines.push(`  <usage input="${escapeXml(data.usage.input)}" output="${escapeXml(data.usage.output)}" cost="${escapeXml(data.usage.cost)}" />`);
	lines.push("</group_complete>");
	return lines.join("\n");
}

export function serializeSubagentIdentity(data: SubagentIdentityData): string {
	const lines: string[] = ["<subagent_identity>"];
	lines.push(`  <id>${escapeXml(data.id)}</id>`);
	lines.push(`  <task>${escapeXml(data.task)}</task>`);
	lines.push("");
	lines.push("  <peers>");
	for (const peer of data.peers) {
		const attrs: string[] = [`id="${escapeXml(peer.id)}"`];
		if (peer.isDefault) attrs.push(`default="true"`);
		if (peer.description) {
			lines.push(`    <peer ${attrs.join(" ")}>${escapeXml(peer.description)}</peer>`);
		} else {
			lines.push(`    <peer ${attrs.join(" ")} />`);
		}
	}
	lines.push("  </peers>");
	lines.push("");
	lines.push("  <protocol>");
	lines.push("    When you receive a message from another agent, it appears as:");
	lines.push('    <agent_message from="sender" correlation_id="abc-123" response_expected="true">');
	lines.push("    message content");
	lines.push("    </agent_message>");
	lines.push("");
	lines.push('    If response_expected="true", you MUST call the respond tool with that correlation_id.');
	lines.push('    If response_expected="false", the message is informational — no response needed.');
	lines.push("");
	lines.push("    Completion: your final output (last message before going idle) is automatically");
	lines.push("    delivered to parent via <agent_idle>. Do NOT call send to parent just to report");
	lines.push("    results — simply produce your final output and stop. Use send to parent only for");
	lines.push("    mid-task clarification or questions you need answered before you can continue.");
	lines.push("    Peer-to-peer communication with other agents still goes through send as normal.");
	lines.push("  </protocol>");
	lines.push("</subagent_identity>");
	return lines.join("\n");
}

// ─── Broker wire protocol types (JSONL over unix socket) ─────────────────────

export type BrokerRequest =
	| { type: "register"; agentId: string }
	| { type: "send"; from: string; to: string; message: string; correlationId?: string; expectResponse?: boolean }
	| { type: "respond"; from: string; correlationId: string; message: string };

export type BrokerResponse =
	| { type: "registered" }
	| { type: "message"; from: string; message: string; correlationId?: string; responseExpected?: boolean }
	| { type: "response"; correlationId: string; message: string }
	| { type: "send_ack" }
	| { type: "error"; correlationId?: string; error: string };
