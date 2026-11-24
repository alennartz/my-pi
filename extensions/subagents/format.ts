/**
 * Shared formatting helpers for the subagents extension.
 */

/**
 * Format a token count compactly: raw below 1k, one-decimal "k" below 10k,
 * rounded "k" below 1M, one-decimal "M" above. Used by the widget, panel
 * cards, and group/teardown usage reports so all three render identically.
 */
export function formatTokenCount(count: number): string {
	if (count < 1000) {return count.toString();}
	if (count < 10_000) {return `${(count / 1000).toFixed(1)}k`;}
	if (count < 1_000_000) {return `${Math.round(count / 1000)}k`;}
	return `${(count / 1_000_000).toFixed(1)}M`;
}

/** Longest text carried as activity before truncation. */
const MAX_ACTIVITY_LENGTH = 200;

/**
 * One-line preview of the last thing an agent did — a tool call summary or
 * assistant text. Collapses whitespace and caps length so status lines, the
 * TUI dashboard, and Pimote panel cards all render one identical string.
 */
export function activityPreview(text: string): string {
	const line = text.replace(/[\r\n\t]+/g, " ").replace(/  +/g, " ").trim();
	return line.length > MAX_ACTIVITY_LENGTH ? `${line.slice(0, MAX_ACTIVITY_LENGTH)}…` : line;
}
