/**
 * Minimal jsdom surface this package uses.
 *
 * jsdom ships no type declarations. This shim types only the members the
 * extraction path reads, so the module is not `any` at the boundary.
 */
declare module "jsdom" {
	export class JSDOM {
		constructor(html?: string, options?: { url?: string });
		readonly window: {
			document: Document;
			close(): void;
		};
	}
}

/**
 * Minimal turndown surface this package uses.
 *
 * turndown ships no type declarations. This shim types the service and the
 * GFM plugin registration the extraction path calls.
 */
declare module "turndown" {
	export interface TurndownNode {
		nodeName: string;
		textContent?: string | null;
	}

	export interface TurndownRule {
		filter: (node: TurndownNode) => boolean;
		replacement: (content: string, node: TurndownNode) => string;
	}

	export default class TurndownService {
		constructor(options?: { headingStyle?: "atx" | "setext"; codeBlockStyle?: "fenced" | "indented" });
		use(plugin: unknown): this;
		addRule(key: string, rule: TurndownRule): this;
		turndown(html: string): string;
	}
}

declare module "turndown-plugin-gfm" {
	export const gfm: unknown;
}
