import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { TSchema } from "@sinclair/typebox";
import { ToolscriptClient } from "./client.js";

export default function (pi: ExtensionAPI) {
	let client: ToolscriptClient | null = null;

	pi.on("session_start", async (_event, ctx) => {
		client = new ToolscriptClient(ctx.cwd);

		let result;
		try {
			result = await client.start();
		} catch (err: any) {
			ctx.ui.notify("Toolscript not available: " + err.message, "info");
			client = null;
			return;
		}

		for (let i = 0; i < result.tools.length; i++) {
			const mcpTool = result.tools[i];
			const toolName = "toolscript_" + mcpTool.name;

			pi.registerTool({
				name: toolName,
				label: "Toolscript: " + mcpTool.name,
				description: mcpTool.description,
				promptSnippet: mcpTool.description,
				promptGuidelines: i === 0 && result.instructions ? [result.instructions] : undefined,
				parameters: mcpTool.inputSchema as TSchema,
				async execute(_toolCallId, params) {
					const r = await client!.callTool(mcpTool.name, params as Record<string, unknown>);
					return {
						content: [{ type: "text" as const, text: r.content }],
						details: { isError: r.isError },
					};
				},
			});
		}

		ctx.ui.notify("Toolscript: " + result.tools.length + " tools registered", "info");
	});

	pi.on("session_shutdown", async () => {
		if (client) {
			await client.stop();
			client = null;
		}
	});
}
