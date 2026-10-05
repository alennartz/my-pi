import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Host-provided packages (@earendil-works/*, typebox) are peers, not deps —
 * the manifest must never bundle them (docs/packages.md). Tests therefore
 * resolve them from the installed pi runtime. Override the location with
 * PI_HOST_MODULES when testing against a non-default install.
 */
function hostModules(): string {
	const override = process.env.PI_HOST_MODULES;
	if (override) return override;
	const releases = join(homedir(), ".local/share/pimote/releases");
	const newest = existsSync(releases) ? readdirSync(releases).sort().at(-1) : undefined;
	if (!newest) throw new Error("no pimote release found — set PI_HOST_MODULES to the pi node_modules dir");
	return join(releases, newest, "node_modules");
}

// Subpath specifiers must be listed before their bare package, or the bare
// alias swallows them (`.../dist/index.js/providers/all`).
const mods = hostModules();
const host = (p: string) => join(mods, p);

export default defineConfig({
	resolve: {
		alias: [
			{ find: "@earendil-works/pi-ai/providers/all", replacement: host("@earendil-works/pi-ai/dist/providers/all.js") },
			{ find: "@earendil-works/pi-ai/compat", replacement: host("@earendil-works/pi-ai/dist/compat.js") },
			{ find: "@earendil-works/pi-ai", replacement: host("@earendil-works/pi-ai/dist/index.js") },
			{ find: "@earendil-works/pi-coding-agent", replacement: host("@earendil-works/pi-coding-agent/dist/index.js") },
			{ find: "@earendil-works/pi-agent-core", replacement: host("@earendil-works/pi-agent-core/dist/index.js") },
			{ find: "@earendil-works/pi-tui", replacement: host("@earendil-works/pi-tui/dist/index.js") },
			{ find: "typebox", replacement: host("typebox/build/index.mjs") },
		],
	},
	test: {
		include: ["extensions/**/*.test.ts", "skills/**/*.test.ts", "lib/**/*.test.ts"],
	},
});
