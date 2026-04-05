import { resolveWorktreePath } from "./command-surface.ts";
import type {
	WorktreeController,
	WorktreeDependencies,
	WorktreeEnvironment,
	WorktreeInfo,
	WorktreeSessionGateway,
} from "./contracts.ts";

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
			await git.addWorktree({
				cwd: env.cwd,
				path: worktreePath,
				branchName: request.branchName,
				baseBranch,
			});

			if (stashCreated) {
				await git.stashPop(worktreePath);
			}

			const sessionFile = contextTransfer === "fresh-session"
				? await sessions.create(worktreePath)
				: await sessions.forkFrom(requireCurrentSessionFile(env), worktreePath);
			await runtime.switchSession(sessionFile);
		},

		async cleanup(_request) {
			void agent;
			return Promise.reject(new Error("/worktree cleanup is not implemented yet"));
		},
	};
}
