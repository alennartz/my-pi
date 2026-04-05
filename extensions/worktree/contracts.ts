export const WORKTREE_ROOT_DIRECTORY_NAME = ".git-worktrees";
export const DEFAULT_MERGE_TARGET = "main";

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
	mergeTarget: string;
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
}

export interface WorktreeSessionGateway {
	continueRecent(cwd: string): Promise<string>;
	create(cwd: string): Promise<string>;
	forkFrom(sourceSessionFile: string, targetCwd: string): Promise<string>;
}

export interface WorktreeAgentGateway {
	sendMergeInstruction(message: string): Promise<void>;
}

export interface WorktreeCommandRuntime {
	chooseContextTransfer(): Promise<ContextTransferChoice | undefined>;
	choosePendingChanges(): Promise<PendingChangesChoice | undefined>;
	notify(message: string, level: WorktreeNotificationLevel): void;
	waitForIdle(): Promise<void>;
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
