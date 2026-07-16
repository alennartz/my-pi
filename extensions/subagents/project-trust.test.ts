import { describe, expect, it, vi } from "vitest";
import type {
	DefaultProjectTrust,
	LoadExtensionsResult,
	ProjectTrustContext,
	ProjectTrustEventDecision,
	ProjectTrustStore,
} from "@earendil-works/pi-coding-agent";
import { resolveChildProjectTrust } from "./project-trust.js";

function makeContext(): ProjectTrustContext & { ui: Record<string, ReturnType<typeof vi.fn>> } {
	return {
		cwd: "/repo",
		mode: "rpc",
		hasUI: false,
		ui: {
			select: vi.fn(async () => undefined),
			confirm: vi.fn(async () => false),
			input: vi.fn(async () => undefined),
			notify: vi.fn(),
		},
	};
}

function makeTrustStore(saved: boolean | null): Pick<ProjectTrustStore, "get" | "set"> {
	return {
		get: vi.fn(() => saved),
		set: vi.fn(),
	};
}

function makeExtensions(
	decision?: ProjectTrustEventDecision,
): { result: LoadExtensionsResult; handler?: ReturnType<typeof vi.fn> } {
	if (!decision) {
		return {
			result: { extensions: [], errors: [], runtime: {} } as LoadExtensionsResult,
		};
	}
	const handler = vi.fn(() => ({ trusted: decision }));
	return {
		result: {
			extensions: [{
				path: "/repo/.pi/extensions/trust.ts",
				handlers: new Map([["project_trust", [handler]]]),
			}] as any[],
			errors: [],
			runtime: {},
		} as LoadExtensionsResult,
		handler,
	};
}

function makeExtensionsWithHandlers(handlers: Array<(...args: any[]) => unknown>): LoadExtensionsResult {
	return {
		extensions: [{
			path: "/repo/.pi/extensions/trust.ts",
			handlers: new Map([["project_trust", handlers]]),
		}] as any[],
		errors: [],
		runtime: {},
	} as LoadExtensionsResult;
}

function resolve(
	overrides: Partial<Parameters<typeof resolveChildProjectTrust>[0]> = {},
): Promise<boolean> {
	return resolveChildProjectTrust({
		cwd: "/repo",
		extensionsResult: makeExtensions().result,
		trustStore: makeTrustStore(null),
		defaultProjectTrust: "ask",
		projectTrustContext: makeContext(),
		...overrides,
	});
}

describe("resolveChildProjectTrust", () => {
	it("uses a decisive extension project_trust result before saved trust and defaults", async () => {
		for (const [decision, expected] of [
			["yes", true],
			["no", false],
		] as const satisfies ReadonlyArray<readonly [ProjectTrustEventDecision, boolean]>) {
			const extension = makeExtensions(decision);
			const context = makeContext();

			await expect(resolve({
				extensionsResult: extension.result,
				trustStore: makeTrustStore(!expected),
				defaultProjectTrust: expected ? "never" : "always",
				projectTrustContext: context,
			})).resolves.toBe(expected);
			expect(extension.handler).toHaveBeenCalledWith(
				{ type: "project_trust", cwd: "/repo" },
				context,
			);
		}
	});

	it("uses saved trust after an undecided extension result and before the default", async () => {
		const extension = makeExtensions("undecided");

		await expect(resolve({
			extensionsResult: extension.result,
			trustStore: makeTrustStore(true),
			defaultProjectTrust: "never",
		})).resolves.toBe(true);
		expect(extension.handler).toHaveBeenCalledTimes(1);
	});

	it("uses both configured defaults after extension and saved trust are unresolved", async () => {
		for (const [defaultProjectTrust, expected] of [
			["always", true],
			["never", false],
		] as const satisfies ReadonlyArray<readonly [DefaultProjectTrust, boolean]>) {
			await expect(resolve({
				defaultProjectTrust,
				trustStore: makeTrustStore(null),
			})).resolves.toBe(expected);
		}
	});

	it("declines an unresolved ask default without using child UI", async () => {
		const context = makeContext();
		await expect(resolve({
			defaultProjectTrust: "ask",
			trustStore: makeTrustStore(null),
			projectTrustContext: context,
		})).resolves.toBe(false);
		expect(context.ui.select).not.toHaveBeenCalled();
		expect(context.ui.confirm).not.toHaveBeenCalled();
		expect(context.ui.input).not.toHaveBeenCalled();
	});

	it("persists a remembered decisive extension result", async () => {
		const trustStore = makeTrustStore(null);
		const remembered = vi.fn(() => ({ trusted: "yes", remember: true }));

		await expect(resolve({
			extensionsResult: makeExtensionsWithHandlers([remembered]),
			trustStore,
		})).resolves.toBe(true);
		expect(trustStore.set).toHaveBeenCalledWith("/repo", true);
	});

	it("reports an async handler failure and continues in loader order to a later decision", async () => {
		const failed = vi.fn(async () => {
			throw new Error("trust handler failed");
		});
		const decides = vi.fn(async () => ({ trusted: "yes" }));
		const onExtensionError = vi.fn();

		await expect(resolve({
			extensionsResult: makeExtensionsWithHandlers([failed, decides]),
			defaultProjectTrust: "never",
			onExtensionError,
		})).resolves.toBe(true);
		expect(onExtensionError).toHaveBeenCalledWith(expect.objectContaining({
			extensionPath: "/repo/.pi/extensions/trust.ts",
			event: "project_trust",
			error: "trust handler failed",
		}));
		expect(decides).toHaveBeenCalledTimes(1);
	});
});
