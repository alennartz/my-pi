import type { WorktreeController, WorktreeDependencies } from "./contracts.ts";

function notImplemented(surface: string): never {
	throw new Error(`${surface} is not implemented yet`);
}

export function createWorktreeController(_dependencies?: WorktreeDependencies): WorktreeController {
	return {
		async create(_request) {
			return notImplemented("/worktree create");
		},
		async cleanup(_request) {
			return notImplemented("/worktree cleanup");
		},
	};
}
