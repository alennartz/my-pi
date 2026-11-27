import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { registerSshTools } from "./index.ts";
import { connectOpenSsh } from "./openssh.ts";
import type { ConnectSsh, SshConnection } from "./session.ts";

function bindTools(connect: ConnectSsh) {
	const tools = new Map<string, ToolDefinition>();
	let shutdown: (() => void) | undefined;
	registerSshTools({
		registerTool: (tool) => { tools.set(tool.name, tool as ToolDefinition); },
		on: (event, handler) => {
			if (event === "session_shutdown") {
				shutdown = handler as unknown as () => void;
			}
		},
	}, connect);
	const context = { cwd: process.cwd() } as ExtensionToolContext;
	return {
		tools,
		call: (name: string, args: Record<string, unknown> = {}, signal?: AbortSignal) =>
			tools.get(name)!.execute(name, args, signal, undefined, context),
		shutdown: () => shutdown?.(),
	};
}

function text(result: Awaited<ReturnType<ReturnType<typeof bindTools>["call"]>>): string {
	return result.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
}

function fakeConnection() {
	const files = new Map([
		["/srv/service/app.conf", "mode=old\nports=1\nports=1\n"],
		["/home/operator/service.conf", "remote home"],
	]);
	const closed = new AbortController();
	const readFile = async (path: string) => {
		const content = files.get(path);
		if (content === undefined) {throw new Error(`No such remote file: ${path}`);}
		return Buffer.from(content);
	};
	const access = async (path: string) => { await readFile(path); };
	const writeFile = async (path: string, content: string) => { files.set(path, content); };
	const connection: SshConnection = {
		cwd: "/srv/service",
		home: "/home/operator",
		closed: closed.signal,
		async exec() { return { exitCode: 0 }; },
		files: () => ({
			read: { readFile, access },
			edit: { readFile, access, writeFile },
			write: { writeFile, async mkdir() {} },
		}),
		close: () => closed.abort(),
	};
	return connection;
}

