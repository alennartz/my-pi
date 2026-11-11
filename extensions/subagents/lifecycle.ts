import type { AgentPath } from "./agent-path.js";
import type { PersistencePaths } from "./persistence.js";

/** Durable lifecycle/topology facts projected from my-pi's existing records. */
export type SubagentLifecycleRecordKind =
	| "node_added"
	| "node_updated"
	| "node_removed"
	| "completion"
	| "interrupt"
	| "teardown"
	| "resurrect";

export type SubagentLifecycleRecord = Readonly<{
	recordId: string;
	timestamp: string;
	kind: SubagentLifecycleRecordKind;
	path: AgentPath;
	sessionId?: string;
	previousSessionId?: string;
	sessionFile?: string;
	data?: unknown;
}>;

/** Read-only view of append-only lifecycle and child-session persistence. */
export interface SubagentLifecycleReader {
	read(): readonly SubagentLifecycleRecord[];
}

/** Existing persistence is the source; this seam does not create a second journal. */
export function createSubagentLifecycleReader(_paths: PersistencePaths): SubagentLifecycleReader {
	throw new Error("not implemented");
}
