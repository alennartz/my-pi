import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { ToolscriptClient } from "./client.ts";

export default function (pi: ExtensionAPI) {
	let client: ToolscriptClient | null = null;
	let startPromise: Promise<void> | null = null;
	let disposed = false;

	pi.on("session_start", async (_event, ctx) => {
		disposed = false;
		const c = new ToolscriptClient(ctx.cwd);
		client = c;

		// Fire-and-forget: launch the MCP stack but do NOT block session startup
		// on it. The boot (process spawn + MCP handshake + upstream server boot)
		// runs in the background. When it resolves we register the tools, which
		// pi refreshes immediately so they appear in the system prompt from the
		// next turn onward. In practice the boot finishes before the user sends
		// their first message, so the tools are listed correctly by then.
		startPromise = (async () => {
			let result;
			try {
				result = await c.start();
			} catch {
				// Boot failed — stop the client before forgetting it, otherwise a
				// child process spawned during the failed boot would leak (shutdown
				// only stops the client it can still see).
				await c.stop().catch(() => {});
				if (client === c) client = null;
				return;
			}

			// The session may have been torn down or replaced (e.g. /new) while we
			// were booting. Don't register tools into a dead session; shutdown owns
			// stopping the client.
			if (disposed || client !== c) {
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
						const r = await c.callTool(mcpTool.name, params as Record<string, unknown>);
						return {
							content: [{ type: "text" as const, text: r.content }],
							details: { isError: r.isError },
						};
					},
				});
			}
		})();
	});

	pi.on("session_shutdown", async () => {
		disposed = true;
		const c = client;
		client = null;

		// Wait for any in-flight boot to settle so we never leak an orphaned child
		// process. This may briefly block shutdown if a session is torn down mid-boot,
		// but blocking shutdown is far less disruptive than blocking startup.
		const p = startPromise;
		startPromise = null;
		if (p) await p.catch(() => {});

		if (c) {
			await c.stop().catch(() => {});
		}
	});
}