describe("SSH tool contract", () => {
	it("registers only the SSH mirror, with only ssh_open exposed by default", () => {
		const { tools } = bindTools(async () => fakeConnection());
		expect(new Set(tools.keys())).toEqual(new Set([
			"ssh_open", "ssh_close", "ssh_bash", "ssh_read", "ssh_edit", "ssh_write",
		]));
		expect(tools.get("ssh_open")?.exposure ?? "direct").toBe("direct");
		expect(tools.get("ssh_open")?.defaultActive).not.toBe(false);
		for (const [name, tool] of tools) {
			if (name !== "ssh_open") {expect(tool.exposure).toBe("deferred");}
			expect(tool.executionMode).not.toBe("sequential");
		}
	});

	it("requires an open connection for every deferred tool", async () => {
		const { call } = bindTools(async () => fakeConnection());
		for (const [name, args] of [
			["ssh_bash", { command: "pwd" }],
			["ssh_read", { path: "app.conf" }],
			["ssh_edit", { path: "app.conf", edits: [{ oldText: "old", newText: "new" }] }],
			["ssh_write", { path: "app.conf", content: "new" }],
			["ssh_close", {}],
		] as const) {
			await expect(call(name, args)).rejects.toThrow(/ssh_open/);
		}
	});

	it("does not replace an open target, and close lets a new target open", async () => {
		const { call } = bindTools(async () => fakeConnection());
		const opened = text(await call("ssh_open", { target: "operator@first" }));
		expect(opened).toContain("operator@first");
		expect(opened).toContain("/srv/service");
		await expect(call("ssh_open", { target: "second" })).rejects.toThrow(/ssh_close/);
		expect(text(await call("ssh_read", { path: "app.conf" }))).toContain("operator@first");
		expect(text(await call("ssh_close"))).toContain("operator@first");
		await expect(call("ssh_read", { path: "app.conf" })).rejects.toThrow(/ssh_open/);
		expect(text(await call("ssh_open", { target: "second" }))).toContain("second");
		await call("ssh_close");
	});

	it("rejects SSH option strings as targets without leaving a binding", async () => {
		const { call } = bindTools(async () => fakeConnection());
		await expect(call("ssh_open", { target: "-oBatchMode=no" })).rejects.toThrow(/target/i);
		await expect(call("ssh_bash", { command: "pwd" })).rejects.toThrow(/ssh_open/);
	});

	it("does not inherit a binding across Pi sessions and discards a dropped connection", async () => {
		const transport = fakeConnection();
		const first = bindTools(async () => transport);
		const second = bindTools(async () => fakeConnection());
		await first.call("ssh_open", { target: "server" });
		await expect(second.call("ssh_read", { path: "app.conf" })).rejects.toThrow(/ssh_open/);
		transport.close();
		await expect(first.call("ssh_read", { path: "app.conf" })).rejects.toThrow(/ssh_open/);
	});

	it("closes the transport when Pi shuts down", async () => {
		const transport = fakeConnection();
		const { call, shutdown } = bindTools(async () => transport);
		await call("ssh_open", { target: "server" });
		shutdown();
		expect(transport.closed.aborted).toBe(true);
		await expect(call("ssh_write", { path: "app.conf", content: "new" })).rejects.toThrow(/ssh_open/);
	});

	it("disposes a connection that completes after Pi shuts down", async () => {
		const pending = Promise.withResolvers<SshConnection>();
		const transport = fakeConnection();
		const { call, shutdown } = bindTools(() => pending.promise);
		const opening = call("ssh_open", { target: "server" });
		shutdown();
		pending.resolve(transport);
		await expect(opening).rejects.toThrow(/session ended/i);
		expect(transport.closed.aborted).toBe(true);
	});

	it("rejects a competing operation while a call is in progress", async () => {
		const transport = fakeConnection();
		const commandStarted = Promise.withResolvers<void>();
		const result = Promise.withResolvers<{ exitCode: number }>();
		transport.exec = () => {
			commandStarted.resolve();
			return result.promise;
		};
		const { call } = bindTools(async () => transport);
		await call("ssh_open", { target: "server" });
		const command = call("ssh_bash", { command: "long command" });
		try {
			await commandStarted.promise;
			await expect(call("ssh_write", { path: "app.conf", content: "new" })).rejects.toThrow(/busy/i);
			await expect(call("ssh_close")).rejects.toThrow(/busy/i);
		} finally {
			result.resolve({ exitCode: 0 });
			await command;
		}
		expect(text(await call("ssh_read", { path: "app.conf" }))).toContain("mode=old");
		await call("ssh_close");
	});

	it("uses the remote home, pages text, and applies all replacements or none", async () => {
		const { call } = bindTools(async () => fakeConnection());
		await call("ssh_open", { target: "server" });
		expect(text(await call("ssh_read", { path: "~/service.conf" }))).toContain("remote home");
		const page = text(await call("ssh_read", { path: "app.conf", offset: 2, limit: 1 }));
		expect(page).toContain("ports=1");
		expect(page).not.toContain("mode=old");
		await expect(call("ssh_edit", {
			path: "app.conf",
			edits: [{ oldText: "mode=old", newText: "mode=new" }, { oldText: "ports=1", newText: "ports=2" }],
		})).rejects.toThrow();
		expect(text(await call("ssh_read", { path: "app.conf" }))).toContain("mode=old");
		await call("ssh_edit", { path: "app.conf", edits: [{ oldText: "mode=old", newText: "mode=new" }] });
		expect(text(await call("ssh_read", { path: "/srv/service/app.conf" }))).toContain("mode=new");
		await call("ssh_close");
	});
});

const testConfig = process.env.PI_SSH_TEST_CONFIG;

async function withServer(run: (tools: ReturnType<typeof bindTools>, cwd: string) => Promise<void>) {
	const cwd = await mkdtemp(join(tmpdir(), "pi-ssh-test-"));
	const tools = bindTools((request, signal) => connectOpenSsh(request, signal, testConfig));
	const deadline = AbortSignal.timeout(4000);
	const call: typeof tools.call = (name, args, signal) =>
		tools.call(name, args, signal ? AbortSignal.any([deadline, signal]) : deadline);
	try {
		await call("ssh_open", { target: "pi-ssh-test", cwd });
		await run({ ...tools, call }, cwd);
	} finally {
		tools.shutdown();
		await rm(cwd, { recursive: true, force: true });
	}
}

