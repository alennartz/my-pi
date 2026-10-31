import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

export type DelegatingExtensionUIOptions = {
	headless: ExtensionUIContext;
};

/**
 * Stable extension UI context whose target may be attached or reset later.
 * Extensions bind to `context` once for the logical child session.
 */
export class DelegatingExtensionUI {
	readonly context: ExtensionUIContext;
	private readonly headless: ExtensionUIContext;
	private target: ExtensionUIContext;
	private generation = 0;

	constructor(options: DelegatingExtensionUIOptions) {
		this.headless = options.headless;
		this.target = options.headless;
		const owner = this;
		this.context = new Proxy({} as ExtensionUIContext, {
			get(_unused, property) {
				const value = (owner.target as any)[property];
				if (typeof value === "function") {
					return (...args: unknown[]) => {
						const target = owner.target as any;
						return Reflect.apply(target[property], target, args);
					};
				}
				return value;
			},
			ownKeys() {
				return Reflect.ownKeys(owner.target);
			},
			getOwnPropertyDescriptor(_unused, property) {
				const descriptor = Reflect.getOwnPropertyDescriptor(owner.target, property);
				return descriptor ? { configurable: true, enumerable: descriptor.enumerable } : undefined;
			},
			set(_unused, property, value) {
				(owner.target as any)[property] = value;
				return true;
			},
		});
	}

	attach(target: ExtensionUIContext): () => void {
		this.target = target;
		const token = ++this.generation;
		return () => {
			if (this.generation !== token) return;
			this.target = this.headless;
			this.generation++;
		};
	}

	reset(): void {
		this.target = this.headless;
		this.generation++;
	}
}
