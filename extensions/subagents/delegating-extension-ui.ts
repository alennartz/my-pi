import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

export type DelegatingExtensionUIOptions = {
	headless: ExtensionUIContext;
};

/**
 * Stable extension UI context whose target may be attached or reset later.
 * Extensions bind to `context` once for the logical child session.
 */
export class DelegatingExtensionUI {
	readonly context!: ExtensionUIContext;

	constructor(_options: DelegatingExtensionUIOptions) {
		throw new Error("not implemented");
	}

	attach(_target: ExtensionUIContext): () => void {
		throw new Error("not implemented");
	}

	reset(): void {
		throw new Error("not implemented");
	}
}
