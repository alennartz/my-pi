import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { ToolscriptClient } from "./client.ts";

export default function (pi: ExtensionAPI) {
	let client: ToolscriptClient | null = null;
	let startPromise: Promise<void> | null = null;
	let instructions: string | null = null;
	let disposed = false;

	pi.on("session_start", async (_event, ctx) => {
		disposed = false;
		const c = new ToolscriptClient(ctx.cwd);
		client = c;

		// Fire-and-forget: launch the MCP stack but do NOT block session startup
		// on it. The boot (process spawn + MCP handshake + upstream server boot)
		// runs in the background. Whenever it resolves, pi appends the tool
		// registrations and the instructions section to the transcript as delta
		// system messages before the next model request, so a boot landing
		// mid-session is recorded too — the race with the user's first message
		// only affects latency, not correctness.
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

			// Upstream server instructions become a dedicated prompt section (see
			// before_agent_start below), independent of whether the server exposes
			// any tools.
			instructions = result.instructions?.trim() || null;

			for (let i = 0; i < result.tools.length; i++) {
				const mcpTool = result.tools[i];
				const toolName = "toolscript_" + mcpTool.name;

				pi.registerTool({
					name: toolName,
					label: "Toolscript: " + mcpTool.name,
					description: mcpTool.description,
					promptSnippet: mcpTool.description,
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

	// Upstream server instructions ride in a dedicated prompt section rather
	// than a tool guideline: they exist independently of the tool list, and a
	// named section lets pi record them as a sections delta system message
	// whenever the async boot delivers them. Re-setting the same value every
	// turn is free — pi diffs sections and only appends real changes.
	pi.on("before_agent_start", (event) => {
		if (instructions) {
			event.systemPromptOptions.sections.toolscript = instructions;
		}
	});

	pi.on("session_shutdown", async () => {
		disposed = true;
		const c = client;
		client = null;
		instructions = null;

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
