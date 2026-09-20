/**
 * Content extraction: Readability primary, DOM-strip fallback, Turndown output.
 * Ported from skills/brave-search/content.js with a quality gate added.
 * Contract: docs/plans/web-tools.md → Interfaces → Extraction.
 */

import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

export interface ExtractionQuality {
	score: number; // 0-100
	signals: string[];
}

export interface ExtractionResult {
	markdown: string;
	title?: string;
	wordCount: number;
	engine: "readability" | "dom-fallback";
	quality: ExtractionQuality;
}

/** HTML → Markdown, preserving links, ATX headings, fenced code, GFM tables. */
export function htmlToMarkdown(html: string): string {
	const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
	turndown.use(gfm);
	turndown.addRule("removeEmptyLinks", {
		filter: (node) => node.nodeName === "A" && !node.textContent?.trim(),
		replacement: () => "",
	});
	return turndown
		.turndown(html)
		.replace(/\[\\?\[\s*\\?\]\]\([^)]*\)/g, "")
		.replace(/ +/g, " ")
		.replace(/\s+,/g, ",")
		.replace(/\s+\./g, ".")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

const CONSENT_MARKERS =
	/(accept (all )?cookies|cookie (policy|preferences|consent)|subscribe to continue|sign[ -]?in to (continue|read)|paywall|enable javascript|checking your browser|are you a robot|verify you are human)/i;

function scoreQuality(
	markdown: string,
	title: string | undefined,
	sourceHtml: string,
): ExtractionQuality {
	const signals: string[] = [];
	let score = 100;
	const words = markdown.split(/\s+/).filter(Boolean);
	const wordCount = words.length;

	if (wordCount === 0) {
		signals.push("empty");
		score -= 100;
	} else if (title && wordCount <= 6 && markdown.replace(/\s+/g, " ").trim() === title.trim()) {
		signals.push("title-only");
		score -= 60;
	}

	if (wordCount < 50) {
		signals.push("very-short");
		score -= 40;
	}

	const head = markdown.slice(0, 2000).toLowerCase();
	if (CONSENT_MARKERS.test(head)) {
		signals.push("cookie-wall");
		score -= 50;
	}

	// Script-to-text ratio over the raw HTML: a shell page whose bytes are
	// mostly <script> will not have produced useful markdown either.
	const scriptText = [...sourceHtml.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
		.map((m) => m[1])
		.join("");
	const plainChars = sourceHtml.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").length;
	if (plainChars > 0 && scriptText.length / plainChars > 0.5) {
		signals.push("script-heavy");
		score -= 40;
	}

	return { score: Math.max(0, Math.min(100, score)), signals };
}

/** Extract readable content from an HTML document. Pure — no network. */
export function extractContent(html: string, url: string): ExtractionResult {
	// Primary: Readability (Firefox Reader View algorithm).
	const dom = new JSDOM(html, { url });
	const reader = new Readability(dom.window.document);
	const article = reader.parse();

	if (article?.content) {
		const markdown = htmlToMarkdown(article.content);
		const title = article.title?.trim() || undefined;
		return {
			markdown,
			title,
			wordCount: markdown.split(/\s+/).filter(Boolean).length,
			engine: "readability",
			quality: scoreQuality(markdown, title, html),
		};
	}

	// Fallback: strip noise, take the main region, convert what remains.
	const fallbackDoc = new JSDOM(html, { url });
	const doc = fallbackDoc.window.document;
	doc.querySelectorAll("script, style, noscript, nav, header, footer, aside").forEach((el) =>
		el.remove(),
	);
	const title = doc.querySelector("title")?.textContent?.trim() || undefined;
	const main =
		doc.querySelector("main") ??
		doc.querySelector("article") ??
		doc.querySelector("[role='main']") ??
		doc.querySelector(".content") ??
		doc.querySelector("#content") ??
		doc.body;
	const htmlFragment = main?.innerHTML ?? "";
	const markdown = htmlFragment.trim().length > 0 ? htmlToMarkdown(htmlFragment) : "";

	return {
		markdown,
		title,
		wordCount: markdown.split(/\s+/).filter(Boolean).length,
		engine: "dom-fallback",
		quality: scoreQuality(markdown, title, html),
	};
}
