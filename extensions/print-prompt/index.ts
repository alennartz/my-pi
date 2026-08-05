import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

export default function (pi: ExtensionAPI) {
	pi.registerEntryRenderer("print-prompt", (entry, { expanded }, theme) => {
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		const data = entry.data as { text: string };
		box.addChild(new Text(theme.bold("System Prompt"), 0, 0));
		box.addChild(new Text(data.text, 0, 0));
		return box;
	});

	pi.registerCommand("sysprompt", {
		description: "Print the full rendered system prompt",
		handler: async (_args, ctx) => {
			const prompt = ctx.getSystemPrompt();
			ctx.ui.notify(`System prompt: ${prompt.length} chars`, "info");
			pi.appendEntry("print-prompt", { text: prompt });
		},
	});
}
