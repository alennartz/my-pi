import { randomUUID } from "node:crypto";
import type { SubagentAgentStatus, SubagentSettlementState, SubagentState, SubagentUsage } from "@pimote/sdk/subagents";
import type { AgentPath } from "./agent-path.js";
import { required } from "../../lib/required.ts";

export type ChildRef = Readonly<{ path: AgentPath; incarnation: string }>;

export type Settlement = Readonly<{
	state: SubagentSettlementState;
	output?: string;
	error?: string;
	sessionId?: string;
	usage?: SubagentUsage;
}>;

export type PendingSettlement = Readonly<{ id: string; run: number; settlement: Settlement; replaces?: true }>;
export type HoldRecord = Readonly<{ held: boolean; pending: readonly PendingSettlement[]; replaced: boolean }>;
export type LiveChild = Readonly<{ state: SubagentState; settlement?: Settlement }>;

export interface SettlementLedgerHost {
	offer(ref: ChildRef, report: Settlement, replaced: boolean, ids: readonly string[]): void;
	/** Take back a notice that has not left the queue. */
	withdraw(ref: ChildRef): boolean;
	persistHold(ref: ChildRef, hold: HoldRecord): void;
	publishHold(ref: ChildRef, hold: HoldRecord): void;
	live(ref: ChildRef): LiveChild | undefined;
}

export type WaitResult = Readonly<{
	interrupted: boolean;
	statuses: readonly SubagentAgentStatus[];
	/** Pending settlements this result reports in model-facing text. */
	receipts: readonly string[];
}>;

export interface ChildWait {
	readonly result: Promise<WaitResult>;
	statuses(): readonly SubagentAgentStatus[];
	interrupt(): void;
	cancel(): void;
	onChange(listener: () => void): () => void;
}

type ChildRecord = {
	readonly ref: ChildRef;
	held: boolean;
	running: boolean;
	runId: number;
	run: Settlement[];
	pending: PendingSettlement[];
	offered: readonly string[];
	waitingReceipt: readonly string[];
	replaced: boolean;
	saved: string;
};

type WaitEntry = Readonly<{ status: SubagentAgentStatus; resolved: boolean; receipts?: readonly string[] }>;

const EMPTY_HOLD = { held: false, pending: [], replaced: false } satisfies HoldRecord;

/** One manager's ledger. Notices and waits claim results. Only native receipts commit them. */
export class SettlementLedger {
	private readonly records = new Map<string, ChildRecord>();
	private active: ActiveWait | undefined;

	constructor(private readonly host: SettlementLedgerHost) {}

	restore(ref: ChildRef, hold: HoldRecord, receipts: ReadonlySet<string> = new Set()): void {
		if (!hold.held && hold.pending.length === 0 && !hold.replaced) {return;}
		const record = this.record(ref);
		record.held = hold.held;
		record.pending = hold.pending.filter((entry) => !receipts.has(entry.id));
		record.runId = hold.pending.at(-1)?.run ?? 0;
		record.run = hold.pending.flatMap((entry) => entry.run === record.runId ? [entry.settlement] : []);
		record.replaced = hold.replaced && !hold.pending.some((entry) => entry.replaces && receipts.has(entry.id));
		this.sync(record, true);
		this.route(record);
	}

	runStarted(ref: ChildRef): void {
		const record = this.record(ref);
		if (record.held) {
			if (unclaimed(record).some((entry) => isAnswer(entry.settlement))) {record.replaced = true;}
			record.pending = record.pending.filter((entry) => claimed(record, entry.id));
		}
		record.runId += 1;
		record.run = [];
		record.running = true;
		this.sync(record);
		this.route(record, true);
		this.changed(record);
	}

	settled(ref: ChildRef, settlement: Settlement): void {
		const record = this.record(ref);
		record.running = false;
		record.run.push(settlement);
		const replaces = record.replaced && isAnswer(settlement) && !record.pending.some((entry) => entry.replaces);
		record.pending.push({ id: randomUUID(), run: record.runId, settlement, ...(replaces ? { replaces: true } : undefined) });
		this.sync(record);
		if (!record.held && record.pending.some((entry) => entry.run === record.runId && record.offered.includes(entry.id))) {
			this.withdraw(record);
		}
		this.route(record);
		this.changed(record);
	}

