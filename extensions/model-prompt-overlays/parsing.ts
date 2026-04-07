import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "@mariozechner/pi-coding-agent";
import type { ContextRoot } from "./discovery.ts";

export type OverlayFile = {
	path: string;
	dir: string;
	body: string;
	models: string[];
};

export type OverlayDiagnostic = {
	path: string;
	message: string;
};

const OVERLAY_PATTERN = /^AGENTS\..+\.md$/;

export function loadOverlayFiles(root: ContextRoot): {
	overlays: OverlayFile[];
	diagnostics: OverlayDiagnostic[];
} {
	const overlays: OverlayFile[] = [];
	const diagnostics: OverlayDiagnostic[] = [];

	let entries: string[];
	try {
		entries = readdirSync(root.dir);
	} catch {
		return { overlays, diagnostics };
	}

	const candidates = entries.filter((name) => OVERLAY_PATTERN.test(name)).sort();

	for (const filename of candidates) {
		const filePath = join(root.dir, filename);
		let content: string;
		try {
			content = readFileSync(filePath, "utf-8");
		} catch {
			diagnostics.push({ path: filePath, message: `Could not read overlay file: ${filePath}` });
			continue;
		}

		let frontmatter: Record<string, unknown>;
		let body: string;
		try {
			({ frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content));
		} catch {
			diagnostics.push({ path: filePath, message: `Malformed frontmatter in overlay file: ${filePath}` });
			continue;
		}
		const rawModels = frontmatter.models;

		// Validate models field
		if (rawModels === undefined || rawModels === null) {
			diagnostics.push({ path: filePath, message: `Missing 'models' field in frontmatter: ${filePath}` });
			continue;
		}

		let models: string[];
		if (typeof rawModels === "string") {
			models = [rawModels];
		} else if (Array.isArray(rawModels)) {
			if (rawModels.length === 0) {
				diagnostics.push({ path: filePath, message: `Empty 'models' array in frontmatter: ${filePath}` });
				continue;
			}
			if (!rawModels.every((m) => typeof m === "string")) {
				diagnostics.push({ path: filePath, message: `'models' array contains non-string values: ${filePath}` });
				continue;
			}
			models = rawModels as string[];
		} else {
			diagnostics.push({ path: filePath, message: `Invalid 'models' field (expected string or string[]): ${filePath}` });
			continue;
		}

		overlays.push({
			path: filePath,
			dir: root.dir,
			body,
			models,
		});
	}

	return { overlays, diagnostics };
}
