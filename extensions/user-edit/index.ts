import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFile, writeFile, mkdir } from "fs/promises";
import { resolve, dirname } from "path";

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "user_edit",
		label: "User Edit",
		// Interactive tool — no-UI loadouts exclude model-only tools, and the
		// exposure blocks nested calls through codemode and ctx.executeTool.
		exposure: "model-only",
		description:
			"Open a file in the built-in editor for the user to edit manually. The user can modify the content and save, or cancel. Returns whether the file was saved or the edit was cancelled. Creates the file on save if it does not exist.",
		promptSnippet: "Open a file in the built-in editor for the user to edit, save, or cancel.",
		parameters: Type.Object({
			path: Type.String({ description: "File path to open for editing, resolved relative to the working directory" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				throw new Error("user_edit requires an interactive terminal.");
			}

			// Strip leading @ (model quirk normalization)
			const rawPath = params.path.replace(/^@/, "");

			// Resolve to absolute path against cwd
			const absolutePath = resolve(ctx.cwd, rawPath);

			// Read existing content, or empty string for new files
			let content: string;
			try {
				content = await readFile(absolutePath, "utf-8");
			} catch (err: any) {
				if (err.code === "ENOENT") {
					content = "";
				} else {
					throw err;
				}
			}

			// Open editor — use raw path as title so user sees what the LLM asked for
			const result = await ctx.ui.editor(rawPath, content);

			if (result === undefined) {
				return {
					content: [{ type: "text" as const, text: `User cancelled editing ${rawPath}` }],
					details: { path: absolutePath, saved: false },
				};
			}

			// Write the edited content within the file mutation queue
			await withFileMutationQueue(absolutePath, async () => {
				await mkdir(dirname(absolutePath), { recursive: true });
				await writeFile(absolutePath, result, "utf-8");
			});

			// No outputSchema: model-only tools never run in codemode, so structuredContent has no audience.
			return {
				content: [{ type: "text" as const, text: `User saved ${rawPath}` }],
				details: { path: absolutePath, saved: true },
			};
		},
	});
}
