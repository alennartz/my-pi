import { fileURLToPath } from "node:url";

/** Absolute path of the root subagents extension, used to filter loader diagnostics. */
export const rootExtensionPath = fileURLToPath(new URL("./index.ts", import.meta.url)).replaceAll("\\", "/");
