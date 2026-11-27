/**
 * Structured message formats for inter-agent communication.
 *
 * LLM-facing messages use XML serialization.
 */

// LLM-facing XML types and serializers

export interface AgentMessageData {
	from: string;
	content: string;
	correlationId?: string;
	responseExpected: boolean;
}

export interface AgentCompleteData {
	id: string;
	/**
	 * `idle` and `errored` both describe a settled agent with a live session — a
	 * send revives either. `dead` is terminal: the runtime is gone.
	 */
	status: "idle" | "errored" | "dead";
	output?: string;
	error?: string;
	sessionId?: string;
	/** This completion replaced an undelivered one, so its content answers nothing. */
	replaced?: true;
}

const RETRY_HINT = "Its session is still alive: if you have cleared the cause, send it a message to retry. Use teardown + resurrect only if it cannot recover.";
const RESURRECT_HINT_SINGLE = "Pass session_id to the resurrect tool to bring this agent back online with its prior conversation.";
const RESURRECT_HINT_GROUP = "Pass any session_id above to the resurrect tool to bring an agent back online with its prior conversation.";
const REPLACED_HINT = "This result may not be the one you are waiting for: the agent started a new run while the user held its earlier result, so that earlier result never arrived. Ask the agent to repeat what it meant to send you if you need it.";

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
	peers: PeerData[];
}

export function serializeAgentMessage(data: AgentMessageData): string {
	const attrs: string[] = [`from="${data.from}"`];
	if (data.correlationId) {
		attrs.push(`correlation_id="${data.correlationId}"`);
	}
	attrs.push(`response_expected="${data.responseExpected ? "true" : "false"}"`);
	return `<agent_message ${attrs.join(" ")}>\n${data.content}\n</agent_message>`;
}

export function serializeAgentComplete(agent: AgentCompleteData): string {
	const sessionAttr = agent.sessionId ? ` session_id="${agent.sessionId}"` : "";
	const hint = agent.sessionId ? `<hint>${RESURRECT_HINT_SINGLE}</hint>\n` : "";
	const replaced = agent.replaced ? `<note>${REPLACED_HINT}</note>\n` : "";
	if (agent.status === "errored") {
		const errorContent = agent.error ? `\n<error>${agent.error}</error>\n` : "";
		return `<agent_idle id="${agent.id}" status="errored"${sessionAttr}>${errorContent}${replaced}<hint>${RETRY_HINT}</hint>\n</agent_idle>`;
	}
	if (agent.status === "dead") {
		const errorContent = agent.error ? `\n<error>${agent.error}</error>\n` : "";
		return `<agent_idle id="${agent.id}" status="dead"${sessionAttr}>${errorContent}${replaced}${hint}</agent_idle>`;
	}
	const output = agent.output ?? "(no output)";
	return `<agent_idle id="${agent.id}" status="idle"${sessionAttr}>\n${output}\n${replaced}${hint}</agent_idle>`;
}

/**
 * Teardown report for a single agent. Distinct element name from <agent_idle>
 * so the model recognizes the lifecycle event. Results the agent held back
 * from the parent are reported separately by the caller.
 */
export function serializeAgentTorndown(data: AgentCompleteData): string {
	const sessionAttr = data.sessionId ? ` session_id="${data.sessionId}"` : "";
	const hint = data.sessionId ? `<hint>${RESURRECT_HINT_SINGLE}</hint>` : "";
	const openTag = `<agent_torn_down id="${data.id}" status="${data.status}"${sessionAttr}>`;
	return hint ? `${openTag}\n${hint}\n</agent_torn_down>` : `${openTag}\n</agent_torn_down>`;
}

export interface AgentLifecycleNoticeData {
	id: string;
	sessionId?: string;
	task?: string;
	model?: string;
}

/** The user brought an agent back from a saved session outside of a tool call. */
export function serializeAgentResurrected(data: AgentLifecycleNoticeData): string {
	const sessionAttr = data.sessionId ? ` session_id="${data.sessionId}"` : "";
	const lines: string[] = [`<agent_resurrected id="${data.id}"${sessionAttr}>`];
	if (data.task) {lines.push(`  <task>${data.task}</task>`);}
	if (data.model) {lines.push(`  <model>${data.model}</model>`);}
	lines.push(`  <hint>The user restored this agent from its saved session. It is live again and working on its task.</hint>`, "</agent_resurrected>");
	return lines.join("\n");
}

/** The user removed a live agent manually, outside of a tool call. */
export function serializeAgentRemoved(data: AgentLifecycleNoticeData & { heldOutput?: string }): string {
	const sessionAttr = data.sessionId ? ` session_id="${data.sessionId}"` : "";
	const held = data.heldOutput !== undefined ? `<held_result>\n${data.heldOutput}\n</held_result>\n` : "";
	return `<agent_removed id="${data.id}"${sessionAttr}>\n${held}<hint>The user removed this agent manually. Its saved session stays available through the resurrect tool.</hint>\n</agent_removed>`;
}

