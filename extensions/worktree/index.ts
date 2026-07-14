import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
	CURRENT_SESSION_VERSION,
	SessionManager,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type SessionHeader,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { getWorktreeArgumentCompletions, isWorktreePath, parseWorktreeCommand } from "./command-surface.ts";
import type {
	PendingChangesChoice,
	WorktreeDependencies,
	WorktreeInfo,
} from "./contracts.ts";
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

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function runGit(args: string[], cwd: string): string {
	try {
		// stdio: capture stderr instead of letting git print it through to pi's
		// TUI (stash-pop conflicts, worktree refusals would otherwise overwrite
		// the UI). On failure we surface the captured stderr via the thrown error.
		return execSync(`git ${args.map(shellQuote).join(" ")}`, {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
	} catch (error) {
		const stderr = (error as { stderr?: string }).stderr;
		if (stderr && stderr.trim()) {
			throw new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`, { cause: error });
		}
		throw error;
	}
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
			runGit(["stash", "pop"], cwd);
		},
		async branchExists(input: { cwd: string; branchName: string }) {
			try {
				execSync(
					`git show-ref --verify --quiet ${shellQuote(`refs/heads/${input.branchName}`)}`,
					{ cwd: input.cwd, stdio: ["ignore", "ignore", "ignore"] },
				);
				return true;
			} catch {
				return false;
			}
		},
		async addWorktree(input: {
			cwd: string;
			path: string;
			branchName: string;
			baseBranch: string;
			createBranch: boolean;
		}) {
			mkdirSync(dirname(input.path), { recursive: true });
			const args = input.createBranch
				? ["worktree", "add", input.path, "-b", input.branchName, input.baseBranch]
				: ["worktree", "add", input.path, input.branchName];
			runGit(args, input.cwd);
		},
		async removeWorktree(input: { cwd: string; worktreePath: string }) {
			runGit(["worktree", "remove", input.worktreePath], input.cwd);
		},
		async deleteBranch(input: { cwd: string; branchName: string; force: boolean }) {
			runGit(["branch", input.force ? "-D" : "-d", input.branchName], input.cwd);
		},
		async isAncestor(input: { cwd: string; ancestor: string; descendant: string }) {
			try {
				execSync(
					`git merge-base --is-ancestor ${shellQuote(input.ancestor)} ${shellQuote(input.descendant)}`,
					{ cwd: input.cwd, encoding: "utf8", stdio: ["ignore", "ignore", "ignore"] },
				);
				return true;
			} catch {
				// Exit 1 = not an ancestor; any other failure (bad ref, etc.) is
				// also "not provably merged", which is the safe answer here.
				return false;
			}
		},
		async detectDefaultBranch(cwd: string) {
			// 1. origin/HEAD if a remote default is configured.
			try {
				const symbolic = runGit(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd);
				if (symbolic.startsWith("origin/")) {
					const name = symbolic.slice("origin/".length);
					if (name) return name;
				}
			} catch {
				// no origin/HEAD; fall through
			}
			// 2. init.defaultBranch from git config.
			try {
				const configured = runGit(["config", "--get", "init.defaultBranch"], cwd);
				if (configured) {
					const exists = listGitBranches(cwd).includes(configured);
					if (exists) return configured;
				}
			} catch {
				// no config; fall through
			}
			// 3. probe common names locally.
			const branches = listGitBranches(cwd);
			for (const candidate of ["main", "master", "trunk", "develop"]) {
				if (branches.includes(candidate)) return candidate;
			}
			return undefined;
		},
	};
}

export function createSessionGateway(sessionDir: string | undefined): WorktreeDependencies["sessions"] {
	return {
		async continueRecent(cwd: string) {
			const session = SessionManager.continueRecent(cwd, sessionDir);
			const sessionFile = session?.getSessionFile();
			// When no recent session exists, SessionManager.continueRecent falls
			// back to a fresh, lazily persisted session — its file is not on disk
			// yet, so switching into it would land in process.cwd() (see create()).
			// Treat it as "no recent session" so the caller routes to create().
			return sessionFile && existsSync(sessionFile) ? sessionFile : undefined;
		},
		async create(cwd: string) {
			const manager = SessionManager.create(cwd, sessionDir);
			const sessionFile = manager.getSessionFile();
			if (!sessionFile) {
				throw new Error(`Failed to create a persisted session for ${cwd}`);
			}
			// pi persists sessions lazily — nothing is written to disk until the
			// first assistant message. But `switchSession` resolves the session's
			// cwd from the file header, and a missing file silently falls back to
			// process.cwd(), landing the fresh session in whatever directory the
			// pi process was launched from. Write the header eagerly so the
			// switch reads the worktree cwd.
			const header: SessionHeader = {
				type: "session",
				version: CURRENT_SESSION_VERSION,
				id: manager.getSessionId(),
				timestamp: new Date().toISOString(),
				cwd: manager.getCwd(),
			};
			writeFileSync(sessionFile, `${JSON.stringify(header)}\n`, { flag: "wx" });
			return sessionFile;
		},
		async forkFrom(sourceSessionPath: string, targetCwd: string) {
			const manager = SessionManager.forkFrom(sourceSessionPath, targetCwd, sessionDir);
			// The forked history is saturated with absolute paths from the old
			// checkout; without an explicit notice, the agent tends to keep using
			// them and operates on the wrong worktree. Appending this message as
			// the newest context entry counteracts that.
			manager.appendCustomMessageEntry(
				"worktree:moved",
				`This session has been moved into a different git worktree. Your working directory is now ${targetCwd}. ` +
					"The bash tool's default working directory has been switched accordingly — commands run there without any `cd`, so omit `cd` and use relative paths. " +
					"Absolute paths mentioned earlier in this conversation refer to a different checkout — do not use them and do not `cd` to them.",
				true,
			);
			const sessionFile = manager.getSessionFile();
			if (!sessionFile) {
				throw new Error(`Failed to fork a persisted session into ${targetCwd}`);
			}
			return sessionFile;
		},
		async discard(sessionFile: string) {
			// Best-effort: the source session is fully duplicated by `forkFrom`,
			// so deleting it just removes the redundant copy. Other historical
			// session files in the same directory are intentionally left behind.
			await rm(sessionFile, { force: true });
		},
	};
}

function createDependencies(
	ctx: ExtensionCommandContext,
	sendUserMessageAndAwaitTurn: (message: string) => Promise<void>,
): WorktreeDependencies {
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
		sessions: createSessionGateway(sessionDir),
		agent: {
			sendMergeInstruction: sendUserMessageAndAwaitTurn,
		},
		runtime: {
			chooseContextTransfer: () => chooseContextTransfer(ctx),
			choosePendingChanges: () => choosePendingChanges(ctx),
			notify(message, level) {
				ctx.ui.notify(message, level);
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
	// Auto-trust worktree directories. A worktree is a checkout of a repo the
	// user already trusted, so switching cwd into one on `/worktree create`
	// should not re-prompt for project trust. Other paths fall through
	// ("undecided") to pi's normal trust resolution.
	pi.on("project_trust", (event) => {
		const home = process.env.HOME ?? homedir();
		if (isWorktreePath(event.cwd, home)) {
			return { trusted: "yes", remember: false };
		}
		return { trusted: "undecided" };
	});

	// --- Reliable wait-for-agent-turn ---
	//
	// `pi.sendUserMessage` is fire-and-forget from the extension's perspective:
	// the runner wraps the underlying async send as `(...).catch(...)` without
	// returning the promise. Calling any "is the agent idle?" probe immediately
	// after therefore races — the queued message may not yet have transitioned
	// the agent into a streaming state.
	//
	// Instead we observe `agent_start` / `agent_end` events. We pre-arm the
	// start barrier BEFORE sending so the start event can't fire and be missed,
	// then wait for the matching end event. This works as long as the command
	// handler runs while the agent is idle (which is when slash commands fire).
	let agentRunning = false;
	const startWaiters: Array<() => void> = [];
	const endWaiters: Array<() => void> = [];

	pi.on("agent_start", () => {
		agentRunning = true;
		const pending = startWaiters.splice(0);
		for (const resolve of pending) resolve();
	});
	pi.on("agent_end", () => {
		agentRunning = false;
		const pending = endWaiters.splice(0);
		for (const resolve of pending) resolve();
	});

	async function sendUserMessageAndAwaitTurn(message: string): Promise<void> {
		// This helper assumes the caller is running OUTSIDE an agent turn — i.e.
		// from a slash-command handler, which pi dispatches before kicking off
		// `agent.prompt`. If we're somehow already inside a turn (e.g. invoked
		// from a tool call), waiting for `agent_end` would deadlock: the current
		// turn cannot end until the tool returns, and the tool is us. Fail loud
		// rather than hang.
		if (agentRunning) {
			throw new Error(
				"worktree: sendUserMessageAndAwaitTurn called while an agent turn is in flight. " +
					"This helper must run from a slash-command handler, not from inside a tool call.",
			);
		}
		// Arm BOTH barriers before firing so we can't miss `agent_start`.
		const startBarrier = new Promise<void>((resolve) => startWaiters.push(resolve));
		const endBarrier = new Promise<void>((resolve) => endWaiters.push(resolve));
		pi.sendUserMessage(message);
		await startBarrier;
		await endBarrier;
	}

	pi.registerCommand("worktree", {
		description: "Create, resume, and clean up git worktree sessions",
		// NOTE: pi's `getArgumentCompletions` is passed only the prefix — there is
		// no `ctx`, so we cannot resolve `ctx.cwd` here the way the handler does.
		// We fall back to `process.cwd()`. After a session switch into a worktree,
		// the runtime cwd and `process.cwd()` can diverge, so branch completions
		// may be listed from the original repo rather than the active worktree.
		// Unavoidable until the completions API exposes the command context.
		getArgumentCompletions: (prefix) => {
			return toAutocompleteItems(getWorktreeArgumentCompletions(prefix, listGitBranches(process.cwd())));
		},
		handler: async (args, ctx) => {
			const parsed = parseWorktreeCommand(args);
			if (!parsed.ok) {
				ctx.ui.notify(parsed.message, "warning");
				return;
			}

			const controller = createWorktreeController(
				createDependencies(ctx, sendUserMessageAndAwaitTurn),
			);
			if (parsed.command.kind === "create") {
				await controller.create(parsed.command.request);
				return;
			}

			await controller.cleanup(parsed.command.request);
		},
	});
}
