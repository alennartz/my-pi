import type { BashOperations, EditOperations, ReadOperations, WriteOperations } from "@earendil-works/pi-coding-agent";

export interface OpenRequest {
	target: string;
	cwd?: string;
}

type BashOptions = Pick<Parameters<BashOperations["exec"]>[2], "signal" | "timeout" | "onData">;

export interface SshConnection {
	readonly cwd: string;
	readonly home: string;
	readonly closed: AbortSignal;
	exec(command: string, options: BashOptions): Promise<{ exitCode: number }>;
	files(signal: AbortSignal): { read: ReadOperations; edit: EditOperations; write: WriteOperations };
	close(): void;
}

export type ConnectSsh = (request: OpenRequest, signal: AbortSignal) => Promise<SshConnection>;

export interface Binding {
	readonly target: string;
	readonly connection: SshConnection;
}

const NOT_OPEN = "No SSH connection is open. Run ssh_open first.";

export async function waitFor<T>(result: Promise<T>, signal: AbortSignal): Promise<T> {
	const aborted = Promise.withResolvers<never>();
	const reject = () => aborted.reject(signal.reason);
	signal.addEventListener("abort", reject, { once: true });
	if (signal.aborted) {reject();}
	try {
		return await Promise.race([result, aborted.promise]);
	} finally {
		signal.removeEventListener("abort", reject);
	}
}

export class SshSession {
	readonly #connect: ConnectSsh;
	readonly #lifetime = new AbortController();
	#binding: Binding | undefined;
	#busy = false;

	constructor(connect: ConnectSsh) {
		this.#connect = connect;
	}

	open(request: OpenRequest, signal?: AbortSignal): Promise<Binding> {
		return this.#exclusive(async () => {
			if (this.#current()) {throw new Error("An SSH connection is already open. Run ssh_close first.");}
			if (!/^(?:[\w][\w.-]*@)?[\w][\w.+-]*$/.test(request.target) ||
				request.target.trim() !== request.target || request.target.length > 255) {
				throw new Error("Invalid SSH target. Use an SSH config alias or hostname, optionally prefixed by user@.");
			}
			if (request.cwd?.includes("\0")) {throw new Error("The SSH base directory cannot contain NUL.");}
			const active = this.#activeSignal(signal);
			active.throwIfAborted();
			const connection = await this.#connect(request, active);
			if (active.aborted || connection.closed.aborted) {
				connection.close();
				active.throwIfAborted();
				throw new Error("The SSH connection closed while opening.");
			}
			const binding = { target: request.target, connection };
			this.#binding = binding;
			return binding;
		});
	}

	use<T>(signal: AbortSignal | undefined, run: (binding: Binding, signal: AbortSignal) => Promise<T>): Promise<T> {
		return this.#exclusive(() => {
			const binding = this.#current();
			if (!binding) {throw new Error(NOT_OPEN);}
			const active = this.#activeSignal(signal);
			active.throwIfAborted();
			return run(binding, active);
		});
	}

	close(signal?: AbortSignal): Promise<string> {
		return this.use(signal, async ({ target }) => {
			this.#release();
			return target;
		});
	}

	shutdown(): void {
		this.#lifetime.abort(new Error("The Pi session ended."));
		this.#release();
	}

	#current(): Binding | undefined {
		if (this.#binding?.connection.closed.aborted) {this.#release();}
		return this.#binding;
	}

	#release(): void {
		const binding = this.#binding;
		this.#binding = undefined;
		binding?.connection.close();
	}

	#activeSignal(signal?: AbortSignal): AbortSignal {
		return signal ? AbortSignal.any([this.#lifetime.signal, signal]) : this.#lifetime.signal;
	}

	async #exclusive<T>(run: () => Promise<T>): Promise<T> {
		if (this.#busy) {throw new Error("SSH is busy. Wait for the current tool call to finish.");}
		this.#busy = true;
		try {
			return await run();
		} finally {
			this.#busy = false;
		}
	}
}