	/** Consume only settlements named by a native transcript entry. */
	delivered(ids: ReadonlySet<string>): void {
		for (const record of this.records.values()) {
			if (!record.pending.some((entry) => ids.has(entry.id))) {continue;}
			if (record.pending.some((entry) => entry.replaces && ids.has(entry.id))) {record.replaced = false;}
			record.pending = record.pending.filter((entry) => !ids.has(entry.id));
			record.offered = record.offered.filter((id) => !ids.has(id));
			record.waitingReceipt = record.waitingReceipt.filter((id) => !ids.has(id));
			this.sync(record);
			this.route(record);
			this.changed(record);
		}
	}

	/** The parent ended a batch without committing these await results. */
	releaseWaitClaims(): void {
		for (const record of this.records.values()) {
			if (record.waitingReceipt.length === 0) {continue;}
			record.waitingReceipt = [];
			this.route(record);
		}
	}

	setHold(ref: ChildRef, held: boolean): void {
		const record = this.record(ref);
		if (record.held === held) {return;}
		if (held) {this.withdraw(record);}
		record.held = held;
		this.sync(record);
		this.route(record);
		this.changed(record);
	}

	hold(ref: ChildRef): HoldRecord {
		const record = this.records.get(refKey(ref));
		return record ? this.holdOf(record) : EMPTY_HOLD;
	}

	/** Preview results for an outer teardown. Only the original parent can acknowledge them. */
	pendingAnswers(ref: ChildRef): readonly Settlement[] {
		const record = this.records.get(refKey(ref));
		return record ? answerReports(record.pending) : [];
	}

	/** Return undelivered answers for a teardown report and settle any active wait. */
	removed(ref: ChildRef): readonly Settlement[] {
		const record = this.records.get(refKey(ref));
		if (record) {this.withdraw(record);}
		const held = record ? answerReports(unclaimed(record)) : [];
		this.records.delete(refKey(ref));
		this.active?.remove(ref, held.at(-1));
		return held;
	}

	wait(refs: readonly ChildRef[]): ChildWait {
		if (this.active) {throw new Error("Another await_agents call is already active.");}
		for (const ref of refs) {
			const record = this.records.get(refKey(ref));
			if (record) {this.withdraw(record);}
		}
		const wait = new ActiveWait(refs, {
			status: (ref) => this.waitStatus(ref),
			finish: (result) => this.finishWait(wait, result.receipts),
			cancel: () => this.finishWait(wait, []),
		});
		this.active = wait;
		wait.evaluate();
		return wait;
	}

	clear(): void {
		this.active?.cancel();
		this.records.clear();
	}

	private record(ref: ChildRef): ChildRecord {
		const key = refKey(ref);
		let record = this.records.get(key);
		if (!record) {
			record = {
				ref: { path: [...ref.path], incarnation: ref.incarnation },
				held: false,
				running: false,
				runId: 0,
				run: [],
				pending: [],
				offered: [],
				waitingReceipt: [],
				replaced: false,
				saved: JSON.stringify(EMPTY_HOLD),
			};
			this.records.set(key, record);
		}
		return record;
	}

	private holdOf(record: ChildRecord): HoldRecord {
		return { held: record.held, pending: [...record.pending], replaced: record.replaced };
	}

	private sync(record: ChildRecord, force = false): void {
		const hold = this.holdOf(record);
		const serialized = JSON.stringify(hold);
		if (force || serialized !== record.saved) {
			this.host.persistHold(record.ref, hold);
			record.saved = serialized;
		}
		this.host.publishHold(record.ref, hold);
	}

	private withdraw(record: ChildRecord): void {
		if (record.offered.length > 0 && this.host.withdraw(record.ref)) {record.offered = [];}
	}

	/** Offer one whole run at a time. A run that only stopped sends no notice. */
	private route(record: ChildRecord, previousRun = false): void {
		if (record.held || record.offered.length > 0 || record.waitingReceipt.length > 0) {return;}
		while (record.pending.length > 0) {
			const first = record.pending[0];
			if (!previousRun && first.run === record.runId && this.active?.covers(record.ref)) {return;}
			const group = record.pending.filter((entry) => entry.run === first.run);
			const answer = report(group.map((entry) => entry.settlement));
			if (isAnswer(answer)) {
				record.offered = group.map((entry) => entry.id);
				this.host.offer(record.ref, answer, group.some((entry) => entry.replaces), record.offered);
				return;
			}
			record.pending.splice(0, group.length);
			this.sync(record);
		}
	}

