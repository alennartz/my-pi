import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SubagentAgentStatus } from "@pimote/sdk/subagents";
import type { AgentPath } from "./agent-path.js";
import type { AgentSessionRegistry } from "./agent-session-registry.js";
import { isSettledState } from "./agent-set.js";
import type { AgentCompletionOutcome, SubagentManager } from "./agent-set.js";
import { serializeAgentComplete, serializeAwaitStatus } from "./messages.js";
import { NotificationQueue } from "./notification-queue.js";
import type { Notice, NoticeDelivery } from "./notification-queue.js";
import { messageCardDetails } from "./presenters.js";
import type { SubagentCard } from "./presenters.js";
import { SettlementLedger } from "./settlements.js";
import type { ChildRef, HoldRecord, LiveChild, Settlement } from "./settlements.js";
import { createStopSequenceManager } from "./stop-sequences.js";
import type { StopSequenceManager } from "./stop-sequences.js";
import { truncateForModel, truncateMiddle } from "../../lib/truncate.ts";

/** What `await_agents` reports. */
export type AwaitReport = Readonly<{
	text: string;
	statuses: readonly SubagentAgentStatus[];
	interrupted: boolean;
	error?: string;
}>;

/**
 * Turn-level coordination for one manager: the settlement ledger, the parent
 * notification queue, waits, and stop markers.
 */
export class TurnCoordinator {
	private readonly queue: NotificationQueue;
	private readonly stopSequences: StopSequenceManager;
	private readonly notifiedTierIssues = new Set<string>();
	private readonly ledger: SettlementLedger;
	private interruptWait: (() => void) | undefined;
	private bound: { manager: SubagentManager; registry: AgentSessionRegistry } | undefined;

	constructor(private readonly pi: ExtensionAPI) {
		this.queue = new NotificationQueue((notices, mode) => this.deliver(notices, mode));
		this.stopSequences = typeof pi.on === "function"
			? createStopSequenceManager(pi)
			: { add() {}, remove() {}, addOnce() {}, clear() {} };
		this.ledger = new SettlementLedger({
			notify: (ref, settlement, replaced) => this.notifyCompletion(ref, settlement, replaced),
			persistHold: (ref, hold) => this.manager().persistHold(ref, hold),
			publishHold: (ref, hold) => this.publishHold(ref, hold),
			live: (ref) => this.live(ref),
		});
	}

	bind(manager: SubagentManager, registry: AgentSessionRegistry): void {
		this.bound = { manager, registry };
	}

	// Child lifecycle, reported by the manager.

	childStarted(agentId: string): void {
		const ref = this.manager().getAgentRef(agentId);
		if (ref) {this.ledger.runStarted(ref);}
	}

	childSettled(agentId: string, outcome: AgentCompletionOutcome = {}): void {
		const manager = this.manager();
		const ref = manager.getAgentRef(agentId);
		const status = manager.getAgentStatus(agentId);
		if (!ref || !status) {return;}
		const state = outcome.aborted ? "stopped" : status.state === "errored" ? "errored" : status.state === "dead" ? "dead" : "idle";
		this.ledger.settled(ref, {
			state,
			...(state !== "stopped" && status.lastOutput !== undefined ? { output: status.lastOutput } : undefined),
			...(state === "errored" || state === "dead" ? { error: status.lastError || "Agent run ended with an error" } : undefined),
			...(manager.getSessionId(agentId) !== undefined ? { sessionId: manager.getSessionId(agentId) } : undefined),
			usage: status.usage,
		});
	}

	childRemoved(ref: ChildRef): readonly Settlement[] {
		return this.ledger.removed(ref);
	}

	childRestored(ref: ChildRef, hold: HoldRecord): void {
		this.ledger.restore(ref, hold);
	}

	setHold(ref: ChildRef, held: boolean): void {
		this.ledger.setHold(ref, held);
	}

	// Parent notices.

	queueMessage(content: string, card: SubagentCard): void {
		this.queue.queue({ kind: "message", content, card });
		this.interruptWait?.();
	}

	// Parent run boundaries.

