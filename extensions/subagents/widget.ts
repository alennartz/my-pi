/**
 * Subagent dashboard widget — rich box-card layout with aggregate footer.
 *
 * Replaces the old one-line-per-agent renderer with a WrapPanel of
 * bordered cards showing per-agent state, activity, channels, context
 * fill, and token usage. Implements the TUI Component interface for
 * use with the setWidget factory overload.
 */

import type { Component } from "@mariozechner/pi-tui";
import { visibleWidth, truncateToWidth } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import type { AgentStatus, AgentState } from "./group.js";

const STATUS_ICONS: Record<AgentState, string> = {
	running: "⏳",
	idle: "✓",
	failed: "✗",
	waiting: "⏸",
};

const SUBGROUP_ICON = "\uDB81\uDEA9"; // nf-md-file_tree

// ─── Token / percentage formatting ──────────────────────────────────

function fmtTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function fmtPct(input: number, window: number): string {
	if (window <= 0) return "0%";
	return `${Math.round((input / window) * 100)}%`;
}

// ─── Dashboard component ────────────────────────────────────────────

export class SubagentDashboard implements Component {
	private theme: Theme;
	private statuses: AgentStatus[] = [];
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(theme: Theme) {
		this.theme = theme;
	}

	/** Push new status data from onUpdate callback. */
	update(statuses: AgentStatus[]): void {
		this.statuses = statuses;
		this.invalidate();
	}

