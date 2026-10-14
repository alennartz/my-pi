import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";

/** Absolute path to the package's canonical extension configuration reference. */
export const EXTENSION_DOCS_PATH = fileURLToPath(
	new URL("../../docs/extensions.md", import.meta.url),
);

/**
 * Keep the configuration reference discoverable without copying the document
 * into every system prompt. The agent can read the file when configuration or
 * extension work needs more detail.
 */
export const EXTENSION_DOCS_SECTION = `my-pi adds extensions and configuration beyond pi. The canonical reference is at ${EXTENSION_DOCS_PATH}. Read that file before configuring or changing my-pi. It documents configuration files, environment variables, front-matter fields, defaults, and downstream TypeScript customization.`;

export default function myPiDocs(pi: ExtensionAPI): void {
	pi.on("before_agent_start", (event) => {
		event.systemPromptOptions.sections["my-pi"] = EXTENSION_DOCS_SECTION;
	});
}
