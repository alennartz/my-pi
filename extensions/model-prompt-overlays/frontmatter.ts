/**
 * Minimal frontmatter parser compatible with pi's parseFrontmatter.
 * Avoids depending on the pi package at test time while producing
 * identical results for the simple YAML structures overlay files use.
 */

export type ParsedFrontmatter<T extends Record<string, unknown> = Record<string, unknown>> = {
	frontmatter: T;
	body: string;
};

export function parseFrontmatter<T extends Record<string, unknown> = Record<string, unknown>>(
	content: string,
): ParsedFrontmatter<T> {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (!match) {
		return { frontmatter: {} as T, body: content };
	}

	const yamlBlock = match[1];
	const body = match[2];
	const frontmatter: Record<string, unknown> = {};

	// Simple YAML parser for the subset we need:
	// key: value (scalar)
	// key:\n  - item\n  - item (array)
	// key: [] (empty array)
	const lines = yamlBlock.split(/\r?\n/);
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		const kvMatch = line.match(/^(\w[\w-]*):\s*(.*)$/);
		if (!kvMatch) {
			i++;
			continue;
		}

		const key = kvMatch[1];
		let value = kvMatch[2].trim();

		// Check for inline empty array
		if (value === "[]") {
			frontmatter[key] = [];
			i++;
			continue;
		}

		// Check for inline array [item, item]
		if (value.startsWith("[") && value.endsWith("]")) {
			const inner = value.slice(1, -1);
			frontmatter[key] = inner
				.split(",")
				.map((s) => s.trim().replace(/^["']|["']$/g, ""))
				.filter((s) => s.length > 0);
			i++;
			continue;
		}

		// Check for block array (next lines start with "  - ")
		if (value === "") {
			const items: string[] = [];
			let j = i + 1;
			while (j < lines.length && /^\s+-\s/.test(lines[j])) {
				const itemMatch = lines[j].match(/^\s+-\s+(.*)$/);
				if (itemMatch) {
					items.push(itemMatch[1].replace(/^["']|["']$/g, ""));
				}
				j++;
			}
			if (items.length > 0) {
				frontmatter[key] = items;
				i = j;
				continue;
			}
		}

		// Scalar value
		if (value !== "") {
			// Try to parse as number
			const num = Number(value);
			if (!isNaN(num) && value !== "") {
				frontmatter[key] = num;
			} else {
				frontmatter[key] = value.replace(/^["']|["']$/g, "");
			}
		}

		i++;
	}

	return { frontmatter: frontmatter as T, body };
}
