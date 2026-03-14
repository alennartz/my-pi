/**
 * Topology validation and runtime channel enforcement.
 *
 * Agents declare which peers they can send to. Parent ("parent") is
 * auto-injected into every agent's channel list. Parent can send to any agent.
 */

/** agentId → set of allowed target ids */
export type Topology = Map<string, Set<string>>;

export interface AgentChannelSpec {
	id: string;
	channels?: string[];
}

/**
 * Build a topology map from agent declarations.
 * Each agent can send to its declared channels + "parent".
 * "parent" can send to any agent in the group.
 */
export function buildTopology(agents: AgentChannelSpec[]): Topology {
	const topology: Topology = new Map();
	const allIds = new Set(agents.map((a) => a.id));

	for (const agent of agents) {
		const targets = new Set<string>(agent.channels ?? []);
		targets.add("parent");
		topology.set(agent.id, targets);
	}

	// Parent can send to any agent
	topology.set("parent", new Set(allIds));

	return topology;
}

/**
 * Validate that all channel references resolve to agent ids in the group.
 * Returns an error message if invalid, null if valid.
 * Disconnected agents (empty channels) are allowed.
 */
export function validateTopology(agents: AgentChannelSpec[]): string | null {
	const allIds = new Set(agents.map((a) => a.id));
	const errors: string[] = [];

	for (const agent of agents) {
		if (!agent.channels) continue;
		for (const target of agent.channels) {
			if (!allIds.has(target)) {
				errors.push(`Agent "${agent.id}" references unknown peer "${target}"`);
			}
		}
	}

	return errors.length > 0 ? errors.join("; ") : null;
}

/**
 * Runtime check: can `from` send to `to`?
 */
export function canSend(topology: Topology, from: string, to: string): boolean {
	const allowed = topology.get(from);
	if (!allowed) return false;
	return allowed.has(to);
}
