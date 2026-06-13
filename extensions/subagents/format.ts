/**
 * Shared formatting helpers for the subagents extension.
 */

/**
 * Format a token count compactly: raw below 1k, one-decimal "k" below 10k,
 * rounded "k" below 1M, one-decimal "M" above. Used by the widget, panel
 * cards, and group/teardown usage reports so all three render identically.
 */
export function formatTokenCount(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}