	runStarted(): void {
		this.queue.runStarted();
	}

	/** A turn boundary inside a parent run. True when notices joined the run. */
	boundary(): boolean {
		return this.queue.boundary();
	}

	runSettled(aborted: boolean): void {
		this.queue.runSettled(aborted);
	}

	// Waits.

	async awaitAgents(
		ids: readonly string[],
		signal: AbortSignal | undefined,
		onProgress: (statuses: readonly SubagentAgentStatus[]) => void,
	): Promise<AwaitReport> {
		const manager = this.manager();
		const blocked = manager.getBlockedSenders().filter((pending) => ids.includes(pending.from));
		if (blocked.length > 0) {
			const names = blocked.map((pending) => pending.from);
			const text = `Cannot wait: ${names.join(", ")} ${names.length === 1 ? "is" : "are"} blocked on a response from you, ` +
				`so ${names.length === 1 ? "it" : "they"} cannot settle until you answer. ` +
				"Call respond for each pending correlation_id (the question arrived as an <agent_message>), " +
				"then call await_agents again if you still need to wait.";
			const statuses = this.currentStatuses(ids);
			return { text, statuses, interrupted: true, error: `Cannot wait: ${names.join(", ")} must receive your response before settling.` };
		}
		if (this.queue.hasMessages()) {
			return {
				text: "A message reached you before this wait began. It follows this result; read it before you wait again.",
				statuses: this.currentStatuses(ids),
				interrupted: true,
			};
		}
		if (signal?.aborted) {throw new Error("Wait cancelled.");}
		const refs = ids.flatMap((id) => {
			const ref = manager.getAgentRef(id);
			return ref ? [ref] : [];
		});
		const wait = this.ledger.wait(refs);
		this.queue.setWaiting(true);
		const stopProgress = wait.onChange(() => onProgress(wait.statuses()));
		onProgress(wait.statuses());
		const onAbort = (): void => wait.cancel();
		signal?.addEventListener("abort", onAbort, { once: true });
		this.interruptWait = () => wait.interrupt();
		try {
			const result = await wait.result;
			this.queue.take((notice) => {
				const source = notice.ref;
				return notice.kind === "completion" && source !== undefined && result.delivered.some((ref) => sameRef(ref, source));
			});
			const lines = result.statuses.map((status) => serializeAwaitStatus({
				id: status.path.at(-1) ?? "",
				state: status.state,
				...(status.output !== undefined ? { output: status.output } : undefined),
				...(status.error !== undefined ? { error: status.error } : undefined),
				...(status.sessionId !== undefined ? { sessionId: status.sessionId } : undefined),
				...(status.replacedHeldResult ? { replaced: true } : undefined),
			}));
			if (result.interrupted) {lines.unshift("Wait interrupted: a message reached you. It follows this result.");}
			return {
				text: (await truncateForModel(lines.join("\n"))).text,
				statuses: result.statuses,
				interrupted: result.interrupted,
			};
		} finally {
			this.interruptWait = undefined;
			signal?.removeEventListener("abort", onAbort);
			stopProgress();
			this.queue.setWaiting(false);
		}
	}

	/** Live per-child status without a wait. */
	currentStatuses(ids: readonly string[]): SubagentAgentStatus[] {
		const manager = this.manager();
		return ids.flatMap((id) => {
			const ref = manager.getAgentRef(id);
			const live = ref ? this.live(ref) : undefined;
			if (!ref || !live) {return [];}
			const held = this.ledger.hold(ref).held && live.settlement !== undefined;
			return [{
				path: [...ref.path],
				state: held ? "held" : live.state,
				...(!held && live.settlement?.output !== undefined ? { output: live.settlement.output } : undefined),
				...(!held && live.settlement?.error !== undefined ? { error: live.settlement.error } : undefined),
				...(live.settlement?.sessionId !== undefined ? { sessionId: live.settlement.sessionId } : undefined),
			}];
		});
	}

	// Misc turn state.

	addStopSequenceOnce(sequence: string): void {
		this.stopSequences.addOnce(sequence);
	}

