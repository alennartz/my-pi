/**
 * Pimote panel-card projection for subagent state.
 *
 * Pure mapping from the manager's display statuses to `@pimote/sdk/panels`
 * cards. State naming, description, and color come from status-display.ts
 * (shared with the TUI dashboard). Every string here is plain text: pimote's
 * web client renders cards with its UI font, so nerd-font glyphs used in the
 * terminal dashboard would show up as tofu and must not be emitted.
 */

import type { Card } from "@pimote/sdk/panels";
import type { AgentStatus } from "./agent-set.js";
import { formatTokenCount } from "./format.js";
import { STATE_COLORS, STATE_LABELS, stateDetail } from "./status-display.js";

/** State badge: label, turn count, and a plain-text subgroup marker. */
function stateTag(status: AgentStatus): string {
	let tag = STATE_LABELS[status.state];
	if (status.usage.turns > 0) tag += ` (${status.usage.turns})`;
	if (status.hasSubgroup) tag += " +sub";
	return tag;
}

function statusFooter(status: AgentStatus): string[] {
	const footer: string[] = [];
	const totalInput = status.usage.input + status.usage.cacheRead + status.usage.cacheWrite;
	if (totalInput > 0) footer.push(`↑${formatTokenCount(totalInput)}`);
	if (status.usage.output > 0) footer.push(`↓${formatTokenCount(status.usage.output)}`);
	if (status.contextWindow && status.contextWindow > 0) {
		footer.push(`ctx:${Math.round((status.lastTurnInput / status.contextWindow) * 100)}%`);
	}
	if (status.usage.cost > 0) footer.push(`$${status.usage.cost.toFixed(2)}`);
	return footer;
}

/** Project live subagent statuses onto pimote panel cards (full snapshot). */
export function statusesToCards(statuses: AgentStatus[]): Card[] {
	return statuses.map((s) => {
		const body: NonNullable<Card["body"]> = [];
		const defName = s.agentDef || "default";
		const modelName = s.model || "—";
		body.push({ content: `${defName} · ${modelName}`, style: "secondary" });
		body.push({ content: stateDetail(s), style: "text" });
		if (s.channels.length > 0) {
			body.push({ content: s.channels.join(" · "), style: "secondary" });
		}

		return {
			id: s.id,
			color: STATE_COLORS[s.state],
			header: {
				title: s.id,
				tag: stateTag(s),
			},
			body,
			footer: statusFooter(s),
		};
	});
}
