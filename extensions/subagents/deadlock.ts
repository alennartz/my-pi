/**
 * Directed graph of pending blocking sends for deadlock detection.
 *
 * Each edge: agent A is blocked waiting for agent B.
 * Before routing a blocking send from A to B, check wouldCauseCycle(A, B).
 * If true, the send would create a deadlock and should be rejected.
 */

export class DeadlockGraph {
	/** from → set of targets it's waiting on */
	private edges = new Map<string, Set<string>>();

	addEdge(from: string, to: string): void {
		let targets = this.edges.get(from);
		if (!targets) {
			targets = new Set();
			this.edges.set(from, targets);
		}
		targets.add(to);
	}

	removeEdge(from: string, to: string): void {
		const targets = this.edges.get(from);
		if (targets) {
			targets.delete(to);
			if (targets.size === 0) this.edges.delete(from);
		}
	}

	/** Remove all edges pointing TO target (used when agent dies). */
	removeAllEdgesTo(target: string): void {
		for (const [from, targets] of this.edges) {
			targets.delete(target);
			if (targets.size === 0) this.edges.delete(from);
		}
	}

	/**
	 * Check if adding edge from→to would create a cycle.
	 * DFS from `to` looking for `from`. Does NOT add the edge.
	 */
	wouldCauseCycle(from: string, to: string): boolean {
		if (from === to) return true;

		const visited = new Set<string>();
		const stack = [to];

		while (stack.length > 0) {
			const current = stack.pop()!;
			if (current === from) return true;
			if (visited.has(current)) continue;
			visited.add(current);

			const targets = this.edges.get(current);
			if (targets) {
				for (const next of targets) {
					if (!visited.has(next)) stack.push(next);
				}
			}
		}

		return false;
	}
}