	private changed(record: ChildRecord): void {
		if (this.active?.covers(record.ref)) {this.active.evaluate();}
	}

	private waitStatus(ref: ChildRef): WaitEntry {
		const record = this.records.get(refKey(ref));
		const live = this.host.live(ref);
		const path = [...ref.path];
		if (!live) {return { resolved: true, status: { path, state: "removed" } };}
		if (record?.held && (record.pending.length > 0 || live.settlement)) {
			return { resolved: false, status: { path, state: "held" } };
		}
		if (record?.running || !live.settlement) {
			return { resolved: false, status: { path, state: live.state === "waiting" ? "waiting" : "running" } };
		}
		const group = record ? unclaimed(record).filter((entry) => entry.run === record.runId) : [];
		const source = group.length > 0 ? group.map((entry) => entry.settlement) : record?.run ?? [];
		const settlement = source.length > 0 ? report(source) : live.settlement;
		return {
			resolved: true,
			status: { path, ...settlement, ...(group.some((entry) => entry.replaces) ? { replacedHeldResult: true } : undefined) },
			receipts: group.map((entry) => entry.id),
		};
	}

	private finishWait(wait: ActiveWait, receipts: readonly string[]): void {
		if (this.active !== wait) {return;}
		this.active = undefined;
		const ids = new Set(receipts);
		for (const ref of wait.refs) {
			const record = this.records.get(refKey(ref));
			if (!record) {continue;}
			record.waitingReceipt = [...record.waitingReceipt, ...record.pending.flatMap((entry) => ids.has(entry.id) ? [entry.id] : [])];
			this.route(record);
		}
	}
}

function isAnswer(settlement: Settlement): boolean {
	return settlement.state !== "stopped";
}

function claimed(record: ChildRecord, id: string): boolean {
	return record.offered.includes(id) || record.waitingReceipt.includes(id);
}

function unclaimed(record: ChildRecord): PendingSettlement[] {
	return record.pending.filter((entry) => !claimed(record, entry.id));
}

function answerReports(pending: readonly PendingSettlement[]): Settlement[] {
	return [...Map.groupBy(pending, (entry) => entry.run).values()].flatMap((group) => {
		const answer = report(group.map((entry) => entry.settlement));
		return isAnswer(answer) ? [answer] : [];
	});
}

/** The latest outcome and its retained answer, if the runtime died after answering. */
function report(settlements: readonly Settlement[]): Settlement {
	const latest = required(settlements.at(-1), "latest settlement");
	const answer = settlements.findLast(isAnswer);
	if (!answer) {return latest;}
	const output = settlements.findLast((entry) => entry.output !== undefined)?.output;
	return { ...answer, ...(output !== undefined ? { output } : undefined) };
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
		this.refs = [...new Map(refs.map((ref) => [refKey(ref), ref])).values()];
		this.result = new Promise<WaitResult>((resolve, reject) => {
			this.resolve = resolve;
			this.reject = reject;
		});
	}

	covers(ref: ChildRef): boolean {
		return !this.done && this.refs.some((candidate) => refKey(candidate) === refKey(ref));
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
			...(held?.error !== undefined ? { error: held.error } : undefined),
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
		if (!this.done) {this.finish(true, this.entries());}
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
			return removed ? { resolved: true, status: removed } : this.hooks.status(ref);
		});
	}

	private finish(interrupted: boolean, entries: readonly WaitEntry[]): void {
		this.done = true;
		this.listeners.clear();
		const result: WaitResult = {
			interrupted,
			statuses: entries.map((entry) => entry.status),
			receipts: entries.flatMap((entry) => entry.receipts ?? []),
		};
		this.hooks.finish(result);
		this.resolve(result);
	}
}

function refKey(ref: ChildRef): string {
	return JSON.stringify([ref.path, ref.incarnation]);
}
