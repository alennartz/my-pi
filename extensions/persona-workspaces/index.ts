/**
 * Persona Workspaces Extension
 *
 * Makes a persona workspace (an AGENTS.md with `kind: persona` front matter in
 * the session's cwd) initialize the session as that specialist, and makes
 * specialist definitions replace pi's persona instead of stacking under it.
 *
 * Two handlers:
 * - `before_agent_start` — prompt binding (persona body replaces the preamble
 *   via `systemPromptOptions.customPrompt`), skills filter, takeover notices.
 * - `session_start` — front-matter binding (model/tools) once at bind time.
 *
 * Persona resolution comes from `declaration.ts`; spawn-declared payloads come
 * from Subagents' child-session registry (`../subagents/child-session-marker.ts`)
 * via `ctx.sessionManager`.
 *
 * Notes for implementers (from the plan): do NOT set `sections.preamble` — pi
 * throws on custom sections named `preamble`; `customPrompt` is the preamble
 * knob. An explicit `--system-prompt` reaches the handler as a pre-populated
 * `customPrompt` and outranks the ambient persona.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Custom message type for takeover notices; rendered for clean TUI display. */
export const PERSONA_NOTICE_TYPE = "persona-notice";

export default function personaWorkspaces(pi: ExtensionAPI) {
	pi.registerMessageRenderer(PERSONA_NOTICE_TYPE, () => undefined);

	pi.on("session_start", (event, ctx) => {
		throw new Error("not implemented");
	});

	pi.on("before_agent_start", (event, ctx) => {
		throw new Error("not implemented");
	});
}
