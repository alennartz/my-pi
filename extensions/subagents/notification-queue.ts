/**
 * Parent notifications from child agents.
 *
 * Notices stay in this queue until the parent can take them. They never enter
 * pi's steering queue, which a host can clear:
 *
 * - Parent idle: one message starts a turn.
 * - Parent running: messages go out at the next turn boundary, as context
 *   for the next model request in the same run.
 * - Parent waiting in `await_agents`: the wait decides what it consumes.
 * - Parent run aborted: messages are appended without starting a turn
 *   (DR-072), so a stop stays a stop and nothing is lost.
 */

import type { SubagentCard } from "./presenters.js";
import type { ChildRef } from "./settlements.js";

export type NoticeKind = "message" | "completion" | "notice";

export type Notice = Readonly<{
	kind: NoticeKind;
	content: string;
	card?: SubagentCard;
	/** Exact settlements carried by this notice's text. */
	settles?: Readonly<{ ref: ChildRef; ids: readonly string[] }>;
}>;

/** `trigger` starts a turn, `context` joins the running turn, `park` appends without a turn. */
export type NoticeDelivery = "trigger" | "context" | "park";

export class NotificationQueue {
	private entries: Notice[] = [];
	private runActive = false;
	private waiting = false;
	private scheduled = false;

	constructor(private readonly deliver: (notices: readonly Notice[], mode: NoticeDelivery) => void) {}

	queue(notice: Notice): void {
		this.entries.push(notice);
		this.schedule();
	}

	/** True when a child message the parent has not seen is queued. */
	hasMessages(): boolean {
		return this.entries.some((entry) => entry.kind === "message");
	}

	/** Remove and return the queued notices a wait consumes. */
	take(predicate: (notice: Notice) => boolean): Notice[] {
		const taken = this.entries.filter(predicate);
		this.entries = this.entries.filter((entry) => !predicate(entry));
		return taken;
	}

	/** Put notices that never reached the parent back at the front, in order. */
	requeue(notices: readonly Notice[]): void {
		if (notices.length === 0) {return;}
		this.entries = [...notices, ...this.entries];
		this.schedule();
	}

	runStarted(): void {
		this.runActive = true;
	}

	/** A turn boundary inside a run. Returns true when notices joined the run, so it must continue. */
	boundary(): boolean {
		if (this.waiting || this.entries.length === 0) {return false;}
		this.flush("context");
		return true;
	}

	runSettled(aborted: boolean): void {
		this.runActive = false;
		if (this.waiting || this.entries.length === 0) {return;}
		if (aborted) {
			this.flush("park");
			return;
		}
		this.flush("trigger");
	}

	setWaiting(waiting: boolean): void {
		this.waiting = waiting;
		this.schedule();
	}

	clear(): void {
		this.entries = [];
	}

	private schedule(): void {
		if (this.scheduled || this.runActive || this.waiting) {return;}
		this.scheduled = true;
		queueMicrotask(() => {
			this.scheduled = false;
			if (this.runActive || this.waiting || this.entries.length === 0) {return;}
			this.flush("trigger");
		});
	}

	private flush(mode: NoticeDelivery): void {
		const notices = this.entries;
		this.entries = [];
		this.deliver(notices, mode);
	}
}
