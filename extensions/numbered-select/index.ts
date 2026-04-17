import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { showNumberedSelect } from "../../lib/components/numbered-select.ts";

export default function (pi: ExtensionAPI) {
	// Skip registering ask_user in subagent child processes — they have no
	// interactive UI and shouldn't prompt the user directly. Subagents detect
	// their role via PI_PARENT_LINK (set by the subagents extension).
	if (process.env.PI_PARENT_LINK) return;

	pi.registerTool({
		name: "ask_user",
		label: "Ask User",
		description:
			"Ask the user to pick exactly one option from a set (up to 9). Single-select only — the user chooses one option and may attach an optional free-text annotation. Returns the single selected option and optional annotation, or indicates cancellation. Do NOT use this to collect multiple selections; for multi-select, ask in a regular message instead.",
		promptSnippet: "Present the user with a structured single-choice prompt of up to 9 options. Use when there are discrete alternatives to choose between — disambiguation, confirming a direction, or selecting from a generated list. The user picks exactly one option (single-select only) and may add an optional free-text annotation. This tool does NOT support multi-selection — if you need multiple picks, ask in a regular message.",
		parameters: Type.Object({
			title: Type.String({ description: "The prompt or question to display" }),
			options: Type.Array(
				Type.Object({
					label: Type.String({ description: "Display label for this option" }),
					description: Type.Optional(Type.String({ description: "Optional description shown after the label" })),
				}),
				{ description: "Options to present (1–9 items)", minItems: 1, maxItems: 9 },
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				throw new Error("ask_user requires an interactive terminal.");
			}

			if (params.title.length > 160) {
				throw new Error(
					"Title must be 160 characters or less. If you need to provide more context, send it as a regular message first, then follow up with the ask_user tool call.",
				);
			}

			const result = await showNumberedSelect(ctx, params.title, params.options);

			if (result === undefined) {
				return {
					content: [{ type: "text" as const, text: "User cancelled the selection." }],
				};
			}

			const parts = [`Selected: ${result.label} (option ${result.index + 1})`];
			if (result.annotation) {
				parts.push(`Annotation: ${result.annotation}`);
			}

			return {
				content: [{ type: "text" as const, text: parts.join("\n") }],
			};
		},
	});
}
