import type {
	SubagentHoldRequest,
	SubagentResurrectRequest,
	SubagentResurrectResult,
	SubagentRuntimeRef,
	SubagentStopRequest,
	SubagentTeardownResult,
} from "@pimote/sdk/subagents";
import type { AgentPath } from "./agent-path.js";
import type { ChildRef, Settlement } from "./settlements.js";

/** Guarded lifecycle operations one manager performs on its immediate children. */
export interface SubagentManagerControl {
	teardown(ref: SubagentRuntimeRef): Promise<SubagentTeardownResult>;
	stop(request: SubagentStopRequest): Promise<void>;
	setHold(request: SubagentHoldRequest): Promise<void>;
	resurrect(request: SubagentResurrectRequest): Promise<SubagentResurrectResult>;
	pendingAnswers(ref: ChildRef): readonly Settlement[];
}

/**
 * Root-scoped lifecycle authority. A control for a child path goes to the
 * manager registered at exactly that path's parent. It never falls back to an
 * ancestor manager, so a request can only reach the direct owner.
 */
export class SubagentControlPort {
	private readonly managers = new Map<string, SubagentManagerControl>();

	register(ownerPath: AgentPath, control: SubagentManagerControl): void {
		this.managers.set(pathKey(ownerPath), control);
	}

	unregister(ownerPath: AgentPath, control: SubagentManagerControl): void {
		const key = pathKey(ownerPath);
		if (this.managers.get(key) === control) {this.managers.delete(key);}
	}

	teardown(ref: SubagentRuntimeRef): Promise<SubagentTeardownResult> {
		return this.ownerOf(ref.path).teardown(ref);
	}

	stop(request: SubagentStopRequest): Promise<void> {
		return this.ownerOf(request.path).stop(request);
	}

	setHold(request: SubagentHoldRequest): Promise<void> {
		return this.ownerOf(request.path).setHold(request);
	}

	resurrect(request: SubagentResurrectRequest): Promise<SubagentResurrectResult> {
		const owner = this.managers.get(pathKey(request.parentPath));
		if (!owner) {return Promise.reject(new Error(`No live owner at ${JSON.stringify(request.parentPath)}`));}
		return owner.resurrect(request);
	}

	/** Read a teardown preview from the child's immediate owner, without taking a claim. */
	pendingAnswers(ref: ChildRef): readonly Settlement[] {
		return this.managers.get(pathKey(ref.path.slice(0, -1)))?.pendingAnswers(ref) ?? [];
	}

	clear(): void {
		this.managers.clear();
	}

	private ownerOf(path: AgentPath): SubagentManagerControl {
		if (path.length === 0) {throw new Error("The root session has no owner control");}
		const owner = this.managers.get(pathKey(path.slice(0, -1)));
		if (!owner) {throw new Error(`No live owner for ${JSON.stringify(path)}`);}
		return owner;
	}
}

function pathKey(path: AgentPath): string {
	return JSON.stringify(path);
}