describe.skipIf(!testConfig)("OpenSSH tool contract (isolated SSH server on this machine)", () => {
	it("keeps Bash state without moving the base for file tools", async () => {
		await withServer(async ({ call }, cwd) => {
			await mkdir(join(cwd, "other"));
			await writeFile(join(cwd, "other", "app.conf"), "wrong directory");
			const trickyPath = "logs/a' $(touch unexpected)\n.txt";
			const content = "☕\u0000literal\n" + "á".repeat(80_000) + "\n";
			await call("ssh_write", { path: trickyPath, content });
			await call("ssh_write", { path: "app.conf", content: "mode=old\r\nport=1\r\n" });
			await call("ssh_bash", { command: "cd other; export PI_SSH_TEST_MODE=ready" });
			const result = await call("ssh_bash", { command: "printf '%s/%s\\n' \"${PWD##*/}\" \"$PI_SSH_TEST_MODE\"; echo err >&2; (exit 7)" });
			expect(result.isError).toBe(true);
			expect(result.structuredContent).toMatchObject({ exit_code: 7, output: expect.stringContaining("other/ready\nerr") });

			const file = text(await call("ssh_read", { path: "app.conf" }));
			expect(file).toContain("mode=old");
			expect(file).not.toContain("wrong directory");
			await call("ssh_edit", { path: "app.conf", edits: [{ oldText: "mode=old", newText: "mode=new" }] });
			expect(await readFile(join(cwd, "app.conf"), "utf8")).toBe("mode=new\r\nport=1\r\n");
			expect(await readFile(join(cwd, trickyPath), "utf8")).toBe(content);
			await expect(readFile(join(cwd, "unexpected"))).rejects.toThrow(/ENOENT/);
			expect(text(await call("ssh_read", { path: trickyPath, limit: 1 }))).toContain("☕\u0000literal");

			const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
			await writeFile(join(cwd, "image"), gif);
			const image = await call("ssh_read", { path: "image" });
			expect(image.content).toContainEqual(expect.objectContaining({ type: "image", mimeType: "image/gif" }));
		});
	});

	it("preserves the last user job and can wait for it in a later call", async () => {
		await withServer(async ({ call }) => {
			await call("ssh_bash", { command: "{ printf job; } >/dev/null 2>&1 & job=$!" });
			const result = await call("ssh_bash", {
				command: 'test "$!" = "$job" && wait "$!" && printf same',
				timeout: 1,
			});
			expect(result.structuredContent).toMatchObject({ output: "same", exit_code: 0 });
		});
	});

	it("keeps shell tracing out of the relay setup", async () => {
		await withServer(async ({ call }) => {
			await call("ssh_bash", { command: "set -T; trap 'printf trace' DEBUG" });
			await call("ssh_bash", { command: "trap - DEBUG", timeout: 1 });
			const result = await call("ssh_bash", { command: "printf clean" });
			expect(result.structuredContent).toMatchObject({ output: "clean", exit_code: 0 });
		});
	});

	it("closes the binding on abort", async () => {
		await withServer(async ({ call }) => {
			const controller = new AbortController();
			const command = call("ssh_bash", { command: "sleep 2" }, controller.signal);
			controller.abort();
			await expect(command).rejects.toThrow(/aborted/i);
			await expect(call("ssh_bash", { command: "pwd" })).rejects.toThrow(/ssh_open/);
		});
	});

	it("does not mix output from separate calls and fails closed on timeout", async () => {
		await withServer(async ({ call }, cwd) => {
			await call("ssh_bash", { command: "printf late &" });
			const clean = await call("ssh_bash", { command: "wait; printf next" });
			expect(clean.structuredContent).toMatchObject({ output: "next" });
			await expect(call("ssh_bash", { command: "sleep 2", timeout: 0.1 })).rejects.toThrow(/timed out/);
			await expect(call("ssh_read", { path: "app.conf" })).rejects.toThrow(/ssh_open/);
			await call("ssh_open", { target: "pi-ssh-test", cwd });
			const last = await call("ssh_bash", { command: "printf final; exit 7" });
			expect(last.isError).toBe(true);
			expect(last.structuredContent).toMatchObject({ output: "final", exit_code: 7 });
			await expect(call("ssh_bash", { command: "pwd" })).rejects.toThrow(/ssh_open/);
		});
	});
});
