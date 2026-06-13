import { resolve } from "node:path";

/**
 * Discover directories where model-prompt overlays may live.
 *
 * Mirrors pi's own context-file walk (see `loadProjectContextFiles` in
 * `@earendil-works/pi-coding-agent`): global agent dir first, then ancestor
 * directories from filesystem root down to cwd. Unlike context-file loading,
 * this walk does not require an AGENTS.md / CLAUDE.md anchor — overlays are
 * discovered on their own.
 *
 * The returned list is ordered farthest → nearest so overlay precedence can
 * be decided by index.
 *
 * The global agent dir is always included. Project-local ancestor roots
 * (project dir and its ancestors up from the filesystem root) are only walked
 * when `includeAncestors` is true — callers gate this on project trust, since
 * ancestor overlays are project-local resources that must not load untrusted.
 */
export function discoverContextRoots(cwd: string, agentDir: string, includeAncestors: boolean): string[] {
	const roots: string[] = [];
	const seen = new Set<string>();

	const addRoot = (dir: string) => {
		if (seen.has(dir)) return;
		seen.add(dir);
		roots.push(dir);
	};

	// 1. Global agent dir always comes first (not project-local, always trusted).
	addRoot(resolve(agentDir));

	if (!includeAncestors) return roots;

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
		addRoot(dir);
	}

	return roots;
}
