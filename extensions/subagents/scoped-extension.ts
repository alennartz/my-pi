import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { MessagePort } from "./message-router.js";

/** Identity and communication scope injected into a child session. */
export type SubagentScope =
	| { kind: "root" }
	| {
			kind: "child";
			identity: {
				id: string;
				task: string;
				channels: string[];
				/**
				 * Subagents-extension tool policy inherited from the persona. This is
				 * independent from the SDK-wide child-tool allowlist.
				 */
				tools?: string[];
			};
			uplink: MessagePort;
		};

/**
 * Build the subagents extension for a root session or one in-process child.
 *
 * A child receives explicit identity and parent linkage rather than discovering
 * role information through process-wide environment variables.
 */
export function createSubagentsExtension(_scope: SubagentScope): ExtensionFactory {
	throw new Error("not implemented");
}
