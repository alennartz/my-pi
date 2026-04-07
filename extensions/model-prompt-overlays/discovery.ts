import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export type ContextRoot = {
	dir: string;
	baseFilePath: string;
	scope: "global" | "ancestor";
};

const CANDIDATES = ["AGENTS.md", "CLAUDE.md"] as const;

function findBaseFile(dir: string): string | undefined {
	for (const filename of CANDIDATES) {
		const filePath = join(dir, filename);
		if (existsSync(filePath)) return filePath;
	}
	return undefined;
}

export function discoverContextRoots(cwd: string, agentDir: string): ContextRoot[] {
	const roots: ContextRoot[] = [];
	const seenPaths = new Set<string>();

	// 1. Global agent dir
	agentDir = resolve(agentDir);
	const globalBase = findBaseFile(agentDir);
	if (globalBase) {
		roots.push({ dir: agentDir, baseFilePath: globalBase, scope: "global" });
		seenPaths.add(globalBase);
	}

	// 2. Ancestor walk: filesystem root up to cwd, farthest → nearest
	const ancestorRoots: ContextRoot[] = [];
	let currentDir = resolve(cwd);
	const fsRoot = resolve("/");

	while (true) {
		const base = findBaseFile(currentDir);
		if (base && !seenPaths.has(base)) {
			ancestorRoots.unshift({ dir: currentDir, baseFilePath: base, scope: "ancestor" });
			seenPaths.add(base);
		}
		if (currentDir === fsRoot) break;
		const parent = resolve(currentDir, "..");
		if (parent === currentDir) break;
		currentDir = parent;
	}

	roots.push(...ancestorRoots);
	return roots;
}
