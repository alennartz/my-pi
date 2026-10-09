import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { planRunBinding } from "../persona-workspaces/index.js";
import { loadWorkspacePersona } from "../persona-workspaces/declaration.js";
import { getSubagentPersona } from "../subagents/child-session-marker.js";

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
		description: "Print the last agent-turn system prompt (or the projected prompt before the first turn)",
		handler: async (_args, ctx) => {
			const rendered = lastRenderedPrompt !== undefined;
			let prompt = lastRenderedPrompt ?? ctx.getSystemPrompt();
			if (!rendered) {
				prompt = projectPersonaPreamble(prompt, {
					cwd: ctx.cwd,
					sessionManager: ctx.sessionManager,
					customPrompt: ctx.getSystemPromptOptions?.().customPrompt,
				});
			}
			const label = rendered ? "System" : "Base";
			ctx.ui.notify(`${label} prompt: ${prompt.length} chars`, "info");
			pi.appendEntry("print-prompt", { text: prompt });
		},
	});
}

/**
 * Before the first run, the base prompt has not been through
 * `before_agent_start`, so an active persona is not yet bound into it — pi
 * hands handlers a fresh copy of the options each run and offers no
 * session-level prompt seam. Project what the first turn will use instead:
 * swap the leading preamble (the untagged head before the first section tag)
 * for the persona body, behind a label. The decision mirrors
 * persona-workspaces exactly via its pure `planRunBinding`, including the
 * `--system-prompt` yield: an explicit user prompt leaves the base untouched.
 */
function projectPersonaPreamble(
	base: string,
	input: { cwd: string; sessionManager: object; customPrompt: string | undefined },
): string {
	const plan = planRunBinding({
		workspace: loadWorkspacePersona(input.cwd),
		spawned: getSubagentPersona(input.sessionManager),
		explicitCustomPrompt: input.customPrompt,
		continuation: true, // projection only; never plans a notice
		transcript: [],
	});
	if (!plan) return base;
	const cut = base.indexOf("\n<");
	const projected = cut === -1 ? plan.customPrompt : `${plan.customPrompt}${base.slice(cut)}`;
	return `[projected — persona binds at the first turn]\n\n${projected}`;
}
