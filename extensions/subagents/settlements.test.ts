import { describe, expect, it } from "vitest";
import type { SubagentState } from "@pimote/sdk/subagents";
import { SettlementLedger } from "./settlements.js";
import type { ChildRef, HoldRecord, LiveChild, Settlement } from "./settlements.js";

type Notice = { path: readonly string[]; settlement: Settlement; replaced: boolean };
type Offer = Notice & { ref: ChildRef; ids: readonly string[] };

function harness() {
	const notices: Notice[] = [];
	const outbox: Offer[] = [];
	const persisted = new Map<string, HoldRecord>();
	const live = new Map<string, LiveChild>();
	const ledger: SettlementLedger = new SettlementLedger({
		offer: (ref, settlement, replaced, ids) => outbox.push({ ref, ids, path: ref.path, settlement, replaced }),
		withdraw: (ref) => {
			const index = outbox.findIndex((offer) => offer.ref.incarnation === ref.incarnation);
			if (index === -1) {return false;}
			outbox.splice(index, 1);
			return true;
		},
		persistHold: (ref, hold) => persisted.set(ref.incarnation, hold),
		commitRemoved: () => undefined,
		publishHold: () => undefined,
		live: (ref) => live.get(ref.incarnation),
	});
	const child = (id: string, incarnation = `${id}-1`): ChildRef => {
		live.set(incarnation, { state: "running" });
		return { path: [id], incarnation };
	};
	const run = (ref: ChildRef): void => {
		live.set(ref.incarnation, { state: "running" });
		ledger.runStarted(ref);
	};
	const settle = (ref: ChildRef, settlement: Settlement): void => {
		const state: SubagentState = settlement.state === "stopped" ? "idle" : settlement.state;
		live.set(ref.incarnation, { state, settlement: { ...settlement, state: settlement.state === "stopped" ? "idle" : settlement.state } });
		ledger.settled(ref, settlement);
	};
	const remove = (ref: ChildRef) => {
		live.delete(ref.incarnation);
		return ledger.removed(ref, "model", () => undefined);
	};
	/** The parent's session commits every queued notice. */
	const commit = (): Notice[] => {
		for (let offer = outbox.shift(); offer; offer = outbox.shift()) {
			notices.push({ path: offer.path, settlement: offer.settlement, replaced: offer.replaced });
			ledger.delivered(new Set(offer.ids));
		}
		return notices;
	};
	return { ledger, notices, commit, outbox, persisted, child, run, settle, remove };
}

const idle = (output: string): Settlement => ({ state: "idle", output });

