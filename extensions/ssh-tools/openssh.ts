import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { waitFor } from "./session.ts";
import type { OpenRequest, SshConnection } from "./session.ts";

export const DEFAULT_BASH_TIMEOUT = 120;
export const MAX_BASH_TIMEOUT = 3600;
const CONNECT_MS = 15_000;
const FILE_MS = 30_000;
export const BUFFER_LIMIT_MIB = 64;
const BUFFER_LIMIT = BUFFER_LIMIT_MIB * 1024 * 1024;
const IMAGE_PREFIX_BYTES = 4100;
const NUL = Buffer.from([0]);
const EMPTY = Buffer.alloc(0);

const BASH_DRIVER = `
if (( BASH_VERSINFO[0] < 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] < 4) )); then
	builtin printf '%s\\n' 'Remote Bash 4.4 or later is required.' >&2
	exit 1
fi
__pi_ssh_home=$(builtin cd -P -- "$HOME" && builtin printf '%s.' "$PWD") || exit 1
__pi_ssh_home=\${__pi_ssh_home%.}
case $2 in
	'')   __pi_ssh_base=. ;;
	'~')  __pi_ssh_base=$__pi_ssh_home ;;
	'~/'*) __pi_ssh_base=$__pi_ssh_home/\${2:2} ;;
	/*)   __pi_ssh_base=$2 ;;
	*)    __pi_ssh_base=./$2 ;;
esac
builtin cd -P -- "$__pi_ssh_base" || exit 1
exec {__pi_ssh_wire}>&1 1>&2
builtin printf '\\000%s\\000%s\\000%s\\000' "$1" "$PWD" "$__pi_ssh_home" >&"$__pi_ssh_wire"
builtin set --
while IFS= builtin read -r -d '' __pi_ssh_token && IFS= builtin read -r -d '' __pi_ssh_command; do
	__pi_ssh_pipe=/tmp/pi-ssh-pipe.$__pi_ssh_token
	builtin command -p mkdir -m 700 -- "$__pi_ssh_pipe" || exit 1
	if ! builtin command -p mkfifo -m 600 -- "$__pi_ssh_pipe/out" "$__pi_ssh_pipe/status"; then
		builtin command -p rm -rf -- "$__pi_ssh_pipe"
		exit 1
	fi
	# Start the relay in a subshell so it never changes the user's $! or wait.
	(
		(
			exec {__pi_out}<"$__pi_ssh_pipe/out" {__pi_status}<"$__pi_ssh_pipe/status"
			builtin command -p rm -rf -- "$__pi_ssh_pipe"
			builtin command -p cat <&"$__pi_out" >&"$__pi_ssh_wire"
			if IFS= builtin read -r __pi_code <&"$__pi_status"; then
				builtin printf '\\000%s\\000%d\\000' "$__pi_ssh_token" "$__pi_code" >&"$__pi_ssh_wire"
			fi
		) </dev/null &
	)
	exec {__pi_ssh_output}>"$__pi_ssh_pipe/out" {__pi_ssh_status}>"$__pi_ssh_pipe/status"
	builtin printf '\\000%s\\000' "$__pi_ssh_token" >&"$__pi_ssh_wire"
	builtin unset __pi_ssh_token __pi_ssh_pipe
	builtin eval -- "$__pi_ssh_command" </dev/null >&"$__pi_ssh_output" 2>&1 {__pi_ssh_output}>&- {__pi_ssh_status}>&- {__pi_ssh_wire}>&-
	__pi_ssh_code=$?
	exec {__pi_ssh_output}>&-
	builtin printf '%d\\n' "$__pi_ssh_code" >&"$__pi_ssh_status"
	exec {__pi_ssh_status}>&-
done
`;

