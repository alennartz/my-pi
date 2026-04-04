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
 * "parent" can send to any active agent.
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
 * Validate that all channel references resolve to currently known agent ids.
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
 * Add new agents to an existing topology in place.
 *
 * For each new agent: if its id is in `forkIds`, set targets to all
 * `existingIds` + "parent" (parent-equivalent access); otherwise, set
 * targets to declared channels + "parent" (same logic as buildTopology).
 * All new agent IDs are added to parent's target set.
 *
 * Validates that declared channels reference either existing IDs or other
 * new IDs in the batch. Throws on violation.
 */
export function addToTopology(
	topology: Topology,
	agents: AgentChannelSpec[],
	existingIds: Set<string>,
	forkIds: Set<string>,
): void {
	const newIds = new Set(agents.map((a) => a.id));

	// Validate: declared channels must reference existing or new-batch IDs
	for (const agent of agents) {
		if (!agent.channels) continue;
		for (const target of agent.channels) {
			if (!existingIds.has(target) && !newIds.has(target)) {
				throw new Error(`Agent "${agent.id}" references unknown peer "${target}"`);
			}
		}
	}

	// Add new agents' entries
	for (const agent of agents) {
		if (forkIds.has(agent.id)) {
			// Fork agents get parent-equivalent access: all existing + same-batch IDs + parent
			const targets = new Set<string>(existingIds);
			for (const id of newIds) {
				if (id !== agent.id) targets.add(id);
			}
			targets.add("parent");
			topology.set(agent.id, targets);
		} else {
			const targets = new Set<string>(agent.channels ?? []);
			targets.add("parent");
			topology.set(agent.id, targets);
		}
	}

	// Add all new IDs to parent's target set
	const parentTargets = topology.get("parent");
	if (parentTargets) {
		for (const id of newIds) {
			parentTargets.add(id);
		}
	}
}

/**
 * Remove an agent from the topology.
 *
 * Deletes the agent's entry and removes it from all remaining agents'
 * target sets (including parent's).
 */
export function removeFromTopology(topology: Topology, agentId: string): void {
	topology.delete(agentId);
	for (const [, targets] of topology) {
		targets.delete(agentId);
	}
}

/**
 * Runtime check: can `from` send to `to`?
 */
export function canSend(topology: Topology, from: string, to: string): boolean {
	const allowed = topology.get(from);
	if (!allowed) return false;
	return allowed.has(to);
}
