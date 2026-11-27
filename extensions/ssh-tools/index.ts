import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
} from "@earendil-works/pi-coding-agent";
import type { AgentToolResult, ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { TSchema } from "typebox";
import { bashTimeoutSeconds, BUFFER_LIMIT_MIB, connectOpenSsh, DEFAULT_BASH_TIMEOUT, MAX_BASH_TIMEOUT } from "./openssh.ts";
import { SshSession, waitFor } from "./session.ts";
import type { Binding, ConnectSsh } from "./session.ts";

const namespace = { name: "ssh", description: "Remote SSH connection and file tools" };
const deferred = { exposure: "deferred", executionMode: "parallel", namespace } as const;

function mirror<P extends TSchema, D, S>(core: ToolDefinition<P, D, S>, name: string, snippet: string) {
	const { renderCall: _call, renderResult: _result, renderShell: _shell, ...definition } = core;
	return { ...definition, ...deferred, name, label: name, promptSnippet: snippet, promptGuidelines: [] };
}

function filePath({ target, connection }: Binding, path: string): string {
	const input = path.replace(/^@/, "").replaceAll(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
	try {
		const name = input.startsWith("file://") ? fileURLToPath(input) : input;
		if (!name || name.includes("\0")) {throw new Error("Provide a non-empty remote file path without NUL.");}
		if (name === "~") {return posix.resolve(connection.home);}
		if (name.startsWith("~/")) {return posix.join(connection.home, name.slice(2));}
		return posix.resolve(connection.cwd, name);
	} catch (error) {
		throw new Error(`SSH ${target}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
	}
}

function textResult(text: string): AgentToolResult<undefined> {
	return { content: [{ type: "text", text }], details: undefined };
}

function withTarget<D>(result: AgentToolResult<D>, location: string): AgentToolResult<D> {
	const [first, ...rest] = result.content;
	const content = first?.type === "text"
		? [{ ...first, text: `${location}\n${first.text}` }, ...rest]
		: [{ type: "text" as const, text: location }, ...result.content];
	return { ...result, content };
}

async function remote<T>(binding: Binding, path: string | undefined, run: (location: string) => Promise<T>): Promise<T> {
	const location = `SSH ${binding.target}${path === undefined ? "" : `:${JSON.stringify(path)}`}`;
	try {
		return await run(location);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const next = binding.connection.closed.aborted ? " Run ssh_open to reconnect." : "";
		throw new Error(`${location}: ${message}${next}`, { cause: error });
	}
}

export function registerSshTools(pi: Pick<ExtensionAPI, "registerTool" | "on">, connect: ConnectSsh): void {
	const session = new SshSession(connect);
	// Pi probes and queues paths locally, even with custom filesystem operations.
	const virtualRoot = join(tmpdir(), `pi-ssh-paths-${randomUUID()}`);
	pi.on("session_shutdown", () => session.shutdown());

	pi.registerTool({
		name: "ssh_open",
		label: "ssh_open",
		exposure: "direct",
		executionMode: "parallel",
		namespace,
		promptSnippet: "Bind the SSH helpers to a remote host.",
		promptGuidelines: [
			"Before using ssh_bash, ssh_read, ssh_edit, ssh_write, or ssh_close, call ssh_open.",
			"After ssh_open succeeds, find the deferred SSH tools with tool_search or call them from codemode.",
			"Await each ssh_* tool call before calling another SSH tool.",
		],
		description: "Open one SSH connection and return its target and fixed remote base directory. Uses existing OpenSSH configuration and verified host keys without prompting.",
		parameters: Type.Object({
			target: Type.String({ minLength: 1, maxLength: 255, description: "SSH config alias or hostname, optionally prefixed by user@." }),
			cwd: Type.Optional(Type.String({ description: "Remote base directory. Defaults to the remote login directory." })),
		}),
		async execute(_id, request, signal) {
			const { target, connection } = await session.open(request, signal);
			return textResult(`Opened SSH ${target} at ${JSON.stringify(connection.cwd)}.`);
		},
	});
	pi.registerTool({
		...deferred,
		name: "ssh_close",
		label: "ssh_close",
		promptSnippet: "End the remote Bash shell and release the SSH connection.",
		description: "Close the open SSH connection and discard its Bash state. Returns the closed target.",
		parameters: Type.Object({}),
		async execute(_id, _params, signal) {
			return textResult(`Closed SSH ${await session.close(signal)}.`);
		},
	});

	pi.registerTool({
		...mirror(createBashToolDefinition("/"), "ssh_bash", "Run commands in the persistent remote Bash shell."),
		description: `Execute a command in the open SSH shell with no interactive input. Returns stdout, stderr, and exit status, with the last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024} KB shown and truncated output saved locally. Cancellation, timeout, or output above ${BUFFER_LIMIT_MIB} MiB closes SSH.`,
		parameters: Type.Object({
			command: Type.String({ description: "Bash command to run on the remote host." }),
			timeout: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: MAX_BASH_TIMEOUT, description: `Timeout in seconds. Defaults to ${DEFAULT_BASH_TIMEOUT}.` })),
		}),
		async execute(id, params, signal, update, ctx) {
			return session.use(signal, (binding, active) => remote(binding, undefined, async (location) => {
				const bash = createBashToolDefinition(binding.connection.cwd, {
					exposeSessionEnvironment: false,
					operations: { exec: (command, _cwd, { onData, timeout }) =>
						binding.connection.exec(command, { onData, timeout, signal: active }) },
				});
				const timeout = bashTimeoutSeconds(params.timeout);
				const deadline = AbortSignal.timeout(Math.ceil(timeout * 1000) + 2000);
				const settled = new AbortController();
				const complete = AbortSignal.any([active, deadline, settled.signal]);
				try {
					const outputUpdate: Parameters<typeof bash.execute>[3] = update && ((partial) => {
						if (!complete.aborted) {update(withTarget(partial, location));}
					});
					const result = await waitFor(bash.execute(id, params, active, outputUpdate, ctx), complete);
					return withTarget(result, binding.connection.closed.aborted ? `${location} (closed)` : location);
				} catch (error) {
					if (active.aborted || deadline.aborted) {
						binding.connection.close();
						throw new Error(
							active.aborted ? "Command aborted. Output can be incomplete." : "SSH command output did not settle before the deadline.",
							{ cause: error },
						);
					}
					throw error;
				} finally {
					settled.abort();
				}
			}));
		},
	});

	const read = createReadToolDefinition("/");
	pi.registerTool({
		...mirror(read, "ssh_read", "Read a remote file without changing the Bash directory."),
		description: `Over SSH: ${read.description} Image reads buffer up to ${BUFFER_LIMIT_MIB} MiB.`,
		async execute(id, params, signal, _update, ctx) {
			return session.use(signal, (binding, active) => {
				const path = filePath(binding, params.path);
				return remote(binding, path, async (location) => {
					const { readFile, access, detectImageMimeType, createReadStream } = binding.connection.files(active).read;
					const tool = createReadToolDefinition("/", { operations: {
						readFile: () => readFile(path),
						access: () => access(path),
						detectImageMimeType: detectImageMimeType && (() => detectImageMimeType(path)),
						createReadStream: createReadStream && ((_path, options) => createReadStream(path, options)),
					} });
					const result = await tool.execute(id, { ...params, path: "/" }, active, undefined, { ...ctx, cwd: "/" });
					if (result.details?.truncation?.firstLineExceedsLimit) {
						const text = `The selected line exceeds the read limit. Use ssh_bash with the absolute path ${JSON.stringify(path)} to read part of the line.`;
						return withTarget({ ...result, ...textResult(text), details: result.details, structuredContent: text }, location);
					}
					return withTarget(result, location);
				});
			});
		},
	});

	const edit = createEditToolDefinition("/");
	pi.registerTool({
		...mirror(edit, "ssh_edit", "Apply exact text replacements to a remote file."),
		description: `Over SSH: ${edit.description} The file limit is ${BUFFER_LIMIT_MIB} MiB.`,
		async execute(id, params, signal, _update, ctx) {
			return session.use(signal, (binding, active) => {
				const path = filePath(binding, params.path);
				return remote(binding, path, async (location) => {
					const { access, readFile, writeFile } = binding.connection.files(active).edit;
					const tool = createEditToolDefinition(virtualRoot, { operations: {
						access: () => access(path),
						readFile: () => readFile(path),
						writeFile: (_path, content) => writeFile(path, content),
					} });
					const result = await tool.execute(id, { ...params, path: `.${path}` }, active, undefined, { ...ctx, cwd: virtualRoot });
					return withTarget({ ...result, ...textResult(`Replaced ${params.edits.length} block(s).`), details: result.details }, location);
				});
			});
		},
	});

	const write = createWriteToolDefinition("/");
	pi.registerTool({
		...mirror(write, "ssh_write", "Create or overwrite a file on the remote host."),
		description: `Over SSH: ${write.description}`,
		async execute(id, params, signal, _update, ctx) {
			return session.use(signal, (binding, active) => {
				const path = filePath(binding, params.path);
				return remote(binding, path, async (location) => {
					const { mkdir, writeFile } = binding.connection.files(active).write;
					const tool = createWriteToolDefinition(virtualRoot, { operations: {
						mkdir: () => mkdir(posix.dirname(path)),
						writeFile: (_path, content) => writeFile(path, content),
					} });
					await tool.execute(id, { ...params, path: `.${path}` }, active, undefined, { ...ctx, cwd: virtualRoot });
					return withTarget(textResult("Wrote file."), location);
				});
			});
		},
	});
}

export default function (pi: ExtensionAPI): void {
	registerSshTools(pi, connectOpenSsh);
}
