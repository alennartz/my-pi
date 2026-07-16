import { describe, expect, it, vi } from "vitest";
import { DelegatingExtensionUI } from "./delegating-extension-ui.js";

function makeTarget(label: string): any {
	return {
		label,
		notify: vi.fn(),
		select: vi.fn(async () => `${label}-selection`),
		confirm: vi.fn(async () => label === "attached"),
		input: vi.fn(async () => `${label}-input`),
		onTerminalInput: vi.fn(() => () => {}),
		setStatus: vi.fn(),
		setWorkingMessage: vi.fn(),
		setWorkingVisible: vi.fn(),
		setWorkingIndicator: vi.fn(),
		setHiddenThinkingLabel: vi.fn(),
		setWidget: vi.fn(),
		setFooter: vi.fn(),
		setHeader: vi.fn(),
		setTitle: vi.fn(),
		custom: vi.fn(async () => undefined),
		pasteToEditor: vi.fn(),
		setEditorText: vi.fn(),
		getEditorText: vi.fn(() => ""),
		editor: vi.fn(async () => undefined),
		addAutocompleteProvider: vi.fn(),
		setEditorComponent: vi.fn(),
		getEditorComponent: vi.fn(() => `${label}-editor-component`),
		theme: { name: `${label}-theme` },
		getAllThemes: vi.fn(() => [{ name: `${label}-theme`, path: undefined }]),
		getTheme: vi.fn((name: string) => ({ name, target: label })),
		setTheme: vi.fn(() => ({ success: true })),
		getToolsExpanded: vi.fn(() => label === "attached"),
		setToolsExpanded: vi.fn(),
	};
}

describe("DelegatingExtensionUI", () => {
	it("keeps one stable context while forwarding initially to the headless target", async () => {
		const headless = makeTarget("headless");
		const ui = new DelegatingExtensionUI({ headless });
		const context = ui.context;

		context.notify("child warning", "warning");
		expect(headless.notify).toHaveBeenCalledWith("child warning", "warning");
		expect(await context.confirm("trust", "project?")).toBe(false);
		expect(ui.context).toBe(context);
	});

	it("attaches a presentation target without replacing the bound context", async () => {
		const headless = makeTarget("headless");
		const attached = makeTarget("attached");
		const ui = new DelegatingExtensionUI({ headless });
		const context = ui.context;

		const detach = ui.attach(attached);
		context.notify("visible", "info");
		expect(attached.notify).toHaveBeenCalledWith("visible", "info");
		expect(ui.context).toBe(context);
		expect(await context.confirm("question", "message")).toBe(true);
		detach();
		context.notify("headless again", "info");
		expect(headless.notify).toHaveBeenCalledWith("headless again", "info");
	});

	it("forwards the remaining UI operations and read properties to the active target", async () => {
		const headless = makeTarget("headless");
		const attached = makeTarget("attached");
		const ui = new DelegatingExtensionUI({ headless });
		ui.attach(attached);
		const context: any = ui.context;

		context.select("title", ["one"]);
		context.input("title", "placeholder");
		context.onTerminalInput(() => {});
		context.setWorkingMessage("working");
		context.setWorkingVisible(true);
		context.setWorkingIndicator({ frames: ["."] });
		context.setHiddenThinkingLabel("thinking");
		context.setWidget("widget", ["line"]);
		context.setFooter(undefined);
		context.setHeader(undefined);
		context.setTitle("title");
		await context.custom(() => ({}));
		context.pasteToEditor("paste");
		context.setEditorText("text");
		context.editor("editor", "prefill");
		context.addAutocompleteProvider(() => ({}));
		context.setEditorComponent(undefined);
		context.getEditorComponent();
		context.getAllThemes();
		context.getTheme("attached-theme");
		context.setTheme("attached-theme");
		context.getToolsExpanded();
		context.setToolsExpanded(true);

		for (const method of [
			"select", "input", "onTerminalInput", "setWorkingMessage", "setWorkingVisible",
			"setWorkingIndicator", "setHiddenThinkingLabel", "setWidget", "setFooter", "setHeader",
			"setTitle", "custom", "pasteToEditor", "setEditorText", "editor",
			"addAutocompleteProvider", "setEditorComponent", "getEditorComponent", "getAllThemes",
			"getTheme", "setTheme", "getToolsExpanded", "setToolsExpanded",
		]) {
			expect((attached as any)[method]).toHaveBeenCalled();
		}
		expect(context.getEditorText()).toBe("");
		expect(context.theme).toBe(attached.theme);
	});

	it("does not let a stale detach displace a newer attachment", () => {
		const headless = makeTarget("headless");
		const first = makeTarget("first");
		const second = makeTarget("second");
		const ui = new DelegatingExtensionUI({ headless });

		const detachFirst = ui.attach(first);
		ui.attach(second);
		detachFirst();
		ui.context.notify("still second", "info");
		expect(second.notify).toHaveBeenCalledWith("still second", "info");
		expect(first.notify).not.toHaveBeenCalledWith("still second", "info");
	});

	it("reset returns an attached context to headless behavior", () => {
		const headless = makeTarget("headless");
		const attached = makeTarget("attached");
		const ui = new DelegatingExtensionUI({ headless });
		ui.attach(attached);

		ui.reset();
		ui.context.setStatus("child", "idle");
		expect(headless.setStatus).toHaveBeenCalledWith("child", "idle");
		expect(attached.setStatus).not.toHaveBeenCalledWith("child", "idle");
	});
});
