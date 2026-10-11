import type { AgentOperationalSnapshot } from "./agent-session-registry.js";

/**
 * Pimote idle-reap responder: does this tree hold live background work?
 *
 * Pimote's reaper closes sessions that sit idle past its timeout with no
 * connected client. The root session cannot see in-process subagents, so the
 * subagents extension answers pimote's synchronous activity poll from the
 * registry snapshot (DR-054). Pimote learns only the boolean.
 *
 * Flat approximation of recursive liveness:
 * - `running` anywhere is live.
 * - A `waiting` agent is live unless its wait grounds in the root session.
 *   Immediate children addressing the reserved id "parent" wait on the root
 *   pi session — parked on the user, covered by the root's own idle signal.
 *   Deeper agents' "parent" is an in-tree agent, so their waits count as
 *   live without walking the chain.
 * - `idle`, `errored`, and `dead` are settled or terminal, never live.
 *
 * The failure direction is asymmetric — a false "active" parks the session
 * (recoverable by explicit close) while a false "idle" destroys work — so
 * ambiguity resolves toward live.
 */

/** Minimal structural view of a registry node for the activity predicate. */
export interface ActivityNode {
	readonly path: readonly unknown[];
	readonly operational: {
		readonly state: AgentOperationalSnapshot["state"];
		readonly waitingFor: readonly string[];
	};
}

/** True when closing the tree these nodes describe would destroy live work. */
export function hasLiveBackgroundWork(nodes: readonly ActivityNode[]): boolean {
	return nodes.some((node) => {
		if (node.operational.state === "running") return true;
		if (node.operational.state !== "waiting") return false;
		if (node.path.length > 1) return true;
		return node.operational.waitingFor.some((target) => target !== "parent");
	});
}
