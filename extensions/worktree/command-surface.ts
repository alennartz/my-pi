import { join } from "node:path";
import {
	WORKTREE_ROOT_DIRECTORY_NAME,
	type WorktreeAutocompleteItem,
	type WorktreeCleanupRequest,
	type WorktreeCreateRequest,
} from "./contracts.ts";

const SUBCOMMANDS = ["create", "cleanup"] as const;

export type ParsedWorktreeCommand =
	| {
		ok: true;
		command:
			| {
				kind: "create";
				request: WorktreeCreateRequest;
			}
			| {
				kind: "cleanup";
				request: WorktreeCleanupRequest;
			};
	}
	| {
		ok: false;
		message: string;
	};

export function resolveWorktreePath(homeDirectory: string, repoName: string, branchName: string): string {
	return join(homeDirectory, WORKTREE_ROOT_DIRECTORY_NAME, repoName, branchName);
}

export function buildCleanupMergePrompt(
	branchName: string,
	mergeTarget: string,
	mainWorktreePath: string,
): string {
	return [
		`Merge the branch \`${branchName}\` into \`${mergeTarget}\`.`,
		`The merge must happen in the main worktree at \`${mainWorktreePath}\` (the current worktree has \`${branchName}\` checked out, so it cannot also have \`${mergeTarget}\` checked out).`,
		`Run git from there using \`git -C ${mainWorktreePath} ...\` (e.g. \`git -C ${mainWorktreePath} checkout ${mergeTarget} && git -C ${mainWorktreePath} merge --no-ff ${branchName}\`).`,
		"Use bash tool calls to perform the merge. If conflicts appear, resolve them naturally in the session before finishing.",
		"Do not delete the worktree or branch — the /worktree cleanup command will do that after verifying the merge landed.",
	].join("\n");
}

export function parseWorktreeCommand(args: string): ParsedWorktreeCommand {
	const tokens = args.trim().split(/\s+/).filter(Boolean);

	if (tokens.length === 0) {
		return {
			ok: false,
			message: "Usage: /worktree <create|cleanup> ...",
		};
	}

	const [subcommand, ...rest] = tokens;

	if (subcommand === "create") {
		if (rest.length === 0 || rest.length > 2) {
			return {
				ok: false,
				message: "Usage: /worktree create <branch-name> [base-branch]",
			};
		}

		const [branchName, baseBranch] = rest;
		return {
			ok: true,
			command: {
				kind: "create",
				request: { branchName, baseBranch },
			},
		};
	}

	if (subcommand === "cleanup") {
		if (rest.length > 1) {
			return {
				ok: false,
				message: "Usage: /worktree cleanup [merge-target]",
			};
		}

		return {
			ok: true,
			command: {
				kind: "cleanup",
				// Leave undefined when not supplied so the controller can resolve
				// the repo's actual default branch at runtime.
				request: { mergeTarget: rest[0] },
			},
		};
	}

	return {
		ok: false,
		message: "Usage: /worktree <create|cleanup> ...",
	};
}

export function getWorktreeArgumentCompletions(prefix: string, branches: string[]): WorktreeAutocompleteItem[] | null {
	const hasTrailingSpace = /\s$/.test(prefix);
	const tokens = prefix.trim().split(/\s+/).filter(Boolean);

	if (tokens.length === 0) {
		return filterAutocompleteItems(SUBCOMMANDS, "");
	}

	const [subcommand, ...rest] = tokens;

	if (tokens.length === 1 && !hasTrailingSpace) {
		return filterAutocompleteItems(SUBCOMMANDS, subcommand);
	}

	if (subcommand === "create") {
		if (rest.length === 0) {
			return mapAutocompleteItems(branches);
		}
		if (rest.length === 1) {
			return filterAutocompleteItems(branches, hasTrailingSpace ? "" : rest[0]);
		}
		if (rest.length === 2) {
			return filterAutocompleteItems(branches, hasTrailingSpace ? "" : rest[1]);
		}
		return null;
	}

	if (subcommand === "cleanup") {
		if (rest.length === 0) {
			return mapAutocompleteItems(branches);
		}
		if (rest.length === 1) {
			return filterAutocompleteItems(branches, hasTrailingSpace ? "" : rest[0]);
		}
		return null;
	}

	return null;
}

function filterAutocompleteItems(items: readonly string[], prefix: string): WorktreeAutocompleteItem[] | null {
	const filtered = items.filter((item) => item.startsWith(prefix));
	return filtered.length > 0 ? mapAutocompleteItems(filtered) : null;
}

function mapAutocompleteItems(items: readonly string[]): WorktreeAutocompleteItem[] {
	return items.map((item) => ({ value: item, label: item }));
}
