import { execSync } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem } from "@mariozechner/pi-tui";
import { getWorktreeArgumentCompletions, parseWorktreeCommand } from "./command-surface.ts";
import { createWorktreeController } from "./controller.ts";

function listGitBranches(cwd: string): string[] {
	try {
		const output = execSync("git branch --list --format='%(refname:short)'", {
			cwd,
			encoding: "utf8",
		});
		return output.split("\n").map((line) => line.trim()).filter(Boolean);
	} catch {
		return [];
	}
}

function toAutocompleteItems(items: ReturnType<typeof getWorktreeArgumentCompletions>): AutocompleteItem[] | null {
	return items ? items.map((item) => ({ value: item.value, label: item.label })) : null;
}

export default function worktreeExtension(pi: ExtensionAPI) {
	const controller = createWorktreeController();

	pi.registerCommand("worktree", {
		description: "Create, resume, and clean up git worktree sessions",
		getArgumentCompletions: (prefix) => {
			return toAutocompleteItems(getWorktreeArgumentCompletions(prefix, listGitBranches(process.cwd())));
		},
		handler: async (args, ctx) => {
			const parsed = parseWorktreeCommand(args);
			if (!parsed.ok) {
				ctx.ui.notify(parsed.message, "warning");
				return;
			}

			if (parsed.command.kind === "create") {
				await controller.create(parsed.command.request);
				return;
			}

			await controller.cleanup(parsed.command.request);
		},
	});
}