	render(width: number): string[] {
		if (this.cachedWidth === width && this.cachedLines) return this.cachedLines;
		this.cachedLines = this.doRender(width);
		this.cachedWidth = width;
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	// ─── Internal rendering ─────────────────────────────────────────

	private doRender(width: number): string[] {
		if (this.statuses.length === 0) return [];

		const MIN_BOX_WIDTH = 30;
		const GAP = 1;

		// WrapPanel layout
		const itemsPerRow = Math.max(1, Math.floor((width + GAP) / (MIN_BOX_WIDTH + GAP)));
		const boxWidth = Math.floor((width - (itemsPerRow - 1) * GAP) / itemsPerRow);

		const lines: string[] = [];

		// Render rows of boxes
		for (let i = 0; i < this.statuses.length; i += itemsPerRow) {
			const row = this.statuses.slice(i, i + itemsPerRow);
			const boxes = row.map((s) => this.renderBox(s, boxWidth));
			lines.push(...this.stitchRow(boxes, boxWidth, GAP));
		}

		// Footer
		lines.push(this.renderFooter(width));

		return lines;
	}

	/**
	 * Render a single agent box — exactly 6 lines tall.
	 *  Line 0: top border
	 *  Line 1: identity (agent def + model)
	 *  Line 2: activity line 1
	 *  Line 3: activity line 2 (overflow)
	 *  Line 4: channels
	 *  Line 5: bottom border with stats
	 */
	private renderBox(s: AgentStatus, boxWidth: number): string[] {
		const t = this.theme;
		const failed = s.state === "failed";
		const dimmed = s.state === "idle" || s.state === "failed";
		const innerWidth = boxWidth - 2; // 2 border chars

		// Border color
		const borderColor = this.borderColor(s.state);
		const bc = (text: string) => t.fg(borderColor, text);

		// Corner/edge chars
		const [tl, tr, bl, br, hFill] = failed
			? ["╔", "╗", "╚", "╝", "═"]
			: ["╭", "╮", "╰", "╯", "─"];

		// ── Top border ──
		const turns = `(${s.usage.turns})`;
		let topLabel = ` ${s.id} ${turns}`;
		let topExtra = "";
		if (s.hasSubgroup) {
			topExtra = " " + t.fg("accent", SUBGROUP_ICON);
		}
		const icon = " " + STATUS_ICONS[s.state];
		// Budget: innerWidth must fit topLabel + topExtra(visible) + fill + icon
		const topExtraVis = s.hasSubgroup ? 1 + visibleWidth(SUBGROUP_ICON) : 0;
		const topLabelVis = visibleWidth(topLabel);
		const iconVis = visibleWidth(icon);
		// Account for trailing space before tr corner: topLabel + extra + fill + icon + " " = innerWidth
		const fillCount = Math.max(0, innerWidth - topLabelVis - topExtraVis - iconVis - 1);
		const topLine = bc(tl) + topLabel + topExtra + bc(hFill.repeat(fillCount)) + icon + " " + bc(tr);

		// ── Line 1: identity ──
		const defName = s.agentDef || "default";
		const modelName = s.model || "—";
		const identityRaw = `${defName} • ${modelName}`;
		const identityColor = dimmed ? "dim" : "muted";
		const line1 = this.interiorLine(t.fg(identityColor, truncateToWidth(identityRaw, innerWidth)), innerWidth, bc, hFill === "═");

		// ── Lines 2-3: activity ──
		const activityText = this.activityText(s);
		const activityColor = this.activityColor(s);
		// Split into two lines if needed
		const act1 = truncateToWidth(activityText, innerWidth);
		const act1vis = visibleWidth(act1);
		const hasOverflow = visibleWidth(activityText) > innerWidth;
		const act2 = hasOverflow ? truncateToWidth(activityText.slice(act1.length > activityText.length ? activityText.length : this.findSplitPoint(activityText, innerWidth)), innerWidth) : "";

		const actColor = dimmed ? "dim" : activityColor;
		const line2 = this.interiorLine(t.fg(actColor, act1), innerWidth, bc, failed);
		const line3 = this.interiorLine(act2 ? t.fg(actColor, act2) : "", innerWidth, bc, failed);

		// ── Line 4: channels ──
		const channelText = this.formatChannels(s, dimmed);
		const line4 = this.interiorLine(truncateToWidth(channelText, innerWidth, "…", false), innerWidth, bc, failed);

		// ── Bottom border ──
		const bottomLine = this.renderBottomBorder(s, boxWidth, bc, tl === "╔");

		return [topLine, line1, line2, line3, line4, bottomLine];
	}

	/** Wrap interior content in border chars, padded to innerWidth. */
	private interiorLine(content: string, innerWidth: number, bc: (s: string) => string, doubleBorder: boolean): string {
		const vBar = doubleBorder ? "║" : "│";
		const contentVis = visibleWidth(content);
		const pad = Math.max(0, innerWidth - contentVis);
		return bc(vBar) + content + " ".repeat(pad) + bc(vBar);
	}

	/** Approximate character index where visible width exceeds limit. */
	private findSplitPoint(text: string, maxWidth: number): number {
		// Walk characters and track visible width
		let vis = 0;
		for (let i = 0; i < text.length; i++) {
			const ch = text.charCodeAt(i);
			// Skip ANSI sequences
			if (ch === 0x1b) {
				const m = text.slice(i).match(/^\x1b\[[0-9;]*m/);
				if (m) { i += m[0].length - 1; continue; }
			}
			vis++;
			if (vis >= maxWidth) return i + 1;
		}
		return text.length;
	}

	private renderBottomBorder(s: AgentStatus, boxWidth: number, bc: (s: string) => string, doubleBorder: boolean): string {
		const t = this.theme;
		const [bl, br, hFill] = doubleBorder ? ["╚", "╝", "═"] : ["╰", "╯", "─"];
		const innerWidth = boxWidth - 2;
		const dimmed = s.state === "idle" || s.state === "failed";
		const statColor = dimmed ? "dim" : "muted";

		// Build stats segments
		const parts: string[] = [];

		// Context fill
		if (s.contextWindow && s.contextWindow > 0) {
			parts.push(`ctx:${fmtPct(s.lastTurnInput, s.contextWindow)}`);
		} else if (s.lastTurnInput > 0) {
			parts.push(`↑${fmtTokens(s.lastTurnInput)}`);
		}

		// Cumulative tokens
		const tokParts: string[] = [];
		if (s.usage.input > 0) tokParts.push(`↑${fmtTokens(s.usage.input)}`);
		if (s.usage.output > 0) tokParts.push(`↓${fmtTokens(s.usage.output)}`);
		if (tokParts.length > 0) parts.push(tokParts.join(" "));

		// Cost
		if (s.usage.cost > 0) parts.push(`$${s.usage.cost.toFixed(2)}`);

		const statsStr = parts.join(" ");
		const statsVis = visibleWidth(statsStr);

		// Layout: bl + hFill + stats + hFill + br
		const availFill = innerWidth - statsVis - (statsVis > 0 ? 2 : 0); // 2 for spacing around stats
		const leftFill = Math.max(1, Math.min(2, availFill));
		const rightFill = Math.max(0, availFill - leftFill);

		if (statsVis > 0) {
			return bc(bl) + bc(hFill.repeat(leftFill)) + t.fg(statColor, " " + statsStr + " ") + bc(hFill.repeat(rightFill)) + bc(br);
		} else {
			return bc(bl) + bc(hFill.repeat(innerWidth)) + bc(br);
		}
	}

	/** Stitch boxes side by side with gap. */
	private stitchRow(boxes: string[][], boxWidth: number, gap: number): string[] {
		const BOX_HEIGHT = 6;
		const lines: string[] = [];
		for (let lineIdx = 0; lineIdx < BOX_HEIGHT; lineIdx++) {
			let row = "";
			for (let b = 0; b < boxes.length; b++) {
				if (b > 0) row += " ".repeat(gap);
				const boxLine = boxes[b]?.[lineIdx] ?? "";
				// Pad to boxWidth if needed (for partial last rows)
				const vis = visibleWidth(boxLine);
				row += boxLine + (vis < boxWidth ? " ".repeat(boxWidth - vis) : "");
			}
			lines.push(row);
		}
		return lines;
	}

	/** Aggregate footer bar. */
	private renderFooter(width: number): string {
		const t = this.theme;
		const counts: Record<AgentState, number> = { running: 0, idle: 0, failed: 0, waiting: 0 };
		let totalCost = 0;

		// Context range
		const ctxPcts: number[] = [];

		for (const s of this.statuses) {
			counts[s.state]++;
			totalCost += s.usage.cost;
			if (s.contextWindow && s.contextWindow > 0 && s.lastTurnInput > 0) {
				ctxPcts.push(Math.round((s.lastTurnInput / s.contextWindow) * 100));
			}
		}

		const parts: string[] = [];

		// Context range
		if (ctxPcts.length > 0) {
			const min = Math.min(...ctxPcts);
			const max = Math.max(...ctxPcts);
			parts.push(`ctx: ${min}–${max}%`);
		}

		// Agent counts
		const countParts: string[] = [];
		if (counts.running > 0) countParts.push(`${counts.running} running`);
		if (counts.idle > 0) countParts.push(`${counts.idle} idle`);
		if (counts.waiting > 0) countParts.push(`${counts.waiting} waiting`);
		if (counts.failed > 0) countParts.push(`${counts.failed} failed`);
		parts.push(`${this.statuses.length} agents: ${countParts.join(" · ")}`);

		// Cost
		if (totalCost > 0) parts.push(`$${totalCost.toFixed(2)}`);

		const inner = parts.join(t.fg("muted", " │ "));
		const innerVis = visibleWidth(inner);
		const dash = t.fg("muted", "─");
		const sideFill = Math.max(1, Math.floor((width - innerVis - 2) / 2));
		const rightFill = Math.max(1, width - innerVis - 2 - sideFill);
		const line = dash.repeat(sideFill) + " " + t.fg("dim", inner) + " " + dash.repeat(rightFill);
		return truncateToWidth(line, width);
	}

	// ─── Helpers ────────────────────────────────────────────────────

	private borderColor(state: AgentState): "accent" | "success" | "warning" | "error" {
		switch (state) {
			case "running": return "accent";
			case "idle": return "success";
			case "waiting": return "warning";
			case "failed": return "error";
		}
	}

	private activityText(s: AgentStatus): string {
		switch (s.state) {
			case "running":
				return s.lastActivity || "running";
			case "waiting":
				return "waiting for response";
			case "idle":
				return "idle";
			case "failed":
				return "failed";
		}
	}

	private activityColor(s: AgentStatus): "muted" | "warning" | "success" | "error" {
		switch (s.state) {
			case "running": return "muted";
			case "waiting": return "warning";
			case "idle": return "success";
			case "failed": return "error";
		}
	}

	/** Format channel list with waiting-for highlighting. */
	private formatChannels(s: AgentStatus, dimmed: boolean): string {
		const t = this.theme;
		const waitSet = new Set(s.waitingFor);

		// Sort: waited-on first, then rest
		const waited = s.channels.filter((c) => waitSet.has(c));
		const rest = s.channels.filter((c) => !waitSet.has(c));
		const ordered = [...waited, ...rest];

		const parts = ordered.map((c) => {
			if (waitSet.has(c)) return t.fg("warning", c);
			return t.fg(dimmed ? "dim" : "muted", c);
		});

		return parts.join(t.fg("dim", " · "));
	}
}
