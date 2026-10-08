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
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

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
	const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);
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
