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
	throw new Error("not implemented");
}

/**
 * Load the persona declared by `<cwd>/AGENTS.md`, if any. Strictly the cwd's
 * own file: no ancestor walk, no subdirectory recursion. Missing file,
 * unreadable file, and non-persona file all yield `undefined`.
 */
export function loadWorkspacePersona(cwd: string): PersonaDeclaration | undefined {
	throw new Error("not implemented");
}
