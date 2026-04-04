import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const IDLE_MARKER = "session-idle";
const RESUME_MESSAGE = "session-resumed";

function sessionEndsWithIdleMarker(ctx: any): boolean {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i] as any;
		if (entry.type === "custom" && entry.customType === IDLE_MARKER) return true;
		if (entry.type === "message" || entry.type === "custom_message" || entry.type === "tool_call" || entry.type === "tool_result" || entry.type === "thinking") {
			return false;
		}
	}
	return true;
}

export default function (pi: ExtensionAPI) {
	pi.on("agent_end", async () => {
		pi.appendEntry(IDLE_MARKER, { at: new Date().toISOString() });
	});

	pi.on("session_start", async (_event, ctx) => {
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!sessionFile) return;
		const entries = ctx.sessionManager.getEntries();
		if (entries.length === 0) return;
		if (sessionEndsWithIdleMarker(ctx)) return;

		pi.appendEntry(RESUME_MESSAGE, { at: new Date().toISOString() });
		pi.sendMessage(
			{ customType: RESUME_MESSAGE, content: "[session resumed]", display: false },
			{ triggerTurn: true },
		);
	});
}
