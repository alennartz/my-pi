/** System prompt section tag contributed by the agents-philosophy extension. */
export const AGENTS_MD_SECTION_TAG = "agents-md";

/**
 * Pure renderer for the AGENTS.md authoring philosophy: an AGENTS.md is a vision
 * statement for its folder plus a lookup table to the files that hold the detail.
 */
export function renderAgentsMdPhilosophy(): string {
	return [
		"AGENTS.md files are maps, not containers. When you create, update, or review an AGENTS.md file (at any folder level), it should hold exactly two things:",
		"",
		"1. A vision statement for the folder — a few sentences on what this directory is for and where it is heading. Scope it to the folder the file lives in; do not repeat parent content.",
		"2. A lookup table to other files — pointers to the files that carry the detail (e.g. codemap.md, glossary.md, decision records, plans, design docs), one line each saying what the reader will find there.",
		"",
		"Everything else — conventions, style rules, walkthroughs, API notes, detailed documentation — belongs in a dedicated file referenced from the lookup table, not inline in AGENTS.md. When an AGENTS.md outgrows a screen, split the content out and leave a pointer.",
	].join("\n");
}
