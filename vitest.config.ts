import { defineConfig } from "vitest/config";

// All imports (@earendil-works/*, typebox) resolve from local devDependencies,
// pinned by package-lock.json. Nothing is resolved from any pi install
// location, so tests cannot drift from the manifest.
export default defineConfig({
	test: {
		include: ["extensions/**/*.test.ts", "skills/**/*.test.ts", "lib/**/*.test.ts"],
	},
});
