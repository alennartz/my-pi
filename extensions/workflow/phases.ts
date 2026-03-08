import { readdirSync } from "node:fs";
import { join } from "node:path";

const ARTIFACT_DIRS = ["docs/brainstorms", "docs/plans", "docs/reviews", "docs/decisions"];

/**
 * Scan artifact directories and return a formatted inventory string.
 * Lists .md files found in each directory, grouped by directory.
 * Missing directories produce "(none)" rather than errors.
 */
export function getArtifactInventory(): string {
	return ARTIFACT_DIRS.map((dir) => {
		const fullPath = join(process.cwd(), dir);
		let files: string[];
		try {
			files = readdirSync(fullPath).filter((f) => f.endsWith(".md"));
		} catch {
			files = [];
		}
		const listing = files.length > 0 ? files.join(", ") : "(none)";
		return `${dir}/: ${listing}`;
	}).join("\n");
}
