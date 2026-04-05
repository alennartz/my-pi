import { execSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createRequire, globalPaths } from "node:module";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, SessionManager as SessionManagerType } from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem } from "@mariozechner/pi-tui";
import { getWorktreeArgumentCompletions, parseWorktreeCommand } from "./command-surface.ts";
import type {
	PendingChangesChoice,
	WorktreeDependencies,
	WorktreeInfo,
} from "./contracts.ts";
import { createWorktreeController } from "./controller.ts";

const require = createRequire(import.meta.url);
let cachedSessionManager: typeof SessionManagerType | undefined;

function getPackageResolutionPaths(): string[] {
	const paths = new Set<string>([process.cwd(), ...globalPaths]);
	const nodePathEntries = process.env.NODE_PATH?.split(delimiter).filter(Boolean) ?? [];
	for (const entry of nodePathEntries) {
		paths.add(entry);
	}

	const execPrefix = dirname(dirname(process.execPath));
	paths.add(join(execPrefix, "lib", "node_modules"));
	paths.add(join(execPrefix, "lib", "node"));

	try {
		const npmRoot = execSync("npm root -g", { encoding: "utf8" }).trim();
		if (npmRoot) {
			paths.add(npmRoot);
		}
	} catch {
		// Ignore npm resolution failures and fall back to the static search paths above.
	}

	const packageRoots = new Set<string>();
	for (const basePath of paths) {
		packageRoots.add(join(basePath, "@mariozechner", "pi-coding-agent"));
		packageRoots.add(join(basePath, "node_modules", "@mariozechner", "pi-coding-agent"));
	}

	return [...packageRoots];
}

function loadSessionManager(): typeof SessionManagerType {
	if (cachedSessionManager) {
		return cachedSessionManager;
	}
	for (const packageRoot of getPackageResolutionPaths()) {
		if (!existsSync(join(packageRoot, "package.json"))) {
			continue;
		}
		try {
			cachedSessionManager = require(packageRoot).SessionManager as typeof SessionManagerType;
			return cachedSessionManager;
		} catch {
			continue;
		}
	}
	throw new Error("Could not resolve @mariozechner/pi-coding-agent for worktree session management");
}

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

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function runGit(args: string[], cwd: string): string {
	const output = execSync(`git ${args.map(shellQuote).join(" ")}`, {
		cwd,
		encoding: "utf8",
	});
	return (typeof output === "string" ? output : String(output ?? "")).trim();
}

function runGitVoid(args: string[], cwd: string): void {
	execSync(`git ${args.map(shellQuote).join(" ")}`, {
		cwd,
		encoding: "utf8",
	});
}

function resolveRepoRoot(cwd: string): string {
	try {
		return runGit(["rev-parse", "--show-toplevel"], cwd) || cwd;
	} catch {
		return cwd;
	}
}

function parseWorktreeList(output: string): WorktreeInfo[] {
	const entries: Array<{ path?: string; branch?: string }> = [];
	let current: { path?: string; branch?: string } = {};

	const pushCurrent = () => {
		if (!current.path) {
			return;
		}
		entries.push(current);
		current = {};
	};

	for (const line of output.split(/\r?\n/)) {
		if (!line) {
			pushCurrent();
			continue;
		}
		if (line.startsWith("worktree ")) {
			pushCurrent();
			current.path = line.slice("worktree ".length);
			continue;
		}
		if (line.startsWith("branch ")) {
			current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
		}
	}

	pushCurrent();

	return entries.map((entry, index) => ({
		path: entry.path!,
		branch: entry.branch ?? "",
		isMain: index === 0,
	}));
}

async function chooseContextTransfer(ctx: ExtensionCommandContext) {
	const options = [
		"Bring current context — fork this persisted session into the new worktree",
		"Start fresh — create a clean session in the new worktree",
	];
	const selection = await ctx.ui.select(
		"Bring the current session context into the new worktree?",
		options,
	);
	if (selection === undefined) {
		return undefined;
	}
	return selection === options[0] ? "bring-context" : "fresh-session";
}