	notifyTierIssueOnce(
		ctx: { ui: { notify(message: string, type?: "info" | "warning" | "error"): void } },
		message: string,
	): void {
		if (this.notifiedTierIssues.has(message)) {return;}
		this.notifiedTierIssues.add(message);
		ctx.ui.notify(message, "warning");
	}

	clear(): void {
		this.ledger.clear();
		this.queue.clear();
		this.stopSequences.clear();
	}

	private manager(): SubagentManager {
		if (!this.bound) {throw new Error("Turn coordinator is not bound to a manager");}
		return this.bound.manager;
	}

	private live(ref: ChildRef): LiveChild | undefined {
		const snapshot = this.bound?.registry.getSnapshot(ref.path);
		if (!snapshot || snapshot.ownership !== "registry" || snapshot.incarnation !== ref.incarnation) {return undefined;}
		const operational = snapshot.operational;
		if (!isSettledState(operational.state)) {return { state: operational.state };}
		const failed = operational.state === "errored" || operational.state === "dead";
		return {
			state: operational.state,
			settlement: {
				state: operational.state === "errored" ? "errored" : operational.state === "dead" ? "dead" : "idle",
				...(operational.lastOutput !== undefined ? { output: operational.lastOutput } : undefined),
				...(failed ? { error: operational.lastError || "Agent run ended with an error" } : undefined),
				sessionId: snapshot.sessionId,
				usage: operational.usage,
			},
		};
	}

	private publishHold(ref: ChildRef, hold: HoldRecord): void {
		const registry = this.bound?.registry;
		const snapshot = registry?.getSnapshot(ref.path);
		if (!registry || !snapshot || snapshot.incarnation !== ref.incarnation) {return;}
		const heldSettlement = hold.held ? hold.pending.at(-1)?.state : undefined;
		const { held: _held, heldSettlement: _settlement, ...operational } = snapshot.operational;
		registry.updateOperational(ref.path, {
			...operational,
			...(hold.held ? { held: true } : undefined),
			...(heldSettlement !== undefined ? { heldSettlement } : undefined),
		});
	}

	private notifyCompletion(ref: ChildRef, settlement: Settlement, replaced: boolean): void {
		const manager = this.manager();
		const id = ref.path.at(-1) ?? "";
		const state = settlement.state === "stopped" ? "idle" : settlement.state;
		let content = serializeAgentComplete({
			id,
			status: state,
			output: settlement.output,
			error: settlement.error,
			sessionId: settlement.sessionId,
			...(replaced ? { replaced: true } : undefined),
		});
		if (manager.allDone()) {
			const total = manager.getAgentStatuses().length;
			content += `\n\nAll ${total} agent${total === 1 ? "" : "s"} have settled. Use send to ask questions or continue their work. When you're done with them, call teardown to clean up.`;
		}
		this.queue.queue({ kind: "completion", ref, content, card: completionCard(ref.path, settlement, replaced) });
	}

	private deliver(notices: readonly Notice[], mode: NoticeDelivery): void {
		const cards = notices.flatMap((notice) => notice.card ? [notice.card] : []);
		const message = {
			customType: "subagents",
			content: truncateMiddle(notices.map((notice) => notice.content).join("\n")).content,
			display: true,
			details: messageCardDetails(cards),
		};
		this.pi.sendMessage(message, mode === "trigger" ? { triggerTurn: true } : { triggerTurn: false });
	}
}

/** The card of one child completion notice. */
export function completionCard(path: AgentPath, settlement: Settlement, replaced: boolean): SubagentCard {
	return {
		kind: "completion",
		state: settlement.state === "errored" || settlement.state === "dead" ? "error" : settlement.state === "stopped" ? "aborted" : "complete",
		data: {
			operation: "completion",
			parameters: {},
			result: {
				path: [...path],
				...settlement,
				...(replaced ? { replacedHeldResult: true } : undefined),
			},
		},
	};
}

function sameRef(left: ChildRef, right: ChildRef): boolean {
	return left.incarnation === right.incarnation && JSON.stringify(left.path) === JSON.stringify(right.path);
}