function quote(value: string): string {
	return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

function remoteBash(script: string, id: string, path: string): string {
	const bytes = Buffer.from(path).toString("hex").replaceAll(/../g, String.raw`\x$&`);
	const decode = 'builtin printf -v __pi_ssh_path %b "$2"\nbuiltin set -- "$1" "$__pi_ssh_path"\n';
	return `exec env BASH_ENV= bash --noprofile --norc -c ${quote(decode + script)} pi-ssh ${id} ${quote(bytes)}`;
}

export function bashTimeoutSeconds(timeout?: number): number {
	if (timeout === undefined) {return DEFAULT_BASH_TIMEOUT;}
	if (!Number.isFinite(timeout) || timeout <= 0 || timeout > MAX_BASH_TIMEOUT) {
		throw new Error(`Invalid timeout: use a positive number of seconds, up to ${MAX_BASH_TIMEOUT}.`);
	}
	return timeout;
}

function token(): string {
	return randomBytes(16).toString("hex");
}

function marker(id: string): Buffer {
	return Buffer.from(`\0${id}\0`);
}

/** Consume raw stdout up to a delimiter without buffering the preceding output. */
class OutputReader {
	readonly #chunks: AsyncIterator<Buffer>;
	#pending: Buffer = EMPTY;

	constructor(stream: Readable) {
		this.#chunks = stream[Symbol.asyncIterator]();
	}

	async through(delimiter: Buffer, data?: (chunk: Buffer) => void): Promise<boolean> {
		for (;;) {
			const match = this.#pending.indexOf(delimiter);
			if (match >= 0) {
				if (match > 0) {data?.(this.#pending.subarray(0, match));}
				this.#pending = this.#pending.subarray(match + delimiter.length);
				return true;
			}
			const keep = Math.max(0, this.#pending.length - delimiter.length + 1);
			if (keep > 0) {data?.(this.#pending.subarray(0, keep));}
			const tail = this.#pending.subarray(keep);
			const next = await this.#chunks.next();
			if (next.done) {
				if (tail.length > 0) {data?.(tail);}
				this.#pending = EMPTY;
				return false;
			}
			this.#pending = tail.length ? Buffer.concat([tail, next.value]) : next.value;
		}
	}

	async field(maxBytes: number): Promise<string> {
		const chunks: Buffer[] = [];
		let length = 0;
		const complete = await this.through(NUL, (chunk) => {
			length += chunk.length;
			if (length > maxBytes) {throw new Error("Invalid SSH response field.");}
			chunks.push(chunk);
		});
		if (!complete) {throw new Error("Incomplete SSH response.");}
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks, length));
	}

	async *rest(): AsyncIterable<Buffer> {
		const first = this.#pending;
		this.#pending = EMPTY;
		if (first.length) {yield first;}
		for (let next = await this.#chunks.next(); !next.done; next = await this.#chunks.next()) {
			yield next.value;
		}
	}
}

type Exit = { code: number | null; signal: NodeJS.Signals | null; error?: Error };

class SshProcess {
	readonly child: ChildProcessWithoutNullStreams;
	readonly output: OutputReader;
	readonly exited: Promise<Exit>;
	#stderr = EMPTY;

	constructor(args: string[]) {
		this.child = spawn("ssh", args, {
			detached: true,
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, SSH_ASKPASS_REQUIRE: "never" },
		});
		this.output = new OutputReader(this.child.stdout);
		this.child.stdin.on("error", () => {});
		this.child.stderr.on("data", (chunk: Buffer) => {
			this.#stderr = Buffer.concat([this.#stderr, chunk.subarray(-4096)]).subarray(-4096);
		});
		this.exited = new Promise((resolve) => {
			this.child.once("exit", (code, signal) => {
				this.#stopGroup();
				resolve({ code, signal });
			});
			this.child.once("error", (error) => resolve({ code: null, signal: null, error }));
		});
	}

	failure(message: string, exit: Exit): Error {
		const diagnostic = exit.error?.message || this.#stderr.toString("utf8").trim();
		const status = exit.code ?? exit.signal;
		return new Error(`${message}${status === null ? "" : ` (${status})`}${diagnostic ? `: ${diagnostic}` : "."}`);
	}

	wait(signal: AbortSignal): Promise<Exit> {
		return waitFor(this.exited, signal);
	}

	stop(): void {
		if (this.child.exitCode === null && this.child.signalCode === null) {this.#stopGroup();}
		this.child.stdin.destroy();
		this.child.stdout.destroy();
		this.child.stderr.destroy();
	}

	#stopGroup(): void {
		const pid = this.child.pid;
		if (!pid) {return;}
		try {
			process.kill(-pid, "SIGKILL");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") {console.warn("Could not stop SSH processes:", error);}
		}
	}
}

async function collect(chunks: AsyncIterable<Buffer>, maxBytes = BUFFER_LIMIT): Promise<Buffer> {
	const buffers: Buffer[] = [];
	let length = 0;
	for await (const chunk of chunks) {
		length += chunk.length;
		if (length > maxBytes) {throw new Error(`Remote file exceeds the ${maxBytes / (1024 * 1024)} MiB buffer limit.`);}
		buffers.push(chunk);
	}
	return Buffer.concat(buffers, length);
}

function imageMimeType(header: Buffer): string | null {
	const matches = (offset: number, text: string) => header.toString("latin1", offset, offset + text.length) === text;
	if (matches(0, "\u00ff\u00d8\u00ff")) {return header[3] === 0xf7 ? null : "image/jpeg";}
	if (matches(0, "\u0089PNG\r\n\u001a\n") && matches(12, "IHDR") && header.readUInt32BE(8) === 13) {
		for (let offset = 8; offset + 8 <= header.length; offset += 12 + header.readUInt32BE(offset)) {
			if (matches(offset + 4, "acTL")) {return null;}
			if (matches(offset + 4, "IDAT")) {break;}
		}
		return "image/png";
	}
	if (matches(0, "GIF87a") || matches(0, "GIF89a")) {return "image/gif";}
	if (matches(0, "RIFF") && matches(8, "WEBP")) {return "image/webp";}
	if (!matches(0, "BM") || header.length < 26) {return null;}
	const declaredSize = header.readUInt32LE(2);
	const pixelOffset = header.readUInt32LE(10);
	const dib = header.readUInt32LE(14);
	if (pixelOffset < 14 + dib || (declaredSize !== 0 && pixelOffset >= declaredSize)) {return null;}
	const planes = dib === 12 ? 22 : dib >= 40 && dib <= 124 && header.length >= 30 ? 26 : -1;
	return planes >= 0 && header.readUInt16LE(planes) === 1 &&
		[1, 4, 8, 16, 24, 32].includes(header.readUInt16LE(planes + 2)) ? "image/bmp" : null;
}

const READABLE = `[[ -r $1 && ( -f $1 || $1 -ef /dev/null ) ]] || { builtin printf '%s\\n' 'Not a readable file.' >&2; exit 1; }`;
const WRITABLE = `[[ ! -e $1 || -f $1 || $1 -ef /dev/null ]] || { builtin printf '%s\\n' 'Not a regular file.' >&2; exit 1; }`;
const READ_SNAPSHOT = `
exec 3<"$1" || exit 1
size=$(builtin command -p stat -L -c %s /dev/fd/3 2>/dev/null || builtin command -p stat -L -f %z /dev/fd/3 2>/dev/null)
if [[ $size =~ ^[1-9][0-9]*$ ]]; then
	builtin command -p head -c "$size" <&3
else
	builtin command -p cat <&3
fi
`;

function* textChunks(text: string): Iterable<string> {
	for (let start = 0; start < text.length;) {
		let end = Math.min(start + 16_384, text.length);
		if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) {end++;}
		yield text.slice(start, end);
		start = end;
	}
}

class OpenSshConnection implements SshConnection {
	readonly #master: SshProcess;
	readonly #directory: string;
	readonly #socket: string;
	readonly #lifetime = new AbortController();
	#cwd = "";
	#home = "";

	constructor(directory: string, master: SshProcess) {
		this.#directory = directory;
		this.#socket = join(directory, "c");
		this.#master = master;
		void master.exited.then((exit) => this.#invalidate(master.failure("SSH shell closed", exit)));
	}

	get cwd(): string { return this.#cwd; }
	get home(): string { return this.#home; }
	get closed(): AbortSignal { return this.#lifetime.signal; }

	async initialize(id: string, signal: AbortSignal): Promise<void> {
		const active = AbortSignal.any([signal, AbortSignal.timeout(CONNECT_MS)]);
		const stop = () => this.close();
		active.addEventListener("abort", stop, { once: true });
		try {
			active.throwIfAborted();
			if (!await this.#master.output.through(marker(id))) {
				throw this.#master.failure("Could not start remote Bash", await this.#master.wait(active));
			}
			this.#cwd = await this.#master.output.field(4096);
			this.#home = await this.#master.output.field(4096);
			if (!this.#cwd.startsWith("/") || !this.#home.startsWith("/")) {throw new Error("Invalid remote base or home directory.");}
			await collect(this.#file(":", this.#cwd, active), 0);
		} catch (error) {
			if (active.aborted) {
				signal.throwIfAborted();
				throw new Error("SSH open timed out.", { cause: error });
			}
			throw error;
		} finally {
			active.removeEventListener("abort", stop);
		}
	}

	async exec(command: string, options: Parameters<SshConnection["exec"]>[1]): Promise<{ exitCode: number }> {
		const { signal, timeout, onData } = options;
		signal?.throwIfAborted();
		this.closed.throwIfAborted();
		if (command.includes("\0")) {throw new Error("A Bash command cannot contain NUL.");}
		const seconds = bashTimeoutSeconds(timeout);
		const timer = AbortSignal.timeout(Math.ceil(seconds * 1000));
		const active = signal ? AbortSignal.any([signal, timer]) : timer;
		const stop = () => this.close();
		active.addEventListener("abort", stop, { once: true });
		try {
			const id = token();
			const frame = marker(id);
			this.#master.child.stdin.write(`${id}\0${command}\0`);
			if (!await this.#master.output.through(frame)) {
				throw this.#master.failure("SSH shell closed before running the command", await this.#master.wait(active));
			}
			let size = 0;
			if (!await this.#master.output.through(frame, (chunk) => {
				size += chunk.length;
				if (size > BUFFER_LIMIT) {throw new Error(`SSH command exceeded the ${BUFFER_LIMIT_MIB} MiB output limit.`);}
				onData(chunk);
			})) {
				const exit = await this.#master.wait(active);
				active.throwIfAborted();
				if (exit.code !== null && exit.code < 255) {
					this.close();
					return { exitCode: exit.code };
				}
				throw this.#master.failure("SSH shell closed before returning a status", exit);
			}
			const code = await this.#master.output.field(3);
			active.throwIfAborted();
			if (!/^\d{1,3}$/.test(code) || Number(code) > 255) {throw new Error("Invalid remote Bash exit status.");}
			return { exitCode: Number(code) };
		} catch (error) {
			this.close();
			if (signal?.aborted) {throw new Error("aborted", { cause: error });}
			if (timer.aborted) {throw new Error(`timeout:${seconds}`, { cause: error });}
			throw error;
		} finally {
			active.removeEventListener("abort", stop);
		}
	}

	files(signal: AbortSignal): ReturnType<SshConnection["files"]> {
		const read = (script: string, path: string) => this.#file(`${READABLE}\n${script}`, path, signal);
		const stream = (path: string) => read(READ_SNAPSHOT, path);
		const readFile = (path: string) => collect(stream(path));
		const writeFile = async (path: string, content: string) => {
			await collect(this.#file(`${WRITABLE}\nbuiltin command -p cat > "$1"`, path, signal, content));
		};
		return {
			read: {
				async access() {},
				readFile,
				createReadStream: stream,
				detectImageMimeType: async (path) => imageMimeType(await collect(read(`builtin command -p head -c ${IMAGE_PREFIX_BYTES} -- "$1"`, path), IMAGE_PREFIX_BYTES)),
			},
			edit: {
				access: async (path) => { await collect(read('[[ -w $1 ]]', path)); },
				readFile,
				writeFile,
			},
			write: {
				mkdir: async (path) => { await collect(this.#file('builtin command -p mkdir -p -- "$1"', path, signal)); },
				writeFile,
			},
		};
	}

	close(): void {
		this.#invalidate(new Error("SSH connection closed."));
		this.#master.stop();
	}

	#invalidate(reason: Error): void {
		if (this.closed.aborted) {return;}
		this.#lifetime.abort(reason);
		try {
			rmSync(this.#directory, { recursive: true, force: true });
		} catch (error) {
			console.warn("Could not remove SSH control socket:", error);
		}
	}

	#slaveOptions(): string[] {
		// A lost socket must not turn a file operation into a new SSH connection.
		return ["-F", "/dev/null", "-T", "-S", this.#socket, "-oBatchMode=yes", "-oProxyCommand=/bin/false"];
	}

	async *#file(script: string, path: string, signal: AbortSignal, input?: string): AsyncIterable<Buffer> {
		const timer = AbortSignal.timeout(FILE_MS);
		const active = AbortSignal.any([signal, this.closed, timer]);
		active.throwIfAborted();
		const id = token();
		const command = remoteBash(`builtin printf '\\000%s\\000' "$1"\nshift\n${script}`, id, path);
		const process = new SshProcess([...this.#slaveOptions(), "--", "pi-ssh-master", command]);
		const stop = () => process.stop();
		active.addEventListener("abort", stop, { once: true });
		try {
			if (input === undefined) {process.child.stdin.end();}
			const began = await process.output.through(marker(id));
			if (began && input !== undefined) {
				await pipeline(Readable.from(textChunks(input)), process.child.stdin, { signal: active });
			} else if (input !== undefined) {
				process.child.stdin.end();
			}
			if (began) {yield* process.output.rest();}
			const exit = await process.wait(active);
			if (!began || exit.code !== 0) {
				const error = process.failure("SSH file operation failed", exit);
				if (exit.code === 255) {
					this.#invalidate(error);
					this.#master.stop();
				}
				throw error;
			}
		} catch (error) {
			if (timer.aborted) {throw new Error("SSH file operation timed out.", { cause: error });}
			active.throwIfAborted();
			throw error;
		} finally {
			active.removeEventListener("abort", stop);
			stop();
		}
	}
}

export async function connectOpenSsh(request: OpenRequest, signal: AbortSignal, configFile?: string): Promise<SshConnection> {
	if (process.platform === "win32") {throw new Error("The SSH tools require a Unix OpenSSH client.");}
	signal.throwIfAborted();
	const directory = mkdtempSync(join(tmpdir(), "pi-ssh-"));
	const id = token();
	const args = [
		...(configFile ? ["-F", configFile] : []),
		"-T", "-S", join(directory, "c"), "-oControlMaster=yes", "-oControlPersist=no", "-oBatchMode=yes",
		"-oStrictHostKeyChecking=yes", "-oNoHostAuthenticationForLocalhost=no", "-oUpdateHostKeys=no",
		"-oForwardAgent=no", "-oForwardX11=no",
		"-oClearAllForwardings=yes", "-oPermitLocalCommand=no", "-oRemoteCommand=none", "-oSessionType=default",
		"-oForkAfterAuthentication=no", "-oStdinNull=no", "-oServerAliveInterval=15", "-oServerAliveCountMax=2",
		"--", request.target, remoteBash(BASH_DRIVER, id, request.cwd ?? ""),
	];
	let connection: OpenSshConnection | undefined;
	try {
		connection = new OpenSshConnection(directory, new SshProcess(args));
		await connection.initialize(id, signal);
		return connection;
	} catch (error) {
		if (connection) {
			connection.close();
		} else {
			rmSync(directory, { recursive: true, force: true });
		}
		throw new Error(`Could not open SSH ${request.target}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
	}
}