/** One requested child as an `await_agents` result reports it. */
export type AwaitStatusData = Readonly<{
	id: string;
	state: "running" | "waiting" | "idle" | "errored" | "dead" | "stopped" | "held" | "removed";
	output?: string;
	error?: string;
	sessionId?: string;
	replaced?: boolean;
}>;

/** The model-facing text for one requested child of an await. */
export function serializeAwaitStatus(status: AwaitStatusData): string {
	const sessionAttr = status.sessionId ? ` session_id="${status.sessionId}"` : "";
	const replaced = status.replaced ? `<note>${REPLACED_HINT}</note>\n` : "";
	switch (status.state) {
		case "idle":
		case "errored":
		case "dead":
			return serializeAgentComplete({
				id: status.id,
				status: status.state,
				output: status.output,
				error: status.error,
				sessionId: status.sessionId,
				...(status.replaced ? { replaced: true } : undefined),
			});
		case "stopped":
			return `<agent_stopped id="${status.id}"${sessionAttr}>\n${replaced}<hint>The user stopped this agent before it finished. It produced no result. Its session is idle; send it a message to continue.</hint>\n</agent_stopped>`;
		case "removed": {
			const held = status.output !== undefined ? `<held_result>\n${status.output}\n</held_result>\n` : "";
			return `<agent_removed id="${status.id}"${sessionAttr}>\n${held}<hint>This agent was removed while you waited. Its saved session stays available through the resurrect tool.</hint>\n</agent_removed>`;
		}
		case "held":
			return `<agent_held id="${status.id}">\n<hint>The user holds this agent's result. It reaches you when the user releases the hold.</hint>\n</agent_held>`;
		default:
			return `<agent_pending id="${status.id}" status="${status.state}" />`;
	}
}

/**
 * Shared group-report serializer for <group_torn_down> and <group_complete>.
 * The two reports differ only in element name. Entries stay slim
 * (id/status/session_id): a torn-down agent's last output is never reported.
 */
function serializeGroupReport(data: ActiveAgentsCompleteData, opts: { elementName: string }): string {
	const counts: Record<string, number> = {};
	for (const a of data.agents) {
		counts[a.status] = (counts[a.status] || 0) + 1;
	}
	const summary = Object.entries(counts)
		.map(([status, count]) => `${count} ${status}`)
		.join(", ");

	const lines: string[] = [`<${opts.elementName}>`];
	lines.push(`  <summary>${summary}</summary>`);
	let anySessionId = false;
	for (const agent of data.agents) {
		const sessionAttr = agent.sessionId ? ` session_id="${agent.sessionId}"` : "";
		if (agent.sessionId) {anySessionId = true;}
		lines.push(`  <agent id="${agent.id}" status="${agent.status}"${sessionAttr} />`);
	}
	if (anySessionId) {
		lines.push(`  <hint>${RESURRECT_HINT_GROUP}</hint>`);
	}
	lines.push(`  <usage input="${data.usage.input}" output="${data.usage.output}" cost="${data.usage.cost}" />`, `</${opts.elementName}>`);
	return lines.join("\n");
}

/**
 * Teardown report for the full agent group. Mirrors <group_complete> but uses
 * a distinct element so the model recognizes the lifecycle event. Entries are
 * slim (id/status/session_id); a torn-down agent's last output is never
 * reported.
 */
export function serializeGroupTorndown(data: ActiveAgentsCompleteData): string {
	return serializeGroupReport(data, { elementName: "group_torn_down" });
}

export function serializeGroupComplete(data: ActiveAgentsCompleteData): string {
	return serializeGroupReport(data, { elementName: "group_complete" });
}

export function serializeSubagentIdentity(data: SubagentIdentityData): string {
	const lines: string[] = ["<subagent_identity>"];
	lines.push(`  <id>${data.id}</id>`, "", "  <peers>");
	for (const peer of data.peers) {
		const attrs: string[] = [`id="${peer.id}"`];
		if (peer.isDefault) {attrs.push(`default="true"`);}
		if (peer.description) {
			lines.push(`    <peer ${attrs.join(" ")}>${peer.description}</peer>`);
		} else {
			lines.push(`    <peer ${attrs.join(" ")} />`);
		}
	}
	lines.push(
		"  </peers>",
		"",
		"  <protocol>",
		"    When you receive a message from another agent, it appears as:",
		'    <agent_message from="sender" correlation_id="abc-123" response_expected="true">',
		"    message content",
		"    </agent_message>",
		"",
		'    If response_expected="true", you MUST call the respond tool with that correlation_id.',
		'    If response_expected="false", the message is informational — no response needed.',
		"",
		"    Completion: your final output (last message before going idle) is automatically",
		"    delivered to parent via <agent_idle>. Do not use send as a completion or",
		"    reporting channel, and never send a completed-task summary to parent just to",
		"    report results. Put the complete result in your final output and stop; do not",
		"    duplicate it in a send message. Use send only for mid-task clarification or",
		"    coordination. Peer-to-peer communication still goes through send as needed.",
		"  </protocol>",
		"</subagent_identity>",
	);
	return lines.join("\n");
}

