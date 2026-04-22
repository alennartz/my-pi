import { getAgentDir } from "@mariozechner/pi-coding-agent";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
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

		const roots = discoverContextRoots(ctx.cwd, getAgentDir());

		const allMatched: IndexedMatchedOverlay[] = [];

		for (let rootIndex = 0; rootIndex < roots.length; rootIndex++) {
			const { overlays, diagnostics } = loadOverlayFiles(roots[rootIndex]);

			for (const diag of diagnostics) {
				if (tracker.shouldNotify(diag.path, diag.message)) {
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
			return { systemPrompt: event.systemPrompt + "\n\n" + block };
		}

		return undefined;
	});
}