async function choosePendingChanges(ctx: ExtensionCommandContext): Promise<PendingChangesChoice | undefined> {
	const options = [
		"Bring changes — stash tracked changes here and reapply them in the new worktree",
		"Leave changes behind — create the worktree without moving current tracked changes",
	];
	const selection = await ctx.ui.select("Bring tracked changes into the new worktree?", options);
	if (selection === undefined) {
		return undefined;
	}
	return selection === options[0] ? "bring-changes" : "leave-changes";
}

function createGitClient() {
	return {
		async listWorktrees(cwd: string) {
			return parseWorktreeList(runGit(["worktree", "list", "--porcelain"], cwd));
		},
		async getCurrentBranch(cwd: string) {
			return runGit(["branch", "--show-current"], cwd);
		},
		async getStatusPorcelain(cwd: string) {
			return runGit(["status", "--porcelain"], cwd);
		},
		async stashPush(cwd: string) {
			const output = runGit(["stash", "push", "--message", "pi-worktree-transfer"], cwd);
			return output !== "No local changes to save";
		},
		async stashPop(cwd: string) {
			runGitVoid(["stash", "pop"], cwd);
		},
		async addWorktree(input: { cwd: string; path: string; branchName: string; baseBranch: string }) {
			mkdirSync(dirname(input.path), { recursive: true });
			runGitVoid([
				"worktree",
				"add",
				input.path,
				"-b",
				input.branchName,
				input.baseBranch,
			], input.cwd);
		},
		async removeWorktree(input: { cwd: string; worktreePath: string }) {
			runGitVoid(["worktree", "remove", input.worktreePath], input.cwd);
		},
		async deleteBranch(input: { cwd: string; branchName: string; force: boolean }) {
			runGitVoid(["branch", input.force ? "-D" : "-d", input.branchName], input.cwd);
		},
	};
}

function createDependencies(pi: ExtensionAPI, ctx: ExtensionCommandContext): WorktreeDependencies {
	const commandCwd = ctx.cwd ?? process.cwd();
	const repoRoot = resolveRepoRoot(commandCwd);
	const sessionDir = ctx.sessionManager?.getSessionDir?.();
	const currentSessionFile = ctx.sessionManager?.getSessionFile?.();

	return {
		env: {
			cwd: repoRoot,
			homeDirectory: process.env.HOME ?? homedir(),
			repoName: basename(repoRoot),
			currentSessionFile,
		},
		git: createGitClient(),
		sessions: {
			async continueRecent(cwd: string) {
				const SessionManager = loadSessionManager();
				return SessionManager.continueRecent(cwd, sessionDir).getSessionFile();
			},
			async create(cwd: string) {
				const SessionManager = loadSessionManager();
				const sessionFile = SessionManager.create(cwd, sessionDir).getSessionFile();
				if (!sessionFile) {
					throw new Error(`Failed to create a persisted session for ${cwd}`);
				}
				return sessionFile;
			},
			async forkFrom(sourceSessionPath: string, targetCwd: string) {
				const SessionManager = loadSessionManager();
				const sessionFile = SessionManager.forkFrom(sourceSessionPath, targetCwd, sessionDir).getSessionFile();
				if (!sessionFile) {
					throw new Error(`Failed to fork a persisted session into ${targetCwd}`);
				}
				return sessionFile;
			},
		},
		agent: {
			async sendMergeInstruction(message: string) {
				pi.sendUserMessage(message);
			},
		},
		runtime: {
			chooseContextTransfer: () => chooseContextTransfer(ctx),
			choosePendingChanges: () => choosePendingChanges(ctx),
			notify(message, level) {
				ctx.ui.notify(message, level);
			},
			async waitForIdle() {
				if (typeof ctx.waitForIdle === "function") {
					await ctx.waitForIdle();
				}
			},
			async switchSession(sessionFile: string) {
				if (typeof ctx.switchSession === "function") {
					return ctx.switchSession(sessionFile);
				}
				return { cancelled: false };
			},
		},
	};
}

function toAutocompleteItems(items: ReturnType<typeof getWorktreeArgumentCompletions>): AutocompleteItem[] | null {
	return items ? items.map((item) => ({ value: item.value, label: item.label })) : null;
}

export default function worktreeExtension(pi: ExtensionAPI) {
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

			const controller = createWorktreeController(createDependencies(pi, ctx));
			if (parsed.command.kind === "create") {
				await controller.create(parsed.command.request);
				return;
			}

			await controller.cleanup(parsed.command.request);
		},
	});
}
