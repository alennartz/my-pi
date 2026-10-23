import * as fs from "node:fs";

/**
 * Reconstruct the runtime-status fields of an agent from its persisted pi
 * session JSONL file, in a single forward pass.
 *
 * The session file is the source of truth for an agent's runtime status. On
 * parent-session resume, the Subagents manager re-parses each restored child's
 * session file to seed faithful status (usage, model, last output, context
 * fill) instead of trusting a fabricated "running"/zeroed seed.
 *
 * Pure and synchronous: depends only on Node `fs`, never the pi session-manager
 * API. The file is parsed directly, exactly as `persistence.ts` parses the
 * lifecycle log.
 */

interface RawUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { total?: number };
}

export interface SessionSnapshot {
	/** Cumulative usage from assistant and usage-bearing tool/session entries. */
	usage: {
		input: number; // sum of usage.input
		output: number; // sum of usage.output
		cacheRead: number; // sum of usage.cacheRead
		cacheWrite: number; // sum of usage.cacheWrite
		cost: number; // sum of usage.cost.total
		turns: number; // count of assistant messages
	};
	/** Model id of the last assistant message, if any. */
	model?: string;
	/** Text of the last assistant message's last text part, if any. */
	lastOutput?: string;
	/** Input-side tokens of the last assistant turn: input + cacheRead + cacheWrite. */
	lastTurnInput: number;
}

function addUsage(
	target: SessionSnapshot["usage"],
	usage: RawUsage | undefined,
): void {
	if (!usage) return;
	target.input += usage.input ?? 0;
	target.output += usage.output ?? 0;
	target.cacheRead += usage.cacheRead ?? 0;
	target.cacheWrite += usage.cacheWrite ?? 0;
	target.cost += usage.cost?.total ?? 0;
}

/**
 * Parse a pi session JSONL file into a status snapshot via a single forward pass.
 *
 * Behavioral contract:
 * - A missing, empty, or unreadable file yields a zeroed snapshot
 *   ({ usage: all-zero, turns: 0, lastTurnInput: 0 }, no model/lastOutput) — never throws.
 * - Malformed (non-JSON) lines are skipped individually; a single bad line does
 *   not abort the parse.
 * - Assistant messages, usage-bearing tool results, and pi usage entries
 *   contribute to usage. usage.turns equals the number of assistant messages.
 * - model and lastOutput reflect the LAST assistant message in file order. If the
 *   last assistant message has no text part, lastOutput is left at the previous
 *   value (or undefined if none). model is taken from that same last assistant message.
 * - lastTurnInput is derived from the last assistant message's usage as
 *   (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0).
 * - Lines without an assistant message or usage-bearing entry (cheap substring
 *   check fails) are skipped without JSON parsing, so large toolResult/image
 *   lines cost ~nothing.
 */
export function parseSessionSnapshot(sessionFile: string): SessionSnapshot {
	const snapshot: SessionSnapshot = {
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		lastTurnInput: 0,
	};

	let contents: string;
	try {
		contents = fs.readFileSync(sessionFile, "utf8");
	} catch {
		// Missing, unreadable, or directory path (EISDIR) — zeroed snapshot.
		return snapshot;
	}

	for (const rawLine of contents.split("\n")) {
		const line = rawLine.trim();
		if (line.length === 0) continue;
		// Cheap substring pre-filter: skip ordinary user/tool-result/image lines.
		// A tool result is parsed only when it carries usage, while an assistant
		// line is parsed even without usage so it still counts as a turn.
		const isAssistant = line.includes('"role":"assistant"');
		const isToolResultWithUsage = line.includes('"role":"toolResult"') && line.includes('"usage"');
		const isUsageEntry = line.includes('"type":"usage"') && line.includes('"usage"');
		const isSummaryWithUsage = (line.includes('"type":"compaction"') || line.includes('"type":"branch_summary"'))
			&& line.includes('"usage"');
		if (!isAssistant && !isToolResultWithUsage && !isUsageEntry && !isSummaryWithUsage) continue;

		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			// Malformed line — skip individually, do not abort the pass.
			continue;
		}

		const entry = parsed as {
			type?: unknown;
			message?: {
				role?: unknown;
				model?: unknown;
				content?: unknown;
				usage?: RawUsage;
			};
			usage?: RawUsage;
		};

		// The substring check is a fast reject, not proof — confirm shape.
		if (entry.type === "message" && entry.message?.role === "assistant") {
			const message = entry.message;
			snapshot.usage.turns += 1;
			addUsage(snapshot.usage, message.usage);

			// Last assistant message in file order wins for model/lastOutput/lastTurnInput.
			if (typeof message.model === "string") {
				snapshot.model = message.model;
			} else {
				snapshot.model = undefined;
			}

			const usage = message.usage;
			const input = usage?.input ?? 0;
			const cacheRead = usage?.cacheRead ?? 0;
			const cacheWrite = usage?.cacheWrite ?? 0;
			snapshot.lastTurnInput = usage ? input + cacheRead + cacheWrite : 0;

			if (Array.isArray(message.content)) {
				let lastText: string | undefined;
				for (const part of message.content) {
					if (
						part &&
						typeof part === "object" &&
						(part as { type?: unknown }).type === "text" &&
						typeof (part as { text?: unknown }).text === "string"
					) {
						lastText = (part as { text: string }).text;
					}
				}
				// Only overwrite lastOutput if this message had a text part;
				// otherwise keep the previous value.
				if (lastText !== undefined) snapshot.lastOutput = lastText;
			}
			continue;
		}

		if (entry.type === "message" && entry.message?.role === "toolResult") {
			addUsage(snapshot.usage, entry.message.usage);
			continue;
		}

		if (entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary") {
			addUsage(snapshot.usage, entry.usage);
		}
	}

	return snapshot;
}
