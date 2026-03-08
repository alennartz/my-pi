import { readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

const ARTIFACT_DIRS = ["docs/brainstorms", "docs/plans", "docs/reviews", "docs/decisions"];

/**
 * Scan artifact directories and return a formatted inventory string.
 * Lists .md files found in each directory, grouped by directory.
 * Missing directories produce "(none)" rather than errors.
 */
export function getArtifactInventory(): string {
	return ARTIFACT_DIRS.map((dir: string) => {
		const fullPath = join(process.cwd(), dir);
		let files: string[];
		try {
			files = readdirSync(fullPath).filter((f) => f.endsWith(".md"));
		} catch {
			files = [];
		}
		const listing = files.length > 0 ? files.join(", ") : "(none)";
		return `${dir}/: ${listing}`;
	}).join("\n");
}

/**
 * Run `git status --porcelain` and return a formatted block for prompt injection.
 * Returns a clean message if the working tree is clean, or the porcelain output
 * with a recommendation if there are uncommitted changes.
 */
export function getGitStatus(): string {
	try {
		const output = execSync("git status --porcelain", { cwd: process.cwd(), encoding: "utf-8" }).trim();
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
			"Recommend to the user that these be dealt with before proceeding (committed, stashed, or discarded) so the workflow starts from a clean slate.",
		].join("\n");
	} catch {
		return "Could not determine git status (not a git repo or git not available).";
	}
}
