import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

export const PROJECT_PROMPTS_DIRECTORY = ".pi/prompts";

/**
 * A compact learning scaffold for Pi prompt templates. The body demonstrates
 * every documented argument form while staying useful when invoked unchanged.
 */
const PROMPT_TEMPLATE_SEED = [
	"---",
	"description: prompt-description",
	"argument-hint: \"<required-argument> [optional-arguments...]\"",
	"---",
	"first-argument: \"$1\"",
	"second-argument: \"$2\"",
	"all-arguments: \"$@\" / \"$ARGUMENTS\"",
	"first-argument-or-default: \"${1:-default-value}\"",
	"all-arguments-or-default: \"${@:-default-value}\" / \"${ARGUMENTS:-default-value}\"",
	"arguments-from-index-2: \"${@:2}\"",
	"two-arguments-from-index-2: \"${@:2:2}\"",
	"",
].join("\n");

const PROMPT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Return the safe prompt basename from `/nprompt` arguments. */
export function parsePromptName(args: string): string | undefined {
	const trimmed = args.trim();
	if (!trimmed || /\s/.test(trimmed)) return undefined;

	const name = trimmed.endsWith(".md") ? trimmed.slice(0, -3) : trimmed;
	if (!PROMPT_NAME_PATTERN.test(name)) return undefined;
	return name;
}

/** Resolve the project-local prompt template path for a command name. */
export function promptTemplatePath(cwd: string, name: string): string {
	return resolve(cwd, PROJECT_PROMPTS_DIRECTORY, `${name}.md`);
}

function isMissingFile(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export default function newPrompt(pi: ExtensionAPI): void {
	pi.registerCommand("nprompt", {
		description: "Create a project prompt template in the built-in editor",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				throw new Error("nprompt requires an interactive terminal.");
			}

			const name = parsePromptName(args);
			if (!name) {
				ctx.ui.notify("Usage: /nprompt <name>", "warning");
				return;
			}

			const path = promptTemplatePath(ctx.cwd, name);
			const title = relative(resolve(ctx.cwd), path);
			let prefill = PROMPT_TEMPLATE_SEED;
			try {
				prefill = await readFile(path, "utf-8");
			} catch (error) {
				if (!isMissingFile(error)) throw error;
			}

			const edited = await ctx.ui.editor(title, prefill);
			if (edited === undefined) {
				ctx.ui.notify(`Cancelled ${title}`, "info");
				return;
			}

			await withFileMutationQueue(path, async () => {
				await mkdir(dirname(path), { recursive: true });
				await writeFile(path, edited, "utf-8");
			});

			ctx.ui.notify(`Saved ${title}. Run /reload to use /${name}.`, "info");
		},
	});
}
