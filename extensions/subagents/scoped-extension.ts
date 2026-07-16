import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { AgentPath } from "./agent-path.js";
import type { AgentSessionRegistry } from "./agent-session-registry.js";
import type { MessagePort } from "./message-router.js";

/** Identity and communication scope injected into a child session. */
export type SubagentScope =
	| { kind: "root" }
	| {
			kind: "child";
			registry: AgentSessionRegistry;
			path: AgentPath;
			identity: {
				id: string;
				task: string;
				channels: string[];
			};
			uplink: MessagePort;
		};

/**
 * Build the subagents extension for a root session or one in-process child.
 *
 * A child receives explicit identity, registry ownership, and parent linkage
 * rather than discovering role information through process-wide environment
 * variables.
 */
export function createSubagentsExtension(_scope: SubagentScope): ExtensionFactory {
	throw new Error("not implemented");
}
