import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

export default function (pi: ExtensionAPI) {
	// `before_agent_start` handlers finish before `agent_start`, so this is the
	// first lifecycle point at which the prompt is guaranteed to include every
	// extension's per-turn system-prompt modification. Keep that exact string
	// for `/sysprompt`; the command itself bypasses the prompt lifecycle.
	let lastRenderedPrompt: string | undefined;
	pi.on("agent_start", (_event, ctx) => {
		lastRenderedPrompt = ctx.getSystemPrompt();
	});

	pi.registerEntryRenderer("print-prompt", (entry, { expanded }, theme) => {
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		const data = entry.data as { text: string };
		box.addChild(new Text(theme.bold("System Prompt"), 0, 0));
		box.addChild(new Text(data.text, 0, 0));
		return box;
	});

	pi.registerCommand("sysprompt", {
		description: "Print the last agent-turn system prompt (or the base prompt before the first turn)",
		handler: async (_args, ctx) => {
			const rendered = lastRenderedPrompt !== undefined;
			const prompt = lastRenderedPrompt ?? ctx.getSystemPrompt();
			ctx.ui.notify(`${rendered ? "System" : "Base"} prompt: ${prompt.length} chars`, "info");
			pi.appendEntry("print-prompt", { text: prompt });
		},
	});
}
