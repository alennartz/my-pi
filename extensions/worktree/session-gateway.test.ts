import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createSessionGateway } from "./index.ts";

function makeTempDirs() {
	const root = mkdtempSync(join(tmpdir(), "worktree-session-gateway-"));
	return {
		sessionDir: join(root, "sessions"),
		worktreeCwd: mkdtempSync(join(tmpdir(), "worktree-cwd-")),
	};
}

describe("worktree session gateway", () => {
	it("create writes the session file to disk immediately with the worktree cwd in the header", async () => {
		const { sessionDir, worktreeCwd } = makeTempDirs();
		const gateway = createSessionGateway(sessionDir);

		const sessionFile = await gateway.create(worktreeCwd);

		// pi persists sessions lazily (nothing hits disk before the first
		// assistant message), but switchSession resolves the new session's cwd
		// from the file header — a missing file silently falls back to
		// process.cwd(). The gateway must therefore persist the header eagerly.
		expect(existsSync(sessionFile)).toBe(true);
		const header = JSON.parse(readFileSync(sessionFile, "utf8").split("\n")[0]!);
		expect(header.type).toBe("session");
		expect(header.cwd).toBe(worktreeCwd);
		expect(SessionManager.open(sessionFile).getCwd()).toBe(worktreeCwd);
	});

	it("continueRecent returns undefined when no session exists on disk", async () => {
		const { sessionDir, worktreeCwd } = makeTempDirs();
		const gateway = createSessionGateway(sessionDir);

		// SessionManager.continueRecent falls back to creating a fresh, lazily
		// persisted session whose file does not exist yet. The gateway must not
		// surface that phantom path — the controller would switchSession into a
		// file whose header can never be read.
		expect(await gateway.continueRecent(worktreeCwd)).toBeUndefined();
	});

	it("continueRecent returns a previously created session file", async () => {
		const { sessionDir, worktreeCwd } = makeTempDirs();
		const gateway = createSessionGateway(sessionDir);

		const created = await gateway.create(worktreeCwd);

		expect(await gateway.continueRecent(worktreeCwd)).toBe(created);
	});
});
