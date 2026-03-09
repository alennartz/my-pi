import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { Input, matchesKey, Key, truncateToWidth } from "@mariozechner/pi-tui";
import type { Component, Focusable, TUI } from "@mariozechner/pi-tui";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface NumberedSelectOption {
	label: string;
	description?: string;
}

export interface NumberedSelectResult {
	index: number;
	label: string;
	annotation?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type Mode = "navigation" | "text";

class NumberedSelectComponent implements Component, Focusable {
	private mode: Mode = "navigation";
	private highlight = 0;
	private input: Input;
	private tui: TUI;
	private theme: Theme;
	private options: NumberedSelectOption[];
	private title: string;
	private done: (result: NumberedSelectResult | undefined) => void;

	// Focusable
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	constructor(
		tui: TUI,
		theme: any,
		title: string,
		options: NumberedSelectOption[],
		done: (result: NumberedSelectResult | undefined) => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.title = title;
		this.options = options;
		this.done = done;
		this.input = new Input();
	}

	// -- Submit helpers -----------------------------------------------------

	private submit(index: number, annotation?: string): void {
		const opt = this.options[index]!;
		const trimmed = annotation?.trim();
		this.done({
			index,
			label: opt.label,
			annotation: trimmed || undefined,
		});
	}

	private cancel(): void {
		this.done(undefined);
	}

	// -- Input handling -----------------------------------------------------

	handleInput(data: string): void {
		if (this.mode === "navigation") {
			this.handleNavigation(data);
		} else {
			this.handleTextMode(data);
		}
		this.tui.requestRender();
	}

	private handleNavigation(data: string): void {
		// Digit keys 1-N for instant selection
		for (let i = 0; i < this.options.length; i++) {
			if (data === String(i + 1)) {
				this.submit(i);
				return;
			}
		}

		if (matchesKey(data, Key.up)) {
			if (this.highlight > 0) this.highlight--;
			return;
		}
		if (matchesKey(data, Key.down)) {
			if (this.highlight < this.options.length - 1) this.highlight++;
			return;
		}
		if (matchesKey(data, Key.tab)) {
			this.mode = "text";
			this.input.setValue("");
			return;
		}
		if (matchesKey(data, Key.enter)) {
			this.submit(this.highlight);
			return;
		}
		if (matchesKey(data, Key.escape)) {
			this.cancel();
			return;
		}
	}

	private handleTextMode(data: string): void {
		// Escape → exit text mode, clear input, back to navigation
		if (matchesKey(data, Key.escape)) {
			this.input.setValue("");
			this.mode = "navigation";
			return;
		}

		// Arrow up/down → exit text mode, clear, move highlight
		if (matchesKey(data, Key.up)) {
			this.input.setValue("");
			this.mode = "navigation";
			if (this.highlight > 0) this.highlight--;
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.input.setValue("");
			this.mode = "navigation";
			if (this.highlight < this.options.length - 1) this.highlight++;
			return;
		}

		// Enter → submit selection + annotation
		if (matchesKey(data, Key.enter)) {
			this.submit(this.highlight, this.input.getValue());
			return;
		}

		// Everything else routes to Input
		this.input.handleInput(data);
	}

	// -- Rendering ----------------------------------------------------------

	render(width: number): string[] {
		const t = this.theme;
		const lines: string[] = [];

		// Top border
		lines.push(t.fg("accent", "─".repeat(width)));

		// Title
		lines.push(truncateToWidth(" " + t.fg("accent", t.bold(this.title)), width));
		lines.push(""); // blank line after title

		// Options
		for (let i = 0; i < this.options.length; i++) {
			const isHighlighted = i === this.highlight;
			const num = `${i + 1}`;
			const label = this.options[i]!.label;
			const desc = this.options[i]!.description;

			let line: string;
			if (isHighlighted) {
				line = t.fg("accent", `  > ${num}. ${label}`);
			} else {
				line = t.fg("dim", `    ${num}.`) + ` ${label}`;
			}

			if (desc) {
				line += " " + t.fg("muted", desc);
			}

			lines.push(truncateToWidth(line, width));

			// Render input inline below highlighted option in text mode
			if (isHighlighted && this.mode === "text") {
				const inputLines = this.input.render(width - 4);
				for (const il of inputLines) {
					lines.push("    " + il);
				}
			}
		}

		// Blank line before help text
		lines.push("");

		// Help text
		if (this.mode === "navigation") {
			lines.push(truncateToWidth(
				" " + t.fg("dim", "1-" + this.options.length + " instant select • ↑↓ navigate • tab annotate • enter select • esc cancel"),
				width,
			));
		} else {
			lines.push(truncateToWidth(
				" " + t.fg("dim", "type a note • enter submit • esc back • ↑↓ back + move"),
				width,
			));
		}

		// Bottom border
		lines.push(t.fg("accent", "─".repeat(width)));

		return lines;
	}

	invalidate(): void {
		this.input.invalidate();
	}
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function showNumberedSelect(
	ctx: ExtensionContext,
	title: string,
	options: NumberedSelectOption[],
): Promise<NumberedSelectResult | undefined> {
	if (options.length === 0) {
		throw new Error("showNumberedSelect: options must not be empty");
	}
	if (options.length > 9) {
		throw new Error("showNumberedSelect: options must have 9 or fewer items");
	}

	return ctx.ui.custom<NumberedSelectResult | undefined>((tui, theme, _kb, done) => {
		const component = new NumberedSelectComponent(tui, theme, title, options, done);
		return component;
	});
}
