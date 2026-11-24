/**
 * Content-Type classification for the fetch pipeline: which media types are
 * extracted as HTML, which pass through as verbatim text, which are rejected.
 */

/** How fetched bytes are processed: Readability extraction, verbatim text, or reject. */
export type ContentKind = "html" | "text" | "binary";

/** Media types run through Readability; every other accepted type passes through as text. */
const EXTRACT_TYPES = new Set(["text/html", "application/xhtml+xml"]);

/** Text-like media types registered outside the text/ tree. */
const TEXT_APPLICATION_TYPES = new Set([
	"application/markdown",
	"application/json",
	"application/xml",
	"application/yaml",
	"application/x-yaml",
	"application/toml",
	"application/javascript",
	"application/ecmascript",
]);

/**
 * Classify a Content-Type header into the pipeline's processing kind.
 * Structured-text suffixes (+json, +xml) count as text; everything else is binary.
 */
export function classifyContentType(contentType: string): ContentKind {
	const mediaType = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
	if (!mediaType) {return "binary";}
	if (EXTRACT_TYPES.has(mediaType)) {return "html";}
	if (mediaType.startsWith("text/")) {return "text";}
	if (TEXT_APPLICATION_TYPES.has(mediaType)) {return "text";}
	if (/^application\/\S+\+(?:json|xml)$/.test(mediaType)) {return "text";}
	return "binary";
}
