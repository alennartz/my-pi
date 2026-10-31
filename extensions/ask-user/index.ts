import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registerLooseTool } from "../../lib/tool-args.ts";
import { showAskUser } from "../../lib/components/ask-user.ts";

export default function (pi: ExtensionAPI) {
	registerLooseTool(pi, {
		name: "ask_user",
		label: "Ask User",
		// Interactive tool — no-UI loadouts exclude model-only tools, and the
		// exposure blocks nested calls through codemode and ctx.executeTool.
		exposure: "model-only",
		description:
			"Show a single-select list of 1 to 9 options, each with an optional description. Returns the chosen label, its option number, and any annotation. Returns a cancelled result if the user dismisses the list. Title must be 160 characters or less.",
		promptSnippet: "Ask the user to choose one option from up to 9.",
		promptGuidelines: ["Always prefer ask_user over asking a question in plain prose."],
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

			const result = await showAskUser(ctx, params.title, params.options);

			if (result === undefined) {
				return {
					content: [{ type: "text" as const, text: "User cancelled the selection." }],
					details: { cancelled: true },
				};
			}

			const parts = [`Selected: ${result.label} (option ${result.index + 1})`];
			if (result.annotation) {
				parts.push(`Annotation: ${result.annotation}`);
			}

			// No outputSchema: model-only tools never run in codemode, so structuredContent has no audience.
			return {
				content: [{ type: "text" as const, text: parts.join("\n") }],
				details: {
					label: result.label,
					index: result.index,
					...(result.annotation !== undefined && { annotation: result.annotation }),
				},
			};
		},
	});
}
