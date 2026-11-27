import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { asRecord, stringField } from "./narrow.js";

/** Read delivery receipts only from the owning parent's committed branch. */
export function settlementReceipts(branch: readonly SessionEntry[]) {
	const settlements = new Set<string>();
	const notices = new Set<string>();
	for (const entry of branch) {
		const details = entry.type === "custom_message" && entry.customType === "subagents"
			? entry.details
			: entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "await_agents" && !entry.message.isError
				? entry.message.details
				: undefined;
		const record = asRecord(details);
		if (!record) {continue;}
		const notice = stringField(record, "subagentNoticeId");
		if (notice) {notices.add(notice);}
		if (!Array.isArray(record.settlementReceipts)) {continue;}
		for (const id of record.settlementReceipts) {
			if (typeof id === "string") {settlements.add(id);}
		}
	}
	return { settlements, notices };
}
