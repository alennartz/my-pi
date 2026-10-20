import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverContextRoots } from "./discovery.ts";
import { loadOverlayFiles } from "./parsing.ts";
import { matchOverlay, sortMatchedOverlays } from "./matching.ts";
import type { IndexedMatchedOverlay } from "./matching.ts";
import { renderOverlayAppendBlock } from "./rendering.ts";
import { createDiagnosticsTracker } from "./diagnostics.ts";

export default function modelPromptOverlays(pi: ExtensionAPI) {
	const tracker = createDiagnosticsTracker();

	pi.on("before_agent_start", (event, ctx) => {
		const modelId = ctx.model?.id;
		if (!modelId) return undefined;

		// Project-local ancestor overlays only load when the project is trusted;
		// the global agent dir always applies.
		const roots = discoverContextRoots(ctx.cwd, getAgentDir(), ctx.isProjectTrusted());

		const allMatched: IndexedMatchedOverlay[] = [];

		for (let rootIndex = 0; rootIndex < roots.length; rootIndex++) {
			const { overlays, diagnostics } = loadOverlayFiles(roots[rootIndex]);

			for (const diag of diagnostics) {
				if (tracker.shouldNotify(diag.message)) {
					ctx.ui.notify(diag.message, "warning");
				}
			}

			for (const overlay of overlays) {
				const result = matchOverlay(modelId, overlay);
				if (result.matched) {
					allMatched.push({ ...overlay, ...result, rootIndex });
				}
			}
		}

		const sorted = sortMatchedOverlays(allMatched);
		const block = renderOverlayAppendBlock(sorted);

		if (block) {
			// Structured section, not a forced prompt: pi records and diffs it,
			// and it composes with every other prompt contribution in any
			// extension load order (e.g. the persona preamble that
			// persona-workspaces binds).
			event.systemPromptOptions.sections["model-overlays"] = block;
		}

		return undefined;
	});
}
