import { readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

const ARTIFACT_DIRS = ["docs/brainstorms", "docs/plans", "docs/reviews", "docs/decisions"];

/**
 * Scan artifact directories and return a formatted inventory string.
 * Lists .md files found in each directory, grouped by directory.
 * Missing directories produce "(none)" rather than errors.
 */
/** Directories where we only care about the count, not individual filenames */
const COUNT_ONLY_DIRS = new Set(["docs/decisions"]);

export function getArtifactInventory(cwd: string): string {
	return ARTIFACT_DIRS.map((dir: string) => {
		const fullPath = join(cwd, dir);
		let files: string[];
		try {
			files = readdirSync(fullPath).filter((f) => f.endsWith(".md"));
		} catch {
			files = [];
		}
		let listing: string;
		if (files.length === 0) {
			listing = "(none)";
		} else if (COUNT_ONLY_DIRS.has(dir)) {
			listing = `${files.length} decision record${files.length === 1 ? "" : "s"}`;
		} else {
			listing = files.join(", ");
		}
		return `${dir}/: ${listing}`;
	}).join("\n");
}

/**
 * Run `git status --porcelain` and return a formatted block for prompt injection.
 * Returns a clean message if the working tree is clean, or the porcelain output
 * with a recommendation if there are uncommitted changes.
 */
export function getGitStatus(cwd: string): string {
	try {
		const output = execSync("git status --porcelain", { cwd, encoding: "utf-8" }).trim();
		if (!output) {
			return "Clean — no uncommitted changes.";
		}
		return [
			"The working tree has uncommitted changes:",
			"",
			"```",
			output,
			"```",
			"",
			"Stop and ask the user how they want to handle these before proceeding. Present options (e.g. commit, stash, ignore) and wait for their choice.",
		].join("\n");
	} catch {
		return "Could not determine git status (not a git repo or git not available).";
	}
}
