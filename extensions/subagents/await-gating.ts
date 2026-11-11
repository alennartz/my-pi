import type { AgentPath } from "./agent-path.js";

export type AwaitChildState = "idle" | "errored" | "dead" | "stopped";

export type AwaitChildStatus = Readonly<{
	path: AgentPath;
	state: AwaitChildState;
	output?: string;
	error?: string;
	sessionId?: string;
}>;

export type AwaitMessage = Readonly<{
	from: AgentPath;
	to: AgentPath;
	content: string;
	correlationId?: string;
	responseExpected: boolean;
}>;

export type AwaitOutcome =
	| Readonly<{
			kind: "released";
			reason: "settled" | "detach" | "stop";
			statuses: readonly AwaitChildStatus[];
	  }>
	| Readonly<{
			kind: "interrupted";
			message: AwaitMessage;
			statuses: readonly AwaitChildStatus[];
	  }>;

export interface AwaitGateOptions {
	/** Empty when no parent await is active. */
	requested: readonly AgentPath[];
	/** Each occurrence represents one client lease. */
	attached?: readonly AgentPath[];
	/** Deliver the latest held idle notification after the final lease detaches. */
	onHeldIdleDelivery?: (status: AwaitChildStatus) => void;
}

/**
 * View-aware await and idle notification coordination. The gate continues
 * holding notifications after its result resolves, including when no await
 * is active. A message interrupts the wait without discarding held idle
 * notifications. Stop discards them.
 */
export interface AwaitGate {
	readonly result: Promise<AwaitOutcome>;
	/** Start a new child run and clear its previous settlement and held answer. */
	start(path: AgentPath): void;
	attach(path: AgentPath): void;
	settle(status: AwaitChildStatus): void;
	message(message: AwaitMessage): void;
	detach(path: AgentPath): void;
	/** Stop the parent, or settle one child as stopped when a path is supplied. */
	stop(): void;
	stop(path: AgentPath, status?: AwaitChildStatus): void;
}

type Deferred<T> = Readonly<{
	promise: Promise<T>;
	resolve: (value: T) => void;
}>;

type AwaitCycle = {
	requestedKeys: string[];
	deferred: Deferred<AwaitOutcome>;
	resolved: boolean;
	parentStopped: boolean;
};

type GateState = {
	cycle: AwaitCycle;
	leases: Map<string, number>;
	totalLeases: number;
	settlements: Map<string, AwaitChildStatus>;
	blocked: Set<string>;
	heldIdle?: AwaitChildStatus;
};

function createDeferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((next) => {
		resolve = next;
	});
	return { promise, resolve };
}

function pathKey(path: AgentPath): string {
	return JSON.stringify(path);
}

function copyPath(path: AgentPath): AgentPath {
	return [...path];
}

function copyStatus(status: AwaitChildStatus): AwaitChildStatus {
	return { ...status, path: copyPath(status.path) };
}

function copyMessage(message: AwaitMessage): AwaitMessage {
	return { ...message };
}

function normalizeRequested(paths: readonly AgentPath[]): string[] {
	const keys: string[] = [];
	const seen = new Set<string>();
	for (const path of paths) {
		const key = pathKey(path);
		if (seen.has(key)) continue;
		keys.push(key);
		seen.add(key);
	}
	return keys;
}

function countLease(state: GateState, key: string): number {
	return state.leases.get(key) ?? 0;
}

function cycleStatuses(state: GateState, cycle: AwaitCycle): readonly AwaitChildStatus[] {
	return cycle.requestedKeys.flatMap((key) => {
		const status = state.settlements.get(key);
		return status ? [copyStatus(status)] : [];
	});
}

function allRequestedSettled(state: GateState, cycle: AwaitCycle): boolean {
	return cycle.requestedKeys.every((key) => state.settlements.has(key));
}

function requestedSettlementBlocked(state: GateState, cycle: AwaitCycle): boolean {
	return cycle.requestedKeys.some((key) => state.blocked.has(key));
}

function releaseCycle(
	state: GateState,
	cycle: AwaitCycle,
	reason: "settled" | "detach" | "stop",
	statuses: readonly AwaitChildStatus[] = cycleStatuses(state, cycle),
): void {
	if (cycle.resolved) return;
	cycle.resolved = true;
	cycle.deferred.resolve({ kind: "released", reason, statuses });
}

