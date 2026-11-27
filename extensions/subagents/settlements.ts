import type { SubagentAgentStatus, SubagentSettlementState, SubagentState, SubagentUsage } from "@pimote/sdk/subagents";
import type { AgentPath } from "./agent-path.js";

/** One child incarnation. Incarnations are unique, so a ref never matches a later child at the same path. */
export type ChildRef = Readonly<{ path: AgentPath; incarnation: string }>;

/** The settled outcome of one child run. */
export type Settlement = Readonly<{
	state: SubagentSettlementState;
	output?: string;
	error?: string;
	sessionId?: string;
	usage?: SubagentUsage;
}>;

/** Hold state that survives restore. `pending` holds settlements the parent has not received. */
export type HoldRecord = Readonly<{ held: boolean; pending: readonly Settlement[]; replaced: boolean }>;

/** What the registry reports about a live child. `settlement` is set while it is settled. */
export type LiveChild = Readonly<{ state: SubagentState; settlement?: Settlement }>;

export interface SettlementLedgerHost {
	/** Deliver one settlement to the parent. `replaced` marks an answer that replaced an undelivered one. */
	notify(ref: ChildRef, settlement: Settlement, replaced: boolean): void;
	/** Write the hold state to durable storage. */
	persistHold(ref: ChildRef, hold: HoldRecord): void;
	/** Show the hold state on the child's node. */
	publishHold(ref: ChildRef, hold: HoldRecord): void;
	/** Live registry state of a child, or undefined once it is gone. */
	live(ref: ChildRef): LiveChild | undefined;
}

export type WaitResult = Readonly<{
	interrupted: boolean;
	statuses: readonly SubagentAgentStatus[];
	/** Children whose settlement this result delivers to the parent. */
	delivered: readonly ChildRef[];
}>;

/** One active `await_agents` call. */
export interface ChildWait {
	readonly result: Promise<WaitResult>;
	/** Current per-child status, for progress. */
	statuses(): readonly SubagentAgentStatus[];
	/** End the wait now because a message reached the parent. */
	interrupt(): void;
	/** End the wait without delivering anything. Undelivered settlements go out as notices. */
	cancel(): void;
	onChange(listener: () => void): () => void;
}

type ChildRecord = {
	readonly ref: ChildRef;
	held: boolean;
	running: boolean;
	last?: Settlement;
	pending: Settlement[];
	replaced: boolean;
};

type WaitEntry = Readonly<{ ref: ChildRef; status: SubagentAgentStatus; resolved: boolean }>;

/**
 * The single settlement record of one manager. Every child settlement,
 * delivery, hold, and removal goes through it, so an await, a notice, and the
 * panel read the same fact.
 *
 * - A held child's settlements reach no one until the user releases it.
 * - A new run discards undelivered answers and marks the next delivery as a
 *   replacement. Stops keep that mark.
 * - Removal settles the child as `removed` in the active wait.
 * - A parent stop cancels the wait and keeps every undelivered settlement.
 */
export class SettlementLedger {
	private readonly records = new Map<string, ChildRecord>();
	private active: ActiveWait | undefined;

	constructor(private readonly host: SettlementLedgerHost) {}

	get waiting(): boolean {
		return this.active !== undefined;
	}

	/** Apply a persisted hold to a restored child. */
	restore(ref: ChildRef, hold: HoldRecord): void {
		if (!hold.held && hold.pending.length === 0) {return;}
		const record = this.record(ref);
		record.held = hold.held;
		record.pending = [...hold.pending];
		record.replaced = hold.replaced;
		record.last = hold.pending.at(-1);
		this.host.publishHold(ref, this.holdOf(record));
		if (!record.held) {this.route(record);}
	}

	runStarted(ref: ChildRef): void {
		const record = this.record(ref);
		if (record.pending.some(isAnswer)) {record.replaced = true;}
		record.pending = [];
		record.last = undefined;
		record.running = true;
		if (record.held) {this.saveHold(record);}
		this.changed(record);
	}