describe("SettlementLedger", () => {
	it("delivers an unheld settlement to the parent once", () => {
		const { commit, child, run, settle } = harness();
		const worker = child("worker");
		run(worker);
		settle(worker, idle("done"));
		expect(commit()).toEqual([{ path: ["worker"], settlement: idle("done"), replaced: false }]);
	});

	it("holds settlements until the user releases the child", () => {
		const { ledger, commit, child, run, settle } = harness();
		const worker = child("worker");
		ledger.setHold(worker, true);
		run(worker);
		settle(worker, idle("answer"));
		expect(commit()).toEqual([]);
		ledger.setHold(worker, false);
		expect(commit().map((notice) => notice.settlement.output)).toEqual(["answer"]);
	});

	it("marks the next answer as a replacement when a new run discards a held one, across stops", () => {
		const { ledger, commit, child, run, settle } = harness();
		const worker = child("worker");
		ledger.setHold(worker, true);
		run(worker);
		settle(worker, idle("first"));
		run(worker);
		settle(worker, { state: "stopped" });
		run(worker);
		settle(worker, idle("third"));
		ledger.setHold(worker, false);
		expect(commit()).toEqual([{ path: ["worker"], settlement: idle("third"), replaced: true }]);
	});

	it("delivers an unheld answer a wait collected when the child starts again before the wait ends", async () => {
		const { ledger, commit, child, run, settle } = harness();
		const worker = child("worker");
		const scout = child("scout");
		run(worker);
		run(scout);
		const wait = ledger.wait([worker, scout]);
		settle(worker, idle("first"));
		run(worker);
		settle(scout, idle("s"));
		settle(worker, idle("second"));
		const result = await wait.result;
		expect(commit()).toEqual([{ path: ["worker"], settlement: idle("first"), replaced: false }]);
		expect(result.statuses.map((status) => [status.output, status.replacedHeldResult])).toEqual([["second", undefined], ["s", undefined]]);
	});

	it("reports a held answer together with a later runtime death in one delivery, through a notice or a wait", async () => {
		const notice = harness();
		const worker = notice.child("worker");
		notice.ledger.setHold(worker, true);
		notice.run(worker);
		notice.settle(worker, idle("answer"));
		notice.settle(worker, { state: "dead", error: "gone" });
		notice.ledger.setHold(worker, false);
		expect(notice.commit()).toEqual([{ path: ["worker"], settlement: { state: "dead", error: "gone", output: "answer" }, replaced: false }]);

		const waited = harness();
		const scout = waited.child("scout");
		waited.ledger.setHold(scout, true);
		waited.run(scout);
		waited.settle(scout, idle("answer"));
		waited.settle(scout, { state: "dead", error: "gone" });
		const wait = waited.ledger.wait([scout]);
		waited.ledger.setHold(scout, false);
		const result = await wait.result;
		expect(result.statuses).toEqual([{ path: ["scout"], state: "dead", error: "gone", output: "answer" }]);
		waited.ledger.delivered(new Set(result.receipts));
		expect(waited.commit()).toEqual([]);
		expect(waited.ledger.hold(scout).pending).toEqual([]);
	});

	it("keeps a released answer pending until the parent commits it, so a restore never delivers it again", () => {
		const first = harness();
		const worker = first.child("worker");
		first.ledger.setHold(worker, true);
		first.run(worker);
		first.settle(worker, idle("kept"));
		first.ledger.setHold(worker, false);
		expect(first.persisted.get(worker.incarnation)).toMatchObject({ held: false, pending: [{ settlement: idle("kept") }], replaced: false });
		first.commit();
		const saved = first.persisted.get(worker.incarnation);
		expect(saved).toEqual({ held: false, pending: [], replaced: false });

		const restored = harness();
		restored.ledger.restore(restored.child("worker", "worker-2"), saved!);
		expect(first.commit().map((notice) => notice.settlement.output)).toEqual(["kept"]);
		expect(restored.commit()).toEqual([]);
	});

	it("saves the delivered state when a released answer reaches the parent through a wait", async () => {
		const { ledger, persisted, child, run, settle } = harness();
		const worker = child("worker");
		ledger.setHold(worker, true);
		run(worker);
		settle(worker, idle("kept"));
		const wait = ledger.wait([worker]);
		ledger.setHold(worker, false);
		const result = await wait.result;
		ledger.delivered(new Set(result.receipts));
		expect(persisted.get(worker.incarnation)).toEqual({ held: false, pending: [], replaced: false });
	});

	it("delivers a saved unheld answer whose delivery never completed", () => {
		const restored = harness();
		restored.ledger.restore(restored.child("worker"), { held: false, pending: [{ id: "uncommitted", run: 1, settlement: idle("in flight") }], replaced: false });
		expect(restored.commit().map((notice) => notice.settlement.output)).toEqual(["in flight"]);
	});

	it("persists the hold and the undelivered answers, and a restored hold releases without redelivering what the parent has", () => {
		const first = harness();
		const worker = first.child("worker");
		first.ledger.setHold(worker, true);
		first.run(worker);
		first.settle(worker, idle("kept"));
		const saved = first.persisted.get(worker.incarnation);
		expect(saved).toMatchObject({ held: true, pending: [{ settlement: idle("kept") }], replaced: false });

		const restored = harness();
		const again = restored.child("worker", "worker-2");
		restored.ledger.restore(again, saved!);
		expect(restored.commit()).toEqual([]);
		restored.ledger.setHold(again, false);
		expect(restored.commit().map((notice) => notice.settlement.output)).toEqual(["kept"]);

		const delivered = harness();
		const later = delivered.child("worker", "worker-3");
		delivered.ledger.restore(later, { held: true, pending: [], replaced: false });
		delivered.ledger.setHold(later, false);
		expect(delivered.commit()).toEqual([]);
	});

	it("takes back a queued answer when the user holds the child before the parent receives it", () => {
		const { ledger, commit, outbox, child, run, settle } = harness();
		const worker = child("worker");
		run(worker);
		settle(worker, idle("answer"));
		expect(outbox).toHaveLength(1);
		ledger.setHold(worker, true);
		expect(commit()).toEqual([]);
		ledger.setHold(worker, false);
		expect(commit().map((notice) => notice.settlement.output)).toEqual(["answer"]);
	});

	it("keeps an answer that already left for the parent when a hold arrives too late", () => {
		const { ledger, commit, outbox, child, run, settle } = harness();
		const worker = child("worker");
		run(worker);
		settle(worker, idle("answer"));
		const sent = outbox.splice(0);
		ledger.setHold(worker, true);
		ledger.delivered(new Set(sent[0].ids));
		expect(ledger.hold(worker)).toEqual({ held: true, pending: [], replaced: false });
		expect(commit()).toEqual([]);
	});

	describe("waits", () => {
		it("resolves with every requested child's outcome and delivers them through the wait", async () => {
			const { ledger, commit, child, run, settle } = harness();
			const worker = child("worker");
			const scout = child("scout");
			run(worker);
			run(scout);
			const wait = ledger.wait([worker, scout]);
			settle(worker, idle("w"));
			settle(scout, { state: "stopped" });
			const result = await wait.result;
			expect(result.interrupted).toBe(false);
			expect(result.statuses.map((status) => [status.path, status.state])).toEqual([[["worker"], "idle"], [["scout"], "stopped"]]);
			expect(commit()).toEqual([]);
		});

		it("reports a removed child in the wait and reserves its held answer for teardown",  async () => {
			const { ledger, child, run, settle, remove } = harness();
			const worker = child("worker");
			const scout = child("scout");
			run(worker);
			run(scout);
			ledger.setHold(worker, true);
			settle(worker, idle("held answer"));
			const wait = ledger.wait([worker, scout]);
			expect(remove(worker).answers.map((settlement) => settlement.output)).toEqual(["held answer"]);
			settle(scout, idle("s"));
			const result = await wait.result;
			expect(result.statuses[0]).toEqual({ path: ["worker"], state: "removed" });
		});

		it("reports a held child as held and does not count it as settled", () => {
			const { ledger, child, run, settle } = harness();
			const worker = child("worker");
			ledger.setHold(worker, true);
			run(worker);
			settle(worker, idle("answer"));
			const wait = ledger.wait([worker]);
			expect(wait.statuses()).toEqual([{ path: ["worker"], state: "held" }]);
			ledger.setHold(worker, false);
			return expect(wait.result).resolves.toMatchObject({ statuses: [{ path: ["worker"], state: "idle", output: "answer" }] });
		});

		it("keeps undelivered settlements when the parent stops the wait", async () => {
			const { ledger, commit, child, run, settle } = harness();
			const worker = child("worker");
			const scout = child("scout");
			run(worker);
			run(scout);
			const wait = ledger.wait([worker, scout]);
			settle(worker, idle("w"));
			wait.cancel();
			await expect(wait.result).rejects.toThrow("Wait cancelled.");
			expect(commit().map((notice) => notice.settlement.output)).toEqual(["w"]);
		});

		it("ends on interrupt with the outcomes settled so far, leaving the rest to notices", async () => {
			const { ledger, commit, child, run, settle } = harness();
			const worker = child("worker");
			const scout = child("scout");
			run(worker);
			run(scout);
			const wait = ledger.wait([worker, scout]);
			settle(worker, idle("w"));
			wait.interrupt();
			const result = await wait.result;
			expect(result.interrupted).toBe(true);
			expect(result.statuses.map((status) => status.state)).toEqual(["idle", "running"]);
			settle(scout, idle("s"));
			expect(commit().map((notice) => notice.settlement.output)).toEqual(["s"]);
		});

		it("reports a queued replacement through the wait with its note", async () => {
			const { ledger, commit, outbox, child, run, settle } = harness();
			const worker = child("worker");
			ledger.setHold(worker, true);
			run(worker);
			settle(worker, idle("first"));
			run(worker);
			settle(worker, idle("second"));
			ledger.setHold(worker, false);
			expect(outbox).toHaveLength(1);
			const result = await ledger.wait([worker]).result;
			expect(result.statuses).toEqual([{ path: ["worker"], state: "idle", output: "second", replacedHeldResult: true }]);
			expect(commit()).toEqual([]);
		});

		it("claims nothing when another wait is active", () => {
			const { ledger, commit, child, run, settle } = harness();
			const worker = child("worker");
			const scout = child("scout");
			run(worker);
			run(scout);
			ledger.wait([worker]);
			settle(scout, idle("s"));
			expect(() => ledger.wait([scout])).toThrow(/already active/);
			expect(commit().map((notice) => notice.settlement.output)).toEqual(["s"]);
		});

		it("never lets a later incarnation at the same path satisfy a wait", async () => {
			const { ledger, child, run, settle, remove } = harness();
			const first = child("worker", "a");
			run(first);
			const other = child("other");
			run(other);
			const wait = ledger.wait([first, other]);
			remove(first);
			const second = child("worker", "b");
			run(second);
			settle(second, idle("new task"));
			settle(other, idle("o"));
			const result = await wait.result;
			expect(result.statuses[0]).toEqual({ path: ["worker"], state: "removed" });
		});

		it("resolves at once for a child that settled before the wait", async () => {
			const { ledger, child, run, settle } = harness();
			const worker = child("worker");
			run(worker);
			settle(worker, idle("earlier"));
			const result = await ledger.wait([worker]).result;
			expect(result.statuses).toEqual([{ path: ["worker"], state: "idle", output: "earlier" }]);
		});
	});
});