function tryRelease(state: GateState, cycle: AwaitCycle, reason: "settled" | "detach"): void {
	if (cycle.resolved || cycle.parentStopped) return;
	if (!allRequestedSettled(state, cycle)) return;
	if (requestedSettlementBlocked(state, cycle)) return;
	releaseCycle(state, cycle, reason);
}

function samePath(left: AgentPath, right: AgentPath): boolean {
	return pathKey(left) === pathKey(right);
}

/** Create the pure await/lease state machine. */
export function createAwaitGate(options: AwaitGateOptions): AwaitGate {
	const initial = normalizeRequested(options.requested);
	const state: GateState = {
		cycle: {
			requestedKeys: initial,
			deferred: createDeferred<AwaitOutcome>(),
			resolved: false,
			parentStopped: false,
		},
		leases: new Map(),
		totalLeases: 0,
		settlements: new Map(),
		blocked: new Set(),
	};
	const deliverHeldIdle = options.onHeldIdleDelivery;

	function releaseHeldIdle(): void {
		const held = state.heldIdle;
		state.heldIdle = undefined;
		if (!held || !deliverHeldIdle) return;
		deliverHeldIdle(copyStatus(held));
	}

	function clearPath(path: AgentPath): void {
		const key = pathKey(path);
		state.settlements.delete(key);
		state.blocked.delete(key);
		if (state.heldIdle && samePath(state.heldIdle.path, path)) {
			state.heldIdle = undefined;
		}
	}

	function attach(path: AgentPath): void {
		const key = pathKey(path);
		state.leases.set(key, countLease(state, key) + 1);
		state.totalLeases += 1;

		const status = state.settlements.get(key);
		if (!status || status.state === "stopped") return;
		state.blocked.add(key);
		if (status.state === "idle" && !state.heldIdle) {
			state.heldIdle = status;
		}
	}

	function settle(status: AwaitChildStatus): void {
		const next = copyStatus(status);
		const key = pathKey(next.path);
		state.settlements.set(key, next);
		state.blocked.delete(key);
		if (state.heldIdle && samePath(state.heldIdle.path, next.path)) {
			state.heldIdle = undefined;
		}

		if (next.state !== "stopped" && countLease(state, key) > 0) {
			state.blocked.add(key);
			if (next.state === "idle") state.heldIdle = next;
		}

		tryRelease(state, state.cycle, "settled");
	}

	function message(incoming: AwaitMessage): void {
		const cycle = state.cycle;
		if (cycle.resolved || cycle.parentStopped) return;
		cycle.resolved = true;
		cycle.deferred.resolve({
			kind: "interrupted",
			message: copyMessage(incoming),
			statuses: cycleStatuses(state, cycle),
		});
	}

	function detach(path: AgentPath): void {
		const key = pathKey(path);
		const current = countLease(state, key);
		if (current === 0) return;
		if (current === 1) state.leases.delete(key);
		else state.leases.set(key, current - 1);
		state.totalLeases -= 1;
		if (state.totalLeases > 0) return;

		const hadBlocked = state.blocked.size > 0;
		state.blocked.clear();
		const hadHeldIdle = state.heldIdle !== undefined;
		try {
			releaseHeldIdle();
		} finally {
			tryRelease(state, state.cycle, hadBlocked || hadHeldIdle ? "detach" : "settled");
		}
	}

	function stop(path?: AgentPath, suppliedStatus?: AwaitChildStatus): void {
		if (path) {
			const key = pathKey(path);
			const stopped: AwaitChildStatus = {
				...(suppliedStatus ? copyStatus(suppliedStatus) : {}),
				path: copyPath(path),
				state: "stopped",
			};
			state.settlements.set(key, stopped);
			state.blocked.delete(key);
			if (state.heldIdle && samePath(state.heldIdle.path, path)) {
				state.heldIdle = undefined;
			}
			tryRelease(state, state.cycle, "settled");
			return;
		}

		const cycle = state.cycle;
		cycle.parentStopped = true;
		for (const key of cycle.requestedKeys) {
			state.settlements.delete(key);
			state.blocked.delete(key);
		}
		state.heldIdle = undefined;
		state.blocked.clear();
		releaseCycle(state, cycle, "stop", []);
	}

	function start(path: AgentPath): void {
		clearPath(path);
	}

	for (const path of options.attached ?? []) attach(path);
	if (state.cycle.requestedKeys.length === 0) {
		releaseCycle(state, state.cycle, "settled", []);
	}

	return {
		get result() {
			return state.cycle.deferred.promise;
		},
		start,
		attach,
		settle,
		message,
		detach,
		stop,
	};
}
