#!/usr/bin/env node
/**
 * quota-providers — exercise the quota-only extension through a real pi RPC
 * process and the executable usage runner. Local-provider cases avoid live
 * account spend; an optional Gateway probe checks llmgateway registration.
 *
 * Output: phase logs on stderr and a JSON verdict on stdout.
 */

import { spawn, spawnSync } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const PI_AI_INDEX = pathToFileURL(
	path.join(REPO_ROOT, "node_modules", "@earendil-works", "pi-ai", "dist", "index.js"),
).href;
const QUOTA_RUNNER = path.join(REPO_ROOT, "extensions", "quota-providers", "runner.mjs");

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback) => {
	const index = argv.indexOf(`--${name}`);
	return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};
const KEEP = flag("keep");
const TIMEOUT = Number(opt("timeout", "90")) * 1000;
const VERBOSE = process.env.QP_VERBOSE === "1";

function log(...parts) {
	process.stderr.write(`[quota-providers] ${parts.join(" ")}\n`);
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanEnv(extra = {}) {
	const env = { ...process.env, ...extra };
	for (const key of ["PI_PARENT_LINK", "PI_CODING_AGENT", "PI_SESSION_FILE", "PI_SESSION_ID", "PI_MODEL", "PI_PROVIDER", "PI_REASONING_LEVEL"]) {
		delete env[key];
	}
	return env;
}

function killGroup(child) {
	try {
		process.kill(-child.pid);
	} catch {}
	try {
		child.kill();
	} catch {}
}

function readJson(pathname) {
	try {
		return JSON.parse(fs.readFileSync(pathname, "utf8"));
	} catch {
		return undefined;
	}
}

function writeJson(pathname, value) {
	fs.mkdirSync(path.dirname(pathname), { recursive: true });
	fs.writeFileSync(pathname, `${JSON.stringify(value, null, 2)}\n`);
}

function attachJsonLines(stream, onObject) {
	const decoder = new StringDecoder("utf8");
	let buffer = "";
	stream.on("data", (chunk) => {
		buffer += decoder.write(chunk);
		for (;;) {
			const newline = buffer.indexOf("\n");
			if (newline < 0) break;
			let line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			if (!line) continue;
			try {
				onObject(JSON.parse(line));
			} catch {
				// pi can write diagnostic lines beside RPC JSON. Ignore those lines.
			}
		}
	});
}

function rpcSession({ cwd, agentDir, transportFile, extraArgs = [] }) {
	const child = spawn("pi", ["--mode", "rpc", "--no-session", ...extraArgs], {
		cwd,
		detached: true,
		stdio: ["pipe", "pipe", "pipe"],
		env: cleanEnv({
			PI_CODING_AGENT_DIR: agentDir,
			FAKE_TRANSPORT_OUT: transportFile,
		}),
	});
	const state = { child, events: [], stderr: "", sequence: 0 };
	attachJsonLines(child.stdout, (event) => state.events.push(event));
	child.stderr.on("data", (chunk) => {
		state.stderr += chunk.toString();
		if (VERBOSE) process.stderr.write(`[pi] ${chunk}`);
	});
	state.send = (message) => {
		if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify(message)}\n`);
	};
	state.waitFor = async (predicate, timeout = TIMEOUT) => {
		const deadline = Date.now() + timeout;
		for (;;) {
			const found = state.events.find(predicate);
			if (found) return found;
			if (Date.now() >= deadline) return undefined;
			await sleep(100);
		}
	};
	state.request = async (message, predicate = (event) => event.type === "response", timeout = 20_000) => {
		const id = `qp-${++state.sequence}`;
		state.send({ ...message, id });
		return state.waitFor((event) => event.type === "response" && event.id === id && predicate(event), timeout);
	};
	state.ready = async () => {
		// Let extension registration and the first catalog restore complete before
		// probing state. A zero-delay get_state can observe pi's placeholder
		// `unknown` model and pin that answer during startup.
		await sleep(750);
		const deadline = Date.now() + TIMEOUT;
		for (;;) {
			const response = await state.request({ type: "get_state" }, () => true, Math.min(3_000, Math.max(1, deadline - Date.now())));
			if (response?.data?.model?.id && response.data.model.id !== "unknown") return response;
			if (Date.now() >= deadline) throw new Error("pi RPC session did not resolve a model");
			await sleep(500);
		}
	};
	state.prompt = async (message, timeout = TIMEOUT) => {
		const before = state.events.length;
		const id = `qp-prompt-${++state.sequence}`;
		state.send({ type: "prompt", id, message });
		return state.waitFor(
			(event) => state.events.indexOf(event) >= before && event.type === "agent_end",
			timeout,
		);
	};
	state.command = async (message, timeout = 10_000) => {
		const before = state.events.length;
		const id = `qp-command-${++state.sequence}`;
		state.send({ type: "prompt", id, message });
		await state.waitFor((event) => {
			if (state.events.indexOf(event) < before) return false;
			return event.type === "agent_end" || (event.type === "extension_ui_request" && event.method === "notify");
		}, timeout);
		await sleep(100);
	};
	state.stop = () => killGroup(child);
	return state;
}

function modelRecord(provider, id) {
	return {
		id,
		name: id,
		provider,
		api: "openai-completions",
		baseUrl: "https://quota-provider.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8_192,
		maxTokens: 256,
	};
}

function fakeProviderExtension() {
	return `import * as fs from "node:fs";
import { AssistantMessageEventStream } from ${JSON.stringify(PI_AI_INDEX)};

const marker = (name) => {
  const file = process.env.FAKE_TRANSPORT_OUT;
  if (file) fs.appendFileSync(file, name + "\\n");
};
const baseModel = ${JSON.stringify(modelRecord("attached", "standard"))};
const makeModel = (provider, id) => ({ ...baseModel, provider, id, name: id });
function providerFor(id, markerName) {
  const models = [makeModel(id, "standard"), makeModel(id, "premium")];
  const streamSimple = (model) => {
    marker(markerName + ":" + model.id);
    const stream = new AssistantMessageEventStream();
    const output = {
      role: "assistant", content: [{ type: "text", text: "FAKE-OK" }],
      api: model.api, provider: model.provider, model: model.id,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop", timestamp: Date.now(),
    };
    queueMicrotask(() => {
      stream.push({ type: "start", partial: { ...output, content: [] } });
      stream.push({ type: "text_start", contentIndex: 0, partial: output });
      stream.push({ type: "text_delta", contentIndex: 0, delta: "FAKE-OK", partial: output });
      stream.push({ type: "text_end", contentIndex: 0, content: "FAKE-OK", partial: output });
      stream.push({ type: "done", reason: "stop", message: output });
    });
    return stream;
  };
  return {
    id, name: "Manual quota provider " + id, baseUrl: "https://quota-provider.invalid/v1",
    auth: { apiKey: { resolve: async () => ({ auth: { apiKey: "manual-secret" } }) } },
    getModels: () => models,
    streamSimple,
    stream: streamSimple,
  };
}
export default function registerManualProvider(pi) {
  pi.registerProvider(providerFor("attached", "attached"));
  pi.registerProvider(providerFor("unattached", "unattached"));
}
`;
}

function quotaSourceModule() {
	return `const now = Date.now();
export default {
  async getUsage() {
    return {
      snapshots: [{ spend: 0, quota: 100, windowStart: now - 86400000, windowEnd: now + 86400000, asOf: now }],
      modelLimitIds: { premium: ["premium-weekly"] },
    };
  },
};
`;
}

function makeAgent(root, name, options = {}) {
	const dir = path.join(root, name);
	const agentDir = path.join(dir, "agent");
	const workDir = path.join(dir, "work");
	const transportFile = path.join(dir, "transport.log");
	const provider = options.defaultProvider || "attached";
	const model = options.defaultModel || "standard";
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(workDir, { recursive: true });
	const fakeExtension = path.join(agentDir, "manual-provider.mjs");
	const source = path.join(agentDir, "quota-source.mjs");
	fs.writeFileSync(fakeExtension, fakeProviderExtension());
	fs.writeFileSync(source, quotaSourceModule());
	writeJson(path.join(agentDir, "settings.json"), {
		defaultProvider: provider,
		defaultModel: model,
		defaultThinkingLevel: "off",
		packages: [REPO_ROOT],
		extensions: [fakeExtension],
		defaultProjectTrust: "always",
	});
	writeJson(path.join(agentDir, "quota-providers.json"), {
		providers: {
			attached: {
				module: source,
				enabled: true,
				bypassAllowed: options.bypassAllowed !== false,
				enforceHardCap: options.enforceHardCap === true,
				lookaheadHours: options.lookaheadHours ?? 0,
				maxPollSeconds: 86_400,
			},
		},
	});
	const now = Date.now();
	const snapshot = options.snapshot || {
		spend: 0,
		quota: 100,
		windowStart: now - 86_400_000,
		windowEnd: now + 86_400_000,
		asOf: now,
	};
	const cacheDir = path.join(agentDir, "cache", "quota-providers", "attached");
	fs.mkdirSync(cacheDir, { recursive: true });
	writeJson(path.join(cacheDir, "usage.json"), {
		writtenAt: now,
		snapshots: [snapshot],
		modelLimitIds: options.modelLimitIds || {},
	});
	return { dir, agentDir, workDir, transportFile, cacheDir };
}

async function runLocalCase(root, name, options = {}) {
	const fixture = makeAgent(root, name, options);
	const session = rpcSession({
		cwd: fixture.workDir,
		agentDir: fixture.agentDir,
		transportFile: fixture.transportFile,
	});
	try {
		const stateResponse = await session.ready();
		const state = stateResponse?.data || {};
		if (options.command) await session.command(options.command);
		if (options.message) await session.prompt(options.message);
		const events = session.events.slice();
		return {
			fixture,
			state,
			events,
			stderr: session.stderr,
			transport: fs.existsSync(fixture.transportFile)
				? fs.readFileSync(fixture.transportFile, "utf8").trim().split("\n").filter(Boolean)
				: [],
		};
	} finally {
		session.stop();
	}
}

async function checkLocalProvider(root) {
	log("── local provider attachment and stream boundary ──");
	const now = Date.now();
	const blocked = await runLocalCase(root, "blocked", {
		enforceHardCap: true,
		snapshot: {
			spend: 10,
			quota: 10,
			windowStart: now - 86_400_000,
			windowEnd: now + 86_400_000,
			asOf: now,
		},
		message: "Reply with exactly the word OK and nothing else.",
	});
	const allowed = await runLocalCase(root, "allowed", {
		enforceHardCap: true,
		snapshot: {
			spend: 0,
			quota: 10,
			windowStart: now - 86_400_000,
			windowEnd: now + 86_400_000,
			asOf: now,
		},
		message: "Reply with exactly the word OK and nothing else.",
	});
	const unattached = await runLocalCase(root, "unattached", {
		defaultProvider: "unattached",
		defaultModel: "standard",
		message: "Reply with exactly the word OK and nothing else.",
	});
	const blockedMessage = blocked.events
		.map((event) => JSON.stringify(event))
		.filter((line) => /quota/i.test(line))
		.join(" ");
	const blockedWithoutTransport = blocked.transport.length === 0;
	const allowedTransport = allowed.transport.some((entry) => entry === "attached:standard");
	const unattachedTransport = unattached.transport.some((entry) => entry === "unattached:standard");
	return {
		checks: {
			attachedBlocksBeforeTransport: blockedWithoutTransport && /hard cap/i.test(blockedMessage),
			allowedStreamReachesTransport: allowedTransport,
			unattachedProviderUnchanged: unattachedTransport,
		},
		observed: {
			blockedTransport: blocked.transport,
			blockedQuotaEvent: blockedMessage.slice(0, 500),
			allowedTransport: allowed.transport,
			unattachedTransport: unattached.transport,
			resolvedProviders: {
				blocked: blocked.state.model?.provider,
				allowed: allowed.state.model?.provider,
				unattached: unattached.state.model?.provider,
			},
		},
	};
}

async function checkBypassAndQuotaCommand(root) {
	log("── soft-cap bypass and /quota ──");
	const now = Date.now();
	const fixture = makeAgent(root, "bypass", {
		enforceHardCap: false,
		lookaheadHours: 0,
		snapshot: {
			spend: 6,
			quota: 10,
			windowStart: now - 86_400_000,
			windowEnd: now + 86_400_000,
			asOf: now,
		},
	});
	const session = rpcSession({ cwd: fixture.workDir, agentDir: fixture.agentDir, transportFile: fixture.transportFile });
	try {
		await session.ready();
		await session.command("/quota");
		const statusEvent = session.events.find(
			(event) => event.type === "extension_ui_request" && event.method === "notify" && /quota/i.test(event.message || ""),
		);
		await session.command("/quota bypass on");
		const bypassEvent = session.events.find(
			(event) => event.type === "extension_ui_request" && event.method === "notify" && /bypass turned on/i.test(event.message || ""),
		);
		await session.prompt("Reply with exactly the word OK and nothing else.");
		const transport = fs.existsSync(fixture.transportFile)
			? fs.readFileSync(fixture.transportFile, "utf8").trim().split("\n").filter(Boolean)
			: [];
		return {
			checks: {
				quotaCommandReportsStatus: !!statusEvent,
				bypassCommandReportsChange: !!bypassEvent,
				bypassAllowsSoftCappedStream: transport.includes("attached:standard"),
			},
			observed: {
				status: statusEvent?.message,
				bypass: bypassEvent?.message,
				transport,
			},
		};
	} finally {
		session.stop();
	}
}

function checkRunner(root) {
	log("── usage runner persistence and ledger pruning ──");
	const dir = path.join(root, "runner");
	fs.mkdirSync(dir, { recursive: true });
	const source = path.join(dir, "source.mjs");
	const config = path.join(dir, "quota-providers.json");
	const cache = path.join(dir, "usage.json");
	const ledger = path.join(dir, "ledger.jsonl");
	const now = Date.now();
	fs.writeFileSync(source, `export default { getUsage: async () => ({ snapshots: [{ limitId: "monthly", label: "Monthly", spend: 3, quota: 10, windowStart: ${now - 1000}, windowEnd: ${now + 86400000}, asOf: ${now} }], modelLimitIds: { premium: ["premium-weekly"] } }) };\n`);
	writeJson(config, { providers: { attached: { module: source, billingCycleAnchor: "2026-01-01T00:00:00.000Z", lookaheadHours: 0 } } });
	fs.writeFileSync(ledger, [
		JSON.stringify({ timestamp: now - 1, cost: 7, quotaLimitIds: ["monthly"] }),
		JSON.stringify({ timestamp: now + 100_000, cost: 1, quotaLimitIds: ["monthly"] }),
	].join("\n") + "\n");
	const result = spawnSync(process.execPath, [
		QUOTA_RUNNER,
		"usage",
		"--module", source,
		"--impl", "attached",
		"--config", config,
		"--cache", cache,
		"--ledger", ledger,
		"--max-poll-seconds", "0",
	], { cwd: REPO_ROOT, encoding: "utf8", env: cleanEnv() });
	const record = readJson(cache);
	const ledgerLines = fs.existsSync(ledger)
		? fs.readFileSync(ledger, "utf8").split("\n").filter(Boolean)
		: [];
	const entries = ledgerLines.map((line) => {
		try { return JSON.parse(line); } catch { return undefined; }
	}).filter(Boolean);
	return {
		checks: {
			runnerExitsSuccessfully: result.status === 0,
			cacheStoresSnapshotsAndMembership: !!record && Array.isArray(record.snapshots) && !!record.modelLimitIds?.premium,
			coveredLedgerEntriesPruned: entries.length === 1 && entries[0].timestamp > now,
		},
		observed: {
			exit: result.status,
			stderr: result.stderr?.trim(),
			cache: record,
			ledger: entries,
		},
	};
}

async function checkGateway(root) {
	log("── llmgateway provider registration ──");
	if (!process.env.LLMGATEWAY_API_KEY) {
		return {
			checks: { gatewayProbeRunnable: false },
			observed: { skipped: "LLMGATEWAY_API_KEY is unset" },
			limitation: "Gateway catalog and model resolution were not exercised without LLMGATEWAY_API_KEY.",
		};
	}
	const dir = path.join(root, "gateway");
	const agentDir = path.join(dir, "agent");
	const workDir = path.join(dir, "work");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(workDir, { recursive: true });
	writeJson(path.join(agentDir, "settings.json"), {
		defaultProvider: "llmgateway",
		defaultModel: process.env.QP_GATEWAY_MODEL || "gpt-5.4-nano",
		defaultThinkingLevel: "off",
		packages: [REPO_ROOT],
		defaultProjectTrust: "always",
	});
	const session = rpcSession({ cwd: workDir, agentDir, transportFile: path.join(dir, "unused.log") });
	try {
		// Wait for the provider refresh to publish its persisted catalog before
		// selecting the default model. A get_state during the initial `unknown`
		// placeholder does not retry model selection when the catalog completes.
		const modelsStorePath = path.join(agentDir, "models-store.json");
		const catalogDeadline = Date.now() + TIMEOUT;
		while (Date.now() < catalogDeadline) {
			const store = readJson(modelsStorePath);
			if (Array.isArray(store?.llmgateway?.models) && store.llmgateway.models.length > 0) break;
			await sleep(250);
		}
		await sleep(100);
		const requestedModel = process.env.QP_GATEWAY_MODEL || "gpt-5.4-nano";
		session.send({ type: "set_model", id: "gateway-select", provider: "llmgateway", modelId: requestedModel });
		const selectResponse = await session.waitFor(
			(event) => event.type === "response" && event.id === "gateway-select",
			20_000,
		);
		session.send({ type: "get_state", id: "gateway-state" });
		const stateResponse = await session.waitFor(
			(event) => event.type === "response" && event.id === "gateway-state",
			TIMEOUT,
		);
		const state = stateResponse?.data || {};
		const provider = state.model?.provider;
		const model = state.model?.id;
		return {
			checks: {
				gatewaySelectsCatalogModel: selectResponse?.success === true,
				gatewayResolvesProvider: provider === "llmgateway",
				gatewayResolvesModel: typeof model === "string" && model !== "unknown",
			},
			observed: { selected: selectResponse?.success, provider, model, stderr: session.stderr.slice(-500) },
		};
	} catch (error) {
		return {
			checks: { gatewaySelectsCatalogModel: false, gatewayResolvesProvider: false, gatewayResolvesModel: false },
			observed: { error: String(error), stderr: session.stderr.slice(-1000), events: session.events.slice(-5) },
			limitation: "The configured Gateway model/catalog did not resolve in the live environment.",
		};
	} finally {
		session.stop();
	}
}

async function main() {
	const root = opt("workdir", null) || fs.mkdtempSync(path.join(os.tmpdir(), "quota-manual-"));
	fs.mkdirSync(root, { recursive: true });
	log("workdir:", root);
	const checks = {};
	const observed = {};
	const limitations = [];
	try {
		const local = await checkLocalProvider(root);
		Object.assign(checks, local.checks);
		observed.local = local.observed;
		const bypass = await checkBypassAndQuotaCommand(root);
		Object.assign(checks, bypass.checks);
		observed.bypass = bypass.observed;
		const runner = checkRunner(root);
		Object.assign(checks, runner.checks);
		observed.runner = runner.observed;
		const gateway = await checkGateway(root);
		Object.assign(checks, gateway.checks);
		observed.gateway = gateway.observed;
		if (gateway.limitation) limitations.push(gateway.limitation);
	} catch (error) {
		checks.error = false;
		observed.error = error instanceof Error && error.stack ? error.stack : String(error);
	}
	if (!KEEP && !opt("workdir", null)) {
		try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
	}
	const pass = !Object.entries(checks).some(([key, value]) => key === "error" || value !== true);
	process.stdout.write(`${JSON.stringify({ verdict: pass ? "PASS" : "FAIL", checks, observed, limitations }, null, 2)}\n`);
	process.exit(pass ? 0 : 1);
}

main();