	settled(ref: ChildRef, settlement: Settlement): void {
		const record = this.record(ref);
		record.running = false;
		record.last = settlement;
		record.pending.push(settlement);
		if (record.held) {
			this.saveHold(record);
			this.changed(record);
			return;
		}
		if (this.active?.covers(ref)) {
			this.changed(record);
			return;
		}
		this.route(record);
	}

	setHold(ref: ChildRef, held: boolean): void {
		const record = this.record(ref);
		if (record.held === held) {return;}
		record.held = held;
		this.saveHold(record);
		if (!held && !this.active?.covers(ref)) {this.route(record);}
		this.changed(record);
	}

	hold(ref: ChildRef): HoldRecord {
		const record = this.records.get(refKey(ref));
		return record ? this.holdOf(record) : { held: false, pending: [], replaced: false };
	}

	/** Remove a child. Returns the answers it held back, which the removal must report. */
	removed(ref: ChildRef): readonly Settlement[] {
		const record = this.records.get(refKey(ref));
		const held = record?.pending.filter(isAnswer) ?? [];
		this.records.delete(refKey(ref));
		this.active?.remove(ref, held.at(-1));
		return held;
	}

	/** Start the one wait this manager allows. */
	wait(refs: readonly ChildRef[]): ChildWait {
		if (this.active) {throw new Error("Another await_agents call is already active.");}
		const wait = new ActiveWait(refs, {
			status: (ref) => this.waitStatus(ref),
			finish: (result) => this.finishWait(wait, result),
			cancel: () => this.cancelWait(wait),
		});
		this.active = wait;
		wait.evaluate();
		return wait;
	}

	clear(): void {
		this.active?.cancel();
		this.active = undefined;
		this.records.clear();
	}

	private record(ref: ChildRef): ChildRecord {
		const key = refKey(ref);
		let record = this.records.get(key);
		if (!record) {
			record = { ref: { path: [...ref.path], incarnation: ref.incarnation }, held: false, running: false, pending: [], replaced: false };
			this.records.set(key, record);
		}
		return record;
	}

	private holdOf(record: ChildRecord): HoldRecord {
		return { held: record.held, pending: [...record.pending], replaced: record.replaced };
	}

	private saveHold(record: ChildRecord): void {
		const hold = this.holdOf(record);
		this.host.persistHold(record.ref, hold);
		this.host.publishHold(record.ref, hold);
	}

	/** Deliver a record's undelivered answers as notices. A stop is not an answer and sends none. */
	private route(record: ChildRecord): void {
		if (record.held) {return;}
		const answers = record.pending.filter(isAnswer);
		record.pending = [];
		for (const settlement of answers) {
			this.host.notify(record.ref, settlement, record.replaced);
			record.replaced = false;
		}
	}

	private changed(record: ChildRecord): void {
		if (this.active?.covers(record.ref)) {this.active.evaluate();}
	}

	private waitStatus(ref: ChildRef): WaitEntry {
		const record = this.records.get(refKey(ref));
		const live = this.host.live(ref);
		const path = [...ref.path];
		if (!live) {return { ref, resolved: true, status: { path, state: "removed" } };}
		if (record?.held && (record.pending.length > 0 || live.settlement)) {
			return { ref, resolved: false, status: { path, state: "held" } };
		}
		if (record?.running) {return { ref, resolved: false, status: { path, state: live.state === "waiting" ? "waiting" : "running" } };}
		const settlement = record?.last ?? live.settlement;
		if (!settlement) {return { ref, resolved: false, status: { path, state: live.state } };}
		return {
			ref,
			resolved: true,
			status: {
				path,
				...settlement,
				...(record?.replaced ? { replacedHeldResult: true } : undefined),
			},
		};
	}

