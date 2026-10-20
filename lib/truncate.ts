/**
 * Model-facing truncation for tool results, mirroring pi's own behavior.
 *
 * The agent loop applies no safety-net truncation to custom tool results, so
 * every tool must bound its own `content` (docs/extensions.md §Tools,
 * examples/extensions/truncated-tool.ts). pi's MCP bridge is the reference:
 * text is capped at 20 KiB with `truncateMiddle` (start and end kept around an
 * `…N chars truncated…` marker) and the full text is saved to a temp file that
 * the result names. pi does not export `truncateMiddle` or its temp-file saver
 * (the package `exports` map only exposes the root entry), so this module
 * mirrors them; the algorithm, marker, notice text, and default limit match
 * pi's `dist/core/tools/truncate.js` and `dist/extensions/mcp/tools.js`.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

/** pi's MCP bridge cap (`MCP_OUTPUT_MAX_BYTES`). */
export const OUTPUT_MAX_BYTES = 20 * 1024;

export interface MiddleTruncationResult {
	/** The start and end of the content with an `…N chars truncated…` marker between them. */
	content: string;
	truncated: boolean;
	/** Characters left out. */
	removedChars: number;
	totalBytes: number;
	totalLines: number;
}

function splitLinesForCounting(content: string): string[] {
	if (content.length === 0) return [];
	const lines = content.split("\n");
	if (content.endsWith("\n")) lines.pop();
	return lines;
}

/**
 * Keep the start and the end of `content`, half of `maxBytes` each, and replace
 * the middle with an `…N chars truncated…` marker. Cuts only at character
 * boundaries. Mirror of pi's unexported `truncateMiddle`.
 */
export function truncateMiddle(content: string, maxBytes = OUTPUT_MAX_BYTES): MiddleTruncationResult {
	const buf = Buffer.from(content, "utf-8");
	const totalLines = splitLinesForCounting(content).length;
	if (buf.length <= maxBytes) {
		return { content, truncated: false, removedChars: 0, totalBytes: buf.length, totalLines };
	}
	// Continuation bytes (10xxxxxx) are not character starts.
	const isBoundary = (index: number) => index >= buf.length || (buf[index] & 0xc0) !== 0x80;
	let headEnd = Math.floor(maxBytes / 2);
	while (headEnd > 0 && !isBoundary(headEnd)) headEnd--;
	let tailStart = buf.length - (maxBytes - Math.floor(maxBytes / 2));
	while (tailStart < buf.length && !isBoundary(tailStart)) tailStart++;
	const head = buf.subarray(0, headEnd).toString("utf-8");
	const tail = buf.subarray(tailStart).toString("utf-8");
	const removedChars = Array.from(buf.subarray(headEnd, tailStart).toString("utf-8")).length;
	return {
		content: `${head}…${removedChars} chars truncated…${tail}`,
		truncated: true,
		removedChars,
		totalBytes: buf.length,
		totalLines,
	};
}

/** Bounded text plus the fields tools report in `details`/`structuredContent`. */
export interface TruncatedText {
	/** Model-facing text: at most `maxBytes` around the marker, plus the notice. */
	text: string;
	truncated: boolean;
	removedChars: number;
	totalBytes: number;
	/** Path of the temp file holding the complete text; set only when truncated and saved. */
	fullOutputPath?: string;
}

/**
 * Bound `text` to pi's middle-truncation default; when truncated, write the
 * complete text to a temp file and name it in the result, like pi's MCP
 * bridge. The saved file survives until the OS cleans the temp dir.
 */
export async function truncateForModel(
	text: string,
	opts: { maxBytes?: number; suffix?: string } = {},
): Promise<TruncatedText> {
	const truncation = truncateMiddle(text, opts.maxBytes ?? OUTPUT_MAX_BYTES);
	if (!truncation.truncated) {
		return { text, truncated: false, removedChars: 0, totalBytes: truncation.totalBytes };
	}
	let where: string;
	let fullOutputPath: string | undefined;
	try {
		const dir = await mkdtemp(join(tmpdir(), "pi-output-"));
		const path = join(dir, `output${opts.suffix ?? ".txt"}`);
		await withFileMutationQueue(path, async () => {
			await writeFile(path, text, "utf8");
		});
		fullOutputPath = path;
		where = `[Full output: ${path} (read it with offset/limit)]`;
	} catch (error) {
		where = `[Could not save the full output: ${error instanceof Error ? error.message : String(error)}]`;
	}
	const tokens = Math.ceil(truncation.totalBytes / 4);
	return {
		text: `Warning: truncated output (original token count: ${tokens})\nTotal output lines: ${truncation.totalLines}\n\n${truncation.content}\n\n${where}`,
		truncated: true,
		removedChars: truncation.removedChars,
		totalBytes: truncation.totalBytes,
		fullOutputPath,
	};
}
