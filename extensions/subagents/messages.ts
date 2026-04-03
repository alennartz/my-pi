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
}

export interface UsageData {
	input: string;
	output: string;
	cost: string;
}

export interface GroupCompleteData {
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
	if (agent.status === "failed") {
		const errorContent = agent.error ? `\n<error>${agent.error}</error>\n` : "";
		return `<agent_complete id="${escapeXml(agent.id)}" status="failed">${errorContent}</agent_complete>`;
	}
	const output = agent.output ?? "(no output)";
	return `<agent_complete id="${escapeXml(agent.id)}" status="idle">\n${output}\n</agent_complete>`;
}

export function serializeAgentComplete(data: AgentCompleteData): string {
	return serializeAgentForXml(data);
}

export function serializeGroupComplete(data: GroupCompleteData): string {
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
	for (const agent of data.agents) {
		lines.push(`  <agent id="${escapeXml(agent.id)}" status="${agent.status}" />`);
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
	lines.push("    delivered to parent via <agent_complete>. Do NOT call send to parent just to report");
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
