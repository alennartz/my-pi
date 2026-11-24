/**
 * Workspace rows for multi-repo autoflow runs.
 *
 * A plan carries a `## Workspace` table when the run spans more than one
 * repository. Everything here is skipped when that section is absent, so a
 * single-repo plan keeps the behaviour it had before this module existed.
 */

import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";

export interface Result {
	passed: boolean;
	detail: string;
}

export type RepoShape = "local" | "symlink" | "worktree-detached";

export interface WorkspaceRow {
	repo: string;
	path: string;
	shape: RepoShape;
	testBase?: string;
	implBase?: string;
}

/** The two Git facts a row needs, injected so tests stay hermetic. */
export interface GitProbe {
	/** True when `rev` resolves to a commit inside the repository at `repoPath`. */
	isCommit(repoPath: string, rev: string): boolean;
	/** True when `HEAD` is contained by a branch ref inside the repository at `repoPath`. */
	headReachable(repoPath: string): boolean;
}

const shapes = new Set<string>(["local", "symlink", "worktree-detached"]);
const columnCount = 5;

function cells(line: string): string[] {
	const trimmed = line.trim();
	const inner = trimmed.startsWith("|") ? trimmed.slice(1) : trimmed;
	const withoutTail = inner.endsWith("|") ? inner.slice(0, -1) : inner;
	return withoutTail.split("|").map((cell) => cell.trim());
}

function isSeparator(line: string): boolean {
	return /^\|[\s:|-]+\|?\s*$/.test(line.trim()) && line.includes("-");
}

function rowFromCells(row: string[]): WorkspaceRow | string {
	if (row.length !== columnCount) {
		return `row "${row.join(" | ")}" must have ${columnCount} columns: repo, path, shape, test-base, impl-base`;
	}
	const [repo, path, shape, testBase, implBase] = row;
	if (!repo || !path || !shape) {
		return `row "${repo ?? ""}" needs a repo, a path, and a shape`;
	}
	if (!shapes.has(shape)) {
		return `row "${repo}" has shape "${shape}"; use local, symlink, or worktree-detached`;
	}
	return {
		repo,
		path,
		shape: shape as RepoShape,
		testBase: testBase || undefined,
		implBase: implBase || undefined,
	};
}

/**
 * Returns the rows of the plan's `## Workspace` section.
 *
 * `null` means the plan has no such section, which makes the run single-repo.
 * A string is a diagnostic describing a malformed section.
 */
export function parseWorkspaceRows(content: string): WorkspaceRow[] | string | null {
	const heading = /^## Workspace\s*$/m.exec(content);
	if (!heading || heading.index === undefined) {return null;}

	const remainder = content.slice(heading.index + heading[0].length);
	const nextHeading = remainder.match(/\n#{1,2}\s/);
	const section = nextHeading?.index !== undefined ? remainder.slice(0, nextHeading.index) : remainder;

	const tableLines = section.split(/\r?\n/).filter((line) => line.trim().startsWith("|"));
	if (tableLines.length === 0) {
		return "the section must contain one table row per repository";
	}

	const body = tableLines.filter((line, index) => index > 0 && !isSeparator(line));
	const rows: WorkspaceRow[] = [];
	for (const line of body) {
		const row = rowFromCells(cells(line));
		if (typeof row === "string") {return row;}
		rows.push(row);
	}

	if (rows.length === 0) {
		return "the section must contain one table row per repository";
	}
	if (new Set(rows.map((row) => row.repo)).size !== rows.length) {
		return "each repository id appears only once";
	}
	return rows;
}

function pathProblem(path: string): string | null {
	try {
		if (!statSync(path).isDirectory()) {return `${path} is not a directory`;}
	} catch {
		return `${path} does not exist`;
	}
	return null;
}

/**
 * Validates the workspace table itself. Returns `null` when the plan carries no
 * workspace section.
 */
export function checkWorkspaceRows(rows: WorkspaceRow[] | string | null): Result | null {
	if (rows === null) {return null;}
	if (typeof rows === "string") {
		return { passed: false, detail: `Workspace section is invalid: ${rows}.` };
	}

	for (const row of rows) {
		const problem = pathProblem(row.path);
		if (problem) {return { passed: false, detail: `Workspace row "${row.repo}": ${problem}.` };}
	}
	return { passed: true, detail: `${rows.length} workspace repositor${rows.length === 1 ? "y" : "ies"} declared.` };
}

/**
 * Validates the Git facts behind a well-formed table: every recorded base is a
 * real commit, and every detached worktree member sits on a branch.
 */
export function checkWorkspaceGit(rows: WorkspaceRow[], probe: GitProbe): Result {
	for (const row of rows) {
		for (const [column, base] of [
			["test-base", row.testBase],
			["impl-base", row.implBase],
		] as const) {
			if (!base) {continue;}
			if (!probe.isCommit(row.path, base)) {
				return {
					passed: false,
					detail: `Workspace row "${row.repo}" names ${column} ${base}, which is not a commit in ${row.path}.`,
				};
			}
		}
		if (row.shape === "worktree-detached" && !probe.headReachable(row.path)) {
			return {
				passed: false,
				detail: `Workspace row "${row.repo}" is detached with no branch holding HEAD. Create a branch before the next commit, or the hub cannot be disbanded.`,
			};
		}
	}
	return { passed: true, detail: "Workspace bases resolve and detached members sit on a branch." };
}

export function createGitProbe(): GitProbe {
	return {
		isCommit(repoPath, rev) {
			try {
				execFileSync("git", ["-C", repoPath, "rev-parse", "--verify", "--quiet", `${rev}^{commit}`], {
					stdio: "ignore",
				});
				return true;
			} catch {
				return false;
			}
		},
		headReachable(repoPath) {
			try {
				const out = execFileSync(
					"git",
					[
						"-C",
						repoPath,
						"for-each-ref",
						"--contains",
						"HEAD",
						"--count=1",
						"--format=%(refname)",
						"refs/heads",
						"refs/remotes",
					],
					{ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
				);
				return out.trim().length > 0;
			} catch {
				return false;
			}
		},
	};
}
