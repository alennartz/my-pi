import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AGENTS_MD_SECTION_TAG, renderAgentsMdPhilosophy } from "./philosophy.ts";

export default function agentsPhilosophy(pi: ExtensionAPI) {
	pi.on("before_agent_start", (event) => {
		const sections = event.systemPromptOptions.sections;
		// Never clobber content another handler (or the user) already placed there.
		if (sections[AGENTS_MD_SECTION_TAG]) return undefined;

		sections[AGENTS_MD_SECTION_TAG] = renderAgentsMdPhilosophy();
		return undefined;
	});
}
