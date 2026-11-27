import { describe, expect, it } from "vitest";
import type { SubagentState } from "@pimote/sdk/subagents";
import { SettlementLedger } from "./settlements.js";
import type { ChildRef, HoldRecord, LiveChild, Settlement } from "./settlements.js";

type Notice = { path: readonly string[]; settlement: Settlement; replaced: boolean };

function harness() {
	const notices: Notice[] = [];
	const persisted = new Map<string, HoldRecord>();
	const live = new Map<string, LiveChild>();
	const ledger = new SettlementLedger({
		notify: (ref, settlement, replaced) => notices.push({ path: ref.path, settlement, replaced }),
		persistHold: (ref, hold) => persisted.set(ref.incarnation, hold),
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
		return ledger.removed(ref);
	};
	return { ledger, notices, persisted, child, run, settle, remove };
}

const idle = (output: string): Settlement => ({ state: "idle", output });

describe("SettlementLedger", () => {
	it("delivers an unheld settlement to the parent once", () => {
		const { notices, child, run, settle } = harness();
		const worker = child("worker");
		run(worker);
		settle(worker, idle("done"));
		expect(notices).toEqual([{ path: ["worker"], settlement: idle("done"), replaced: false }]);
	});

	it("holds settlements until the user releases the child", () => {
		const { ledger, notices, child, run, settle } = harness();
		const worker = child("worker");
		ledger.setHold(worker, true);
		run(worker);
		settle(worker, idle("answer"));
		expect(notices).toEqual([]);
		ledger.setHold(worker, false);
		expect(notices.map((notice) => notice.settlement.output)).toEqual(["answer"]);
	});

	it("marks the next answer as a replacement when a new run discards a held one, across stops", () => {
		const { ledger, notices, child, run, settle } = harness();
		const worker = child("worker");
		ledger.setHold(worker, true);
		run(worker);
		settle(worker, idle("first"));
		run(worker);
		settle(worker, { state: "stopped" });
		run(worker);
		settle(worker, idle("third"));
		ledger.setHold(worker, false);
		expect(notices).toEqual([{ path: ["worker"], settlement: idle("third"), replaced: true }]);
	});

	it("keeps a held answer when the runtime dies without a new run, and delivers both", () => {
		const { ledger, notices, child, run, settle } = harness();
		const worker = child("worker");
		ledger.setHold(worker, true);
		run(worker);
		settle(worker, idle("answer"));
		settle(worker, { state: "dead", error: "gone" });
		ledger.setHold(worker, false);
		expect(notices.map((notice) => [notice.settlement.state, notice.replaced])).toEqual([["idle", false], ["dead", false]]);
	});

	it("persists the hold and the undelivered answers, and a restored hold releases without redelivering what the parent has", () => {
		const first = harness();
		const worker = first.child("worker");
		first.ledger.setHold(worker, true);
		first.run(worker);
		first.settle(worker, idle("kept"));
		const saved = first.persisted.get(worker.incarnation);
		expect(saved).toEqual({ held: true, pending: [idle("kept")], replaced: false });

		const restored = harness();
		const again = restored.child("worker", "worker-2");
		restored.ledger.restore(again, saved!);
		expect(restored.notices).toEqual([]);
		restored.ledger.setHold(again, false);
		expect(restored.notices.map((notice) => notice.settlement.output)).toEqual(["kept"]);

		const delivered = harness();
		const later = delivered.child("worker", "worker-3");
		delivered.ledger.restore(later, { held: true, pending: [], replaced: false });
		delivered.ledger.setHold(later, false);
		expect(delivered.notices).toEqual([]);
	});

	describe("waits", () => {
		it("resolves with every requested child's outcome and delivers them through the wait", async () => {
			const { ledger, notices, child, run, settle } = harness();
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
			expect(notices).toEqual([]);
		});

		it("settles a removed child as removed, with its held output", async () => {
			const { ledger, child, run, settle, remove } = harness();
			const worker = child("worker");
			const scout = child("scout");
			run(worker);
			run(scout);
			ledger.setHold(worker, true);
			settle(worker, idle("held answer"));
			const wait = ledger.wait([worker, scout]);
			expect(remove(worker).map((settlement) => settlement.output)).toEqual(["held answer"]);
			settle(scout, idle("s"));
			const result = await wait.result;
			expect(result.statuses[0]).toEqual({ path: ["worker"], state: "removed", output: "held answer" });
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
			const { ledger, notices, child, run, settle } = harness();
			const worker = child("worker");
			const scout = child("scout");
			run(worker);
			run(scout);
			const wait = ledger.wait([worker, scout]);
			settle(worker, idle("w"));
			wait.cancel();
			await expect(wait.result).rejects.toThrow("Wait cancelled.");
			expect(notices.map((notice) => notice.settlement.output)).toEqual(["w"]);
		});

		it("ends on interrupt with the outcomes settled so far, leaving the rest to notices", async () => {
			const { ledger, notices, child, run, settle } = harness();
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
			expect(notices.map((notice) => notice.settlement.output)).toEqual(["s"]);
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
