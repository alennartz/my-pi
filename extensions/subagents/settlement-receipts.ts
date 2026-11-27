import { createHash } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { asRecord, stringField } from "./narrow.js";

/** Bind receipt IDs to the text offered to the parent, not to presentation details. */
export function settlementReceiptDetails(text: string, ids: readonly string[]) {
	return { settlementReceipts: ids, ...(ids.length > 0 ? { settlementReceiptDigest: digest(text) } : undefined) };
}

function digest(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/** Read verified delivery receipts only from the owning parent's committed branch. */
export function settlementReceipts(branch: readonly SessionEntry[]) {
	const settlements = new Set<string>();
	const notices = new Set<string>();
	for (const entry of branch) {
		const message = entry.type === "custom_message" && entry.customType === "subagents"
			? entry
			: entry.type === "message" && entry.message.role === "toolResult" && (entry.message.toolName === "await_agents" || entry.message.toolName === "teardown") && !entry.message.isError
				? entry.message
				: undefined;
		const record = asRecord(message?.details);
		if (!message || !record) {continue;}
		const notice = stringField(record, "subagentNoticeId");
		if (notice) {notices.add(notice);}
		if (!Array.isArray(record.settlementReceipts) || record.settlementReceipts.length === 0) {continue;}
		const expected = stringField(record, "settlementReceiptDigest");
		if (!expected) {continue;}
		const text = typeof message.content === "string" ? [message.content] : message.content.flatMap((part) => part.type === "text" ? [part.text] : []);
		if (!text.some((part) => digest(part) === expected)) {continue;}
		for (const id of record.settlementReceipts) {
			if (typeof id === "string") {settlements.add(id);}
		}
	}
	return { settlements, notices };
}
