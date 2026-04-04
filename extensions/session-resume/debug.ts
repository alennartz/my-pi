import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		const header = ctx.sessionManager.getHeader();
		const entries = ctx.sessionManager.getEntries();
		const branch = ctx.sessionManager.getBranch();
		console.log("[session-resume-debug]", JSON.stringify({
			sessionFile: ctx.sessionManager.getSessionFile(),
			header,
			entriesLength: entries.length,
			branchLength: branch.length,
			leafId: ctx.sessionManager.getLeafId?.(),
			firstEntry: entries[0],
			lastEntry: entries[entries.length - 1],
		}, null, 2));
		ctx.shutdown();
	});
}
