/**
 * Workspace persona declaration — `<cwd>/AGENTS.md` front matter + body.
 *
 * A persona workspace declares its specialist inline: the front matter carries
 * the specialist shape (mirroring agent-definition front matter: `name`,
 * `description`, `tools: read, bash, edit` comma-separated, `model`, `skills`
 * comma-separated) and the markdown body below the front matter *is* the
 * persona preamble.
 *
 * Detection is strict: `loadWorkspacePersona` reads `<cwd>/AGENTS.md` and
 * nothing else — no ancestor walk, no subdirectory recursion. The persona is
 * exactly one directory deep. A file without `kind: persona` front matter is
 * left entirely alone (it stays project context). The `kind:` seam stays open:
 * unknown `kind` values are reserved for future use, silently ignored (never
 * an error, never treated as a persona).
 *
 * Pure declaration parsing; `loadWorkspacePersona` performs the one file read.
 *
 * Front matter is read by a local scalar parser mirroring pi's
 * `parseFrontmatter` delimiter/body semantics — the pi package stays a
 * type-only import across this extension (its test mock exposes a single
 * runtime export).
 *
 * Value semantics are deliberately narrower than pi's YAML parser. The
 * declared contract is flat `key: value` scalars: a value is the raw text
 * after the colon with an optional matching outer quote pair stripped.
 * Inline comments are NOT stripped (`kind: persona # note` is not the marker
 * `persona`, and `name: "Lead" # x` yields a name that contains the comment),
 * escape sequences are NOT decoded (`"a\nb"` keeps its literal backslash),
 * and quotes only act as a matching outer pair. A persona workspace should
 * therefore keep its front matter plain — no trailing comments, no escapes.
 * This divergence from `yaml.parse` is accepted (implementation ruling (c))
 * and documented here so strict, predictable detection remains this
 * interface's single contract.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** A parsed workspace persona declaration. */
export type PersonaDeclaration = {
	/** Exact marker; anything else (or absent) = not a persona. */
	kind: "persona";
	name: string;
	description?: string;
	/** Front matter `tools: read, bash, edit` — comma-separated. */
	tools?: string[];
	/** Tier name or model id, DR-038 vocabulary, `":<level>"` suffix allowed. */
	model?: string;
	/** Front matter `skills:` — comma-separated. */
	skills?: string[];
	/** Markdown below the front matter — becomes the preamble. */
	body: string;
	/** Absolute path of the declaring AGENTS.md. */
	sourcePath: string;
};

/**
 * Parse one AGENTS.md file's content into a persona declaration.
 * Returns `undefined` for anything that is not a persona — including files
 * with no front matter, a `kind` other than `persona`, or a `kind: persona`
 * marker without the required `name`.
 */
export function parsePersonaDeclaration(
	content: string,
	sourcePath: string,
): PersonaDeclaration | undefined {
	const { frontmatter, body } = parseScalarFrontmatter(content);
	if (frontmatter.kind !== "persona") return undefined;
	const name = nonBlankString(frontmatter.name);
	if (name === undefined) return undefined;
	const description = nonBlankString(frontmatter.description);
	const model = nonBlankString(frontmatter.model);
	const tools = parseCommaSeparatedList(frontmatter.tools);
	const skills = parseCommaSeparatedList(frontmatter.skills);
	return {
		kind: "persona",
		name,
		...(description !== undefined ? { description } : {}),
		...(tools !== undefined ? { tools } : {}),
		...(model !== undefined ? { model } : {}),
		...(skills !== undefined ? { skills } : {}),
		body,
		sourcePath,
	};
}

/**
 * Split content into front matter and body with pi's `parseFrontmatter`
 * semantics: only a leading `---` block delimited by a line starting with `---`
 * is front matter, and the body after it is trimmed. Values are flat
 * `key: value` scalars (optional single/double quotes stripped); nested YAML
 * structures are out of scope for a persona declaration.
 */
function parseScalarFrontmatter(content: string): {
	frontmatter: Record<string, unknown>;
	body: string;
} {
	const normalized = content.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	if (!normalized.startsWith("---")) return { frontmatter: {}, body: normalized };
	const endIndex = normalized.indexOf("\n---", 3);
	if (endIndex === -1) return { frontmatter: {}, body: normalized };
	return {
		frontmatter: parseFlatScalars(normalized.slice(4, endIndex)),
		body: normalized.slice(endIndex + 4).trim(),
	};
}

/** Parse flat `key: value` lines into a record; blank, comment, and nested lines are skipped. */
function parseFlatScalars(yamlString: string): Record<string, unknown> {
	const frontmatter: Record<string, unknown> = {};
	for (const rawLine of yamlString.split("\n")) {
		const trimmed = rawLine.trim();
		if (trimmed === "" || trimmed.startsWith("#") || /^\s/.test(rawLine)) continue;
		const colon = trimmed.indexOf(":");
		if (colon === -1) continue;
		const key = trimmed.slice(0, colon).trim();
		if (key === "") continue;
		frontmatter[key] = parseScalarValue(trimmed.slice(colon + 1));
	}
	return frontmatter;
}

/**
 * A scalar value with optional matching quotes stripped; a blank value is
 * absent. Nothing else is interpreted — no comment stripping, no escape
 * decoding (see the module contract above).
 */
function parseScalarValue(raw: string): string | undefined {
	const value = raw.trim();
	if (value === "") return undefined;
	const first = value[0];
	if ((first === '"' || first === "'") && value.length >= 2 && value.endsWith(first)) {
		return value.slice(1, -1);
	}
	return value;
}

/** The value of a front-matter field when it is a non-blank string, else absent. */
function nonBlankString(value: unknown): string | undefined {
	if (typeof value !== "string" || value.trim() === "") return undefined;
	return value;
}

/** Split a front-matter list field (`"read, bash"`) into trimmed, non-empty items. */
function parseCommaSeparatedList(value: unknown): string[] | undefined {
	if (typeof value !== "string") return undefined;
	const items = value
		.split(",")
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
	return items.length > 0 ? items : undefined;
}

/**
 * Load the persona declared by `<cwd>/AGENTS.md`, if any. Strictly the cwd's
 * own file: no ancestor walk, no subdirectory recursion. Missing file,
 * unreadable file, and non-persona file all yield `undefined`.
 */
export function loadWorkspacePersona(cwd: string): PersonaDeclaration | undefined {
	const sourcePath = path.resolve(cwd, "AGENTS.md");
	let content: string;
	try {
		content = fs.readFileSync(sourcePath, "utf-8");
	} catch {
		return undefined;
	}
	return parsePersonaDeclaration(content, sourcePath);
}
