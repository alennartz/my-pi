import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { showNumberedSelect } from "../../lib/components/numbered-select.ts";

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_user",
		label: "Ask User",
		description:
			"Ask the user to choose from a set of options (up to 9). The user can also annotate their choice with a free-text note. Returns the selected option and optional annotation, or indicates cancellation.",
		promptSnippet: "Present the user with a structured choice of up to 9 options. Use when there are discrete alternatives to choose between — disambiguation, confirming a direction, or selecting from a generated list. Supports optional free-text annotation on the selection.",
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
