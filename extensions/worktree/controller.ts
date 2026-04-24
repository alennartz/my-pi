import { buildCleanupMergePrompt, resolveWorktreePath } from "./command-surface.ts";
import {
	DEFAULT_MERGE_TARGET_FALLBACK,
	type WorktreeController,
	type WorktreeDependencies,
	type WorktreeEnvironment,
	type WorktreeGitClient,
	type WorktreeInfo,
	type WorktreeSessionGateway,
} from "./contracts.ts";

async function resolveMergeTarget(
	git: WorktreeGitClient,
	cwd: string,
	requested: string | undefined,
): Promise<string> {
	if (requested) return requested;
	const detected = await git.detectDefaultBranch(cwd);
	return detected ?? DEFAULT_MERGE_TARGET_FALLBACK;
}

function findWorktreeByBranch(worktrees: readonly WorktreeInfo[], branchName: string): WorktreeInfo | undefined {
	return worktrees.find((worktree) => worktree.branch === branchName);
}

async function getResumeSessionFile(
	sessions: WorktreeSessionGateway,
	worktreePath: string,
): Promise<string> {
	return (await sessions.continueRecent(worktreePath)) ?? sessions.create(worktreePath);
}

function requireCurrentSessionFile(env: WorktreeEnvironment): string {
	if (!env.currentSessionFile) {
		throw new Error("Cannot bring context into a worktree without a persisted current session");
	}
	return env.currentSessionFile;
}

function requireMainWorktree(worktrees: readonly WorktreeInfo[]): WorktreeInfo {
	const mainWorktree = worktrees.find((worktree) => worktree.isMain);
	if (!mainWorktree) {
		throw new Error("Could not determine the main repository worktree");
	}
	return mainWorktree;
}

function requireWorktreeAtPath(worktrees: readonly WorktreeInfo[], path: string): WorktreeInfo {
	const worktree = worktrees.find((candidate) => candidate.path === path);
	if (!worktree) {
		throw new Error(`Could not find worktree for path: ${path}`);
	}
	return worktree;
}

export function createWorktreeController(dependencies: WorktreeDependencies): WorktreeController {
	const { env, git, sessions, agent, runtime } = dependencies;

	return {
		async create(request) {
			const worktrees = await git.listWorktrees(env.cwd);
			const existing = findWorktreeByBranch(worktrees, request.branchName);
			if (existing) {
				const sessionFile = await getResumeSessionFile(sessions, existing.path);
				await runtime.switchSession(sessionFile);
				return;
			}

			const contextTransfer = await runtime.chooseContextTransfer();
			if (!contextTransfer) {
				return;
			}

			const status = await git.getStatusPorcelain(env.cwd);
			let stashCreated = false;
			if (status.trim().length > 0) {
				const pendingChanges = await runtime.choosePendingChanges();
				if (!pendingChanges) {
					return;
				}
				if (pendingChanges === "bring-changes") {
					stashCreated = await git.stashPush(env.cwd);
				}
			}

			const baseBranch = request.baseBranch ?? await git.getCurrentBranch(env.cwd);
			const worktreePath = resolveWorktreePath(env.homeDirectory, env.repoName, request.branchName);
			try {
				await git.addWorktree({
					cwd: env.cwd,
					path: worktreePath,
					branchName: request.branchName,
					baseBranch,
				});

				if (stashCreated) {
					await git.stashPop(worktreePath);
				}
			} catch (error) {
				if (stashCreated) {
					runtime.notify(
						"Worktree creation failed. Your tracked changes are saved in the git stash — run `git stash pop` to recover them.",
						"warning",
					);
				}
				throw error;
			}

			const sessionFile = contextTransfer === "fresh-session"
				? await sessions.create(worktreePath)
				: await sessions.forkFrom(requireCurrentSessionFile(env), worktreePath);
			await runtime.switchSession(sessionFile);
		},

		async cleanup(request) {
			const currentBranch = await git.getCurrentBranch(env.cwd);
			if (!currentBranch) {
				runtime.notify(
					"Cannot run cleanup in a detached HEAD state. Check out a branch first.",
					"warning",
				);
				return;
			}

			// Resolve worktrees up front so we can both validate the caller's
			// position and pass the main worktree path into the merge prompt.
			const worktreesBefore = await git.listWorktrees(env.cwd);
			const mainWorktree = requireMainWorktree(worktreesBefore);
			const currentWorktree = requireWorktreeAtPath(worktreesBefore, env.cwd);
			if (currentWorktree.isMain) {
				runtime.notify(
					"Cannot clean up the main worktree. Run /worktree cleanup from a branch worktree.",
					"warning",
				);
				return;
			}

			const mergeTarget = await resolveMergeTarget(git, mainWorktree.path, request.mergeTarget);

			// sendMergeInstruction must wait for the agent turn to complete before
			// returning. See WorktreeAgentGateway.sendMergeInstruction docs.
			await agent.sendMergeInstruction(
				buildCleanupMergePrompt(currentBranch, mergeTarget, mainWorktree.path),
			);

			const status = await git.getStatusPorcelain(env.cwd);
			if (status.trim().length > 0) {
				runtime.notify(
					"Worktree is still dirty after the merge attempt. Resolve remaining changes and re-run /worktree cleanup.",
					"warning",
				);
				return;
			}

			// Verify the merge actually landed before doing anything destructive.
			// `git status` being clean is not sufficient — the agent may have
			// declined to merge, merged the wrong direction, or failed silently.
			const merged = await git.isAncestor({
				cwd: mainWorktree.path,
				ancestor: currentBranch,
				descendant: mergeTarget,
			});
			if (!merged) {
				runtime.notify(
					`Branch '${currentBranch}' is not merged into '${mergeTarget}'. Cleanup aborted; the worktree and branch are untouched.`,
					"warning",
				);
				return;
			}

			// Re-list worktrees in case the agent's merge work changed something
			// (e.g. it created/removed worktrees during conflict resolution).
			const worktreesAfter = await git.listWorktrees(env.cwd);
			const stillExists = worktreesAfter.some((w) => w.path === currentWorktree.path);
			if (!stillExists) {
				runtime.notify(
					`Worktree at ${currentWorktree.path} no longer exists; skipping removal.`,
					"info",
				);
			} else {
				await git.removeWorktree({
					cwd: mainWorktree.path,
					worktreePath: currentWorktree.path,
				});
			}

			try {
				// We've verified the branch is fully merged into mergeTarget, so
				// -D is safe here. -d would refuse if mergeTarget isn't HEAD or
				// the branch's upstream, even though the commits are preserved.
				await git.deleteBranch({
					cwd: mainWorktree.path,
					branchName: currentWorktree.branch,
					force: true,
				});
			} catch {
				runtime.notify(
					`Worktree removed but branch '${currentWorktree.branch}' could not be deleted. Its commits are merged into '${mergeTarget}'; run \`git branch -D ${currentWorktree.branch}\` to finish.`,
					"warning",
				);
			}
			const sessionFile = await sessions.create(mainWorktree.path);
			await runtime.switchSession(sessionFile);
		},
	};
}
