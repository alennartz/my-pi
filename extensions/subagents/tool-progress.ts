import type { SubagentJsonValue } from "@pimote/sdk/subagents";

/**
 * The last `onUpdate` details of each running subagent tool call in one root
 * tree, so a view that attaches mid-call shows current state.
 */
export class RunningToolProgress {
	private readonly entries = new Map<string, SubagentJsonValue>();

	set(sessionId: string, toolCallId: string, details: SubagentJsonValue): void {
		this.entries.set(progressKey(sessionId, toolCallId), details);
	}

	clear(sessionId: string, toolCallId: string): void {
		this.entries.delete(progressKey(sessionId, toolCallId));
	}

	get(input: Readonly<{ sessionId: string; toolCallId: string }>): SubagentJsonValue | undefined {
		return this.entries.get(progressKey(input.sessionId, input.toolCallId));
	}
}

function progressKey(sessionId: string, toolCallId: string): string {
	return JSON.stringify([sessionId, toolCallId]);
}
