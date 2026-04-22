import { resolve } from "node:path";

/**
 * Discover directories where model-prompt overlays may live.
 *
 * Mirrors pi's own context-file walk (see `loadProjectContextFiles` in
 * `@mariozechner/pi-coding-agent`): global agent dir first, then ancestor
 * directories from filesystem root down to cwd. Unlike context-file loading,
 * this walk does not require an AGENTS.md / CLAUDE.md anchor — overlays are
 * discovered on their own.
 *
 * The returned list is ordered farthest → nearest so overlay precedence can
 * be decided by index.
 */
export function discoverContextRoots(cwd: string, agentDir: string): string[] {
	const roots: string[] = [];
	const seen = new Set<string>();

	const addRoot = (dir: string, position: "append" | "unshift") => {
		if (seen.has(dir)) return;
		seen.add(dir);
		if (position === "append") roots.push(dir);
		else roots.unshift(dir);
	};

	// 1. Global agent dir always comes first.
	addRoot(resolve(agentDir), "append");

	// 2. Ancestor walk: filesystem root → cwd (farthest first).
	const ancestors: string[] = [];
	let currentDir = resolve(cwd);
	const fsRoot = resolve("/");

	while (true) {
		ancestors.unshift(currentDir);
		if (currentDir === fsRoot) break;
		const parent = resolve(currentDir, "..");
		if (parent === currentDir) break;
		currentDir = parent;
	}

	for (const dir of ancestors) {
		addRoot(dir, "append");
	}

	return roots;
}