	private finishWait(wait: ActiveWait, result: WaitResult): void {
		if (this.active !== wait) {return;}
		this.active = undefined;
		for (const ref of result.delivered) {
			const record = this.records.get(refKey(ref));
			if (!record) {continue;}
			record.pending = [];
			record.replaced = false;
		}
		for (const ref of wait.refs) {
			const record = this.records.get(refKey(ref));
			if (record && !result.delivered.some((delivered) => sameRef(delivered, ref))) {this.route(record);}
		}
	}

	private cancelWait(wait: ActiveWait): void {
		if (this.active !== wait) {return;}
		this.active = undefined;
		for (const ref of wait.refs) {
			const record = this.records.get(refKey(ref));
			if (record) {this.route(record);}
		}
	}
}

type WaitHooks = Readonly<{
	status(ref: ChildRef): WaitEntry;
	finish(result: WaitResult): void;
	cancel(): void;
}>;

class ActiveWait implements ChildWait {
	readonly result: Promise<WaitResult>;
	readonly refs: readonly ChildRef[];
	private resolve!: (result: WaitResult) => void;
	private reject!: (error: Error) => void;
	private done = false;
	private readonly removedRefs = new Map<string, SubagentAgentStatus>();
	private readonly listeners = new Set<() => void>();

	constructor(refs: readonly ChildRef[], private readonly hooks: WaitHooks) {
		this.refs = uniqueRefs(refs);
		this.result = new Promise<WaitResult>((resolve, reject) => {
			this.resolve = resolve;
			this.reject = reject;
		});
	}

	covers(ref: ChildRef): boolean {
		return !this.done && this.refs.some((candidate) => sameRef(candidate, ref));
	}

	statuses(): readonly SubagentAgentStatus[] {
		return this.entries().map((entry) => entry.status);
	}

	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	remove(ref: ChildRef, held: Settlement | undefined): void {
		if (!this.covers(ref)) {return;}
		this.removedRefs.set(refKey(ref), {
			path: [...ref.path],
			state: "removed",
			...(held?.output !== undefined ? { output: held.output } : undefined),
			...(held?.sessionId !== undefined ? { sessionId: held.sessionId } : undefined),
		});
		this.evaluate();
	}

	evaluate(): void {
		if (this.done) {return;}
		const entries = this.entries();
		if (entries.every((entry) => entry.resolved)) {
			this.finish(false, entries);
			return;
		}
		for (const listener of Array.from(this.listeners)) {listener();}
	}

	interrupt(): void {
		if (this.done) {return;}
		this.finish(true, this.entries());
	}

	cancel(): void {
		if (this.done) {return;}
		this.done = true;
		this.listeners.clear();
		this.hooks.cancel();
		this.reject(new Error("Wait cancelled."));
	}

	private entries(): WaitEntry[] {
		return this.refs.map((ref) => {
			const removed = this.removedRefs.get(refKey(ref));
			return removed ? { ref, resolved: true, status: removed } : this.hooks.status(ref);
		});
	}

	private finish(interrupted: boolean, entries: readonly WaitEntry[]): void {
		this.done = true;
		this.listeners.clear();
		const result: WaitResult = {
			interrupted,
			statuses: entries.map((entry) => entry.status),
			delivered: entries.flatMap((entry) => entry.resolved && entry.status.state !== "removed" ? [entry.ref] : []),
		};
		this.hooks.finish(result);
		this.resolve(result);
	}
}

function isAnswer(settlement: Settlement): boolean {
	return settlement.state !== "stopped";
}

function refKey(ref: ChildRef): string {
	return JSON.stringify([ref.path, ref.incarnation]);
}

function sameRef(left: ChildRef, right: ChildRef): boolean {
	return refKey(left) === refKey(right);
}

function uniqueRefs(refs: readonly ChildRef[]): ChildRef[] {
	const seen = new Set<string>();
	return refs.filter((ref) => {
		const key = refKey(ref);
		if (seen.has(key)) {return false;}
		seen.add(key);
		return true;
	});
}
