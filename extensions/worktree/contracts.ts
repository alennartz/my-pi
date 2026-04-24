export const WORKTREE_ROOT_DIRECTORY_NAME = ".git-worktrees";
/**
 * Last-resort fallback when neither the user nor the repo (`origin/HEAD`,
 * `init.defaultBranch`, or local branch heuristics) tells us what to merge into.
 */
export const DEFAULT_MERGE_TARGET_FALLBACK = "main";

export type ContextTransferChoice = "bring-context" | "fresh-session";
export type PendingChangesChoice = "bring-changes" | "leave-changes";
export type WorktreeNotificationLevel = "info" | "warning" | "error";

export interface WorktreeInfo {
	path: string;
	branch: string;
	isMain: boolean;
}

export interface WorktreeCreateRequest {
	branchName: string;
	baseBranch?: string;
}

export interface WorktreeCleanupRequest {
	/**
	 * Branch to merge the current worktree's branch into. When undefined, the
	 * controller resolves a default at runtime by inspecting the repository.
	 */
	mergeTarget?: string;
}

export interface WorktreeEnvironment {
	cwd: string;
	homeDirectory: string;
	repoName: string;
	currentSessionFile?: string;
}

export interface WorktreeGitClient {
	listWorktrees(cwd: string): Promise<WorktreeInfo[]>;
	getCurrentBranch(cwd: string): Promise<string>;
	getStatusPorcelain(cwd: string): Promise<string>;
	stashPush(cwd: string): Promise<boolean>;
	stashPop(cwd: string): Promise<void>;
	addWorktree(input: {
		cwd: string;
		path: string;
		branchName: string;
		baseBranch: string;
	}): Promise<void>;
	removeWorktree(input: {
		cwd: string;
		worktreePath: string;
	}): Promise<void>;
	deleteBranch(input: {
		cwd: string;
		branchName: string;
		force: boolean;
	}): Promise<void>;
	/**
	 * Returns true when `ancestor` is reachable from `descendant` (i.e. the
	 * commits on `ancestor` are merged into `descendant`). Used to confirm a
	 * merge actually landed before destructive cleanup steps run.
	 */
	isAncestor(input: {
		cwd: string;
		ancestor: string;
		descendant: string;
	}): Promise<boolean>;
	/**
	 * Best-effort detection of the repo's default branch (origin/HEAD, then
	 * config init.defaultBranch, then a probe for common names). Returns
	 * undefined when nothing matches; callers should fall back explicitly.
	 */
	detectDefaultBranch(cwd: string): Promise<string | undefined>;
}

export interface WorktreeSessionGateway {
	continueRecent(cwd: string): Promise<string | undefined>;
	create(cwd: string): Promise<string>;
	forkFrom(sourceSessionFile: string, targetCwd: string): Promise<string>;
}

export interface WorktreeAgentGateway {
	/**
	 * Sends a user message to the agent AND waits for the resulting agent turn
	 * to fully complete (start → end). Implementations must handle the race
	 * where the turn has not yet begun when this method is called.
	 */
	sendMergeInstruction(message: string): Promise<void>;
}

export interface WorktreeCommandRuntime {
	chooseContextTransfer(): Promise<ContextTransferChoice | undefined>;
	choosePendingChanges(): Promise<PendingChangesChoice | undefined>;
	notify(message: string, level: WorktreeNotificationLevel): void;
	switchSession(sessionFile: string): Promise<{ cancelled: boolean }>;
}

export interface WorktreeDependencies {
	env: WorktreeEnvironment;
	git: WorktreeGitClient;
	sessions: WorktreeSessionGateway;
	agent: WorktreeAgentGateway;
	runtime: WorktreeCommandRuntime;
}

export interface WorktreeController {
	create(request: WorktreeCreateRequest): Promise<void>;
	cleanup(request: WorktreeCleanupRequest): Promise<void>;
}

export interface WorktreeAutocompleteItem {
	value: string;
	label: string;
}
