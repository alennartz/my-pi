#!/usr/bin/env node
/**
 * model-tiers — drive a real `pi --mode rpc` to verify the subagents
 * extension's model-tier feature end-to-end (the live wiring in index.ts that
 * the pure-function unit tests in model-tiers.test.ts cannot reach).
 *
 * Every check runs a fresh top-level pi under a controlled PI_CODING_AGENT_DIR
 * (a temp agent dir with its own settings.json that loads this repo as a
 * package plus a `before_provider_request` probe extension). The probe writes
 * the assembled provider payload to a file so the harness can inspect the
 * exact system prompt the model received.
 *
 * Checks:
 *   A. injection-unconfigured — no config: system prompt has `## Model Tiers`
 *      with all four tiers showing the session-default model + `(default)`,
 *      and NO `## Available Models` block.
 *   B. injection-overlay — global {cheap,medium} + project {cheap}: the tier
 *      table shows project's cheap (override wins), global's medium (survives),
 *      and default rows for smart/frontier.
 *   C. untrusted-project — project config present but project untrusted: the
 *      project cheap override is ignored; cheap falls back to the global value.
 *   D. spawn-configured — tier `cheap` mapped to a real non-default model:
 *      spawning a subagent with model:"cheap" runs that model (read from the
 *      child's persisted session file), no unconfigured notice fires, and a
 *      raw model-id spawn resolves to that raw model.
 *   E. spawn-unconfigured — no config: spawning model:"cheap" runs the session
 *      default model AND the once-per-session "unconfigured" notice fires.
 *   F. list_models — the tool returns a catalog table with context-window and
 *      pricing columns.
 *
 * CRITICAL: spawned pi processes must NOT inherit PI_PARENT_LINK / PI_CODING_
 * AGENT, or they act as sub-agents and skip normal top-level behavior. Scrubbed.
 *
 * Inputs (flags): --keep (don't delete workdir), --timeout <sec> (per phase,
 * default 180), --workdir <dir>.
 * Output: human phase log on stderr; JSON verdict on stdout
 *   { verdict, checks: {A..F: bool|detail}, observed }. Exit 0 = PASS, 1 = FAIL.
 *
 * Prerequisites: `pi` on PATH; ambient provider credentials in env (this repo's
 * azure-foundry config). No API keys are handled here.
 */

import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

// ─── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => {
	const i = argv.indexOf(`--${n}`);
	return i !== -1 && argv[i + 1] ? argv[i + 1] : d;
};
const KEEP = flag("keep");
const TIMEOUT = Number(opt("timeout", "180")) * 1000;
const DEFAULT_MODEL = "claude-opus-4-8";
const PROVIDER = "azure-foundry-anthropic-messages";

function log(...a) {
	process.stderr.write("[model-tiers] " + a.join(" ") + "\n");
}

function cleanEnv(extra) {
	const env = { ...process.env, ...extra };
	delete env.PI_PARENT_LINK;
	delete env.PI_CODING_AGENT;
	return env;
}

// JSONL-framed RPC reader (LF only, strip trailing CR).
function attach(stream, onObj) {
	const dec = new StringDecoder("utf8");
	let buf = "";
	stream.on("data", (c) => {
		buf += dec.write(c);
		let i;
		while ((i = buf.indexOf("\n")) !== -1) {
			let line = buf.slice(0, i);
			buf = buf.slice(i + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			if (!line) continue;
			let obj;
			try {
				obj = JSON.parse(line);
			} catch {
				continue;
			}
			onObj(obj);
		}
	});
}

function killGroup(proc) {
	try {
		process.kill(-proc.pid);
	} catch {}
	try {
		proc.kill();
	} catch {}
}

// ─── temp agent dir scaffolding ──────────────────────────────────────────────
const PROBE_EXT = `import * as fs from "node:fs";
export default function(pi) {
  pi.on("before_provider_request", (event) => {
    const out = process.env.PROBE_OUT;
    try { if (out) fs.writeFileSync(out, JSON.stringify(event.payload)); } catch {}
    return undefined;
  });
}
`;

/**
 * Build a temp agent dir with settings.json + probe extension.
 * tiers: {global?: object, project?: object} written as model-tiers.json files.
 * trust: "always" | "never" (defaultProjectTrust).
 */
function makeAgentDir(root, name, { global, project, trust = "always" }) {
	const agentDir = path.join(root, name, "agent");
	const workDir = path.join(root, name, "work");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(workDir, { recursive: true });
	const probePath = path.join(agentDir, "probe-ext.mjs");
	fs.writeFileSync(probePath, PROBE_EXT);
	fs.writeFileSync(
		path.join(agentDir, "settings.json"),
		JSON.stringify(
			{
				defaultProvider: PROVIDER,
				defaultModel: DEFAULT_MODEL,
				defaultThinkingLevel: "medium",
				packages: [REPO_ROOT],
				extensions: [probePath],
				defaultProjectTrust: trust,
			},
			null,
			2,
		),
	);
	if (global) fs.writeFileSync(path.join(agentDir, "model-tiers.json"), JSON.stringify(global));
	if (project) {
		fs.mkdirSync(path.join(workDir, ".pi"), { recursive: true });
		fs.writeFileSync(path.join(workDir, ".pi", "model-tiers.json"), JSON.stringify(project));
	}
	return { agentDir, workDir };
}

// ─── persistence path derivation (mirror persistence.ts) ─────────────────────
function persistencePaths(parentSessionFile) {
	const dir = path.dirname(parentSessionFile);
	const base = path.basename(parentSessionFile, path.extname(parentSessionFile));
	const rootDir = path.join(dir, `${base}.subagents`);
	return { logFile: path.join(rootDir, "agents.jsonl"), sessionsDir: path.join(rootDir, "sessions") };
}

function liveAgents(logFile) {
	if (!fs.existsSync(logFile)) return [];
	const live = new Map();
	for (const raw of fs.readFileSync(logFile, "utf8").split("\n")) {
		const l = raw.trim();
		if (!l) continue;
		let e;
		try {
			e = JSON.parse(l);
		} catch {
			continue;
		}
		if (e.type === "agent_added") live.set(e.id, e);
		else if (e.type === "agent_removed") live.delete(e.id);
	}
	return [...live.values()];
}

// Read the model id recorded in a child session file (first assistant msg or
// model_change entry).
function sessionModel(sessionFile) {
	let contents;
	try {
		contents = fs.readFileSync(sessionFile, "utf8");
	} catch {
		return undefined;
	}
	let model;
	for (const raw of contents.split("\n")) {
		const l = raw.trim();
		if (!l) continue;
		let e;
		try {
			e = JSON.parse(l);
		} catch {
			continue;
		}
		if (e.type === "model_change" && typeof e.modelId === "string") model = e.modelId;
		if (e.type === "message" && e.message?.role === "assistant" && typeof e.message.model === "string") {
			return e.message.model; // assistant-recorded model is authoritative
		}
	}
	return model;
}

// ─── probe capture: launch pi, send a trivial prompt, read assembled payload ─
function capturePrompt(agentDir, workDir) {
	return new Promise((resolve, reject) => {
		const out = path.join(agentDir, "payload.json");
		try {
			fs.unlinkSync(out);
		} catch {}
		const proc = spawn("pi", ["--mode", "rpc", "--no-session"], {
			cwd: workDir,
			stdio: ["pipe", "pipe", "pipe"],
			env: cleanEnv({ PI_CODING_AGENT_DIR: agentDir, PROBE_OUT: out }),
		});
		let settled = false;
		const to = setTimeout(() => {
			if (!settled) {
				killGroup(proc);
				reject(new Error("capture timed out"));
			}
		}, TIMEOUT);
		const send = (o) => proc.stdin.write(JSON.stringify(o) + "\n");
		attach(proc.stdout, () => {});
		proc.stderr.on("data", (d) => process.env.MT_VERBOSE && process.stderr.write("[pi] " + d));
		proc.on("spawn", () => setTimeout(() => send({ type: "prompt", id: "p", message: "hi" }), 1000));
		const poll = setInterval(() => {
			if (fs.existsSync(out)) {
				settled = true;
				clearInterval(poll);
				clearTimeout(to);
				const payload = JSON.parse(fs.readFileSync(out, "utf8"));
				killGroup(proc);
				const sys = typeof payload.system === "string" ? payload.system : JSON.stringify(payload.system);
				setTimeout(() => resolve(sys), 200);
			}
		}, 400);
	});
}

// ─── spawn driver: drive the agent to call subagent (+ optional list_models) ─
// Returns { notices: string[], childModels: {id: model}, listModelsText }.
function driveSpawn(agentDir, workDir, sessionDir, { spawns, wantListModels }) {
	return new Promise((resolve, reject) => {
		const proc = spawn("pi", ["--mode", "rpc", "--session-dir", sessionDir], {
			cwd: workDir,
			stdio: ["pipe", "pipe", "pipe"],
			env: cleanEnv({ PI_CODING_AGENT_DIR: agentDir }),
		});
		let parentSessionFile;
		let settled = false;
		const notices = [];
		let listModelsText;
		const spawnedIds = new Set();
		const to = setTimeout(() => {
			if (!settled) {
				killGroup(proc);
				reject(new Error("spawn drive timed out"));
			}
		}, TIMEOUT);
		const send = (o) => proc.stdin.write(JSON.stringify(o) + "\n");

		const spawnLines = spawns
			.map(
				(s, i) =>
					`${i + 1}. Call the subagent tool with agents set to a single-element list: id '${s.id}', model '${s.model}', task 'Reply with exactly the word ACK and nothing else, then stop.'`,
			)
			.join(" ");
		const listLine = wantListModels ? " After the spawns, call the list_models tool once." : "";
		const prompt =
			`Do exactly the following tool calls, in order, and nothing else. ${spawnLines}${listLine} ` +
			"Do not call await_agents. Do not narrate. After the last tool call, end your turn.";

		const finishIfReady = () => {
			const spawnsDone = spawns.every((s) => spawnedIds.has(s.id));
			const listDone = !wantListModels || listModelsText !== undefined;
			if (spawnsDone && listDone && !settled) {
				settled = true;
				clearTimeout(to);
				// give children a beat to write their first assistant turn
				setTimeout(() => {
					const childModels = {};
					if (parentSessionFile) {
						const { logFile } = persistencePaths(parentSessionFile);
						for (const a of liveAgents(logFile)) {
							childModels[a.id] = sessionModel(a.sessionFile);
						}
					}
					killGroup(proc);
					resolve({ notices, childModels, listModelsText, parentSessionFile });
				}, 2500);
			}
		};

		attach(proc.stdout, (p) => {
			if (p.type === "response" && p.command === "get_state") {
				parentSessionFile = p.data.sessionFile;
				send({ type: "prompt", id: "drive", message: prompt });
			}
			if (p.type === "extension_ui_request" && p.method === "notify") {
				notices.push(p.message);
			}
			if (p.type === "tool_execution_end" && p.toolName === "subagent") {
				for (const s of spawns) spawnedIds.add(s.id); // spawn call returned
			}
			if (p.type === "tool_execution_end" && p.toolName === "list_models") {
				listModelsText = (p.result?.content || []).map((c) => c.text).join("\n");
			}
			if (p.type === "agent_end") finishIfReady();
			if (process.env.MT_VERBOSE && p.type === "tool_execution_end") {
				log("tool_end", p.toolName);
			}
		});
		proc.stderr.on("data", (d) => process.env.MT_VERBOSE && process.stderr.write("[pi] " + d));
		proc.on("spawn", () => setTimeout(() => send({ type: "get_state", id: "s" }), 1200));
	});
}

// Poll child sessions for a recorded model, retrying briefly if not yet written.
function readChildModels(parentSessionFile, ids, tries = 6) {
	return new Promise((resolve) => {
		let n = 0;
		const iv = setInterval(() => {
			n += 1;
			const { logFile } = persistencePaths(parentSessionFile);
			const agents = liveAgents(logFile);
			const models = {};
			for (const id of ids) {
				const a = agents.find((x) => x.id === id);
				models[id] = a ? sessionModel(a.sessionFile) : undefined;
			}
			if (ids.every((id) => models[id]) || n >= tries) {
				clearInterval(iv);
				resolve(models);
			}
		}, 1500);
	});
}

// ─── checks ──────────────────────────────────────────────────────────────────
function tierRow(sys, tier) {
	const re = new RegExp(`\\| ${tier} \\| ([^|]+) \\|`);
	const m = sys.match(re);
	return m ? m[1].trim() : undefined;
}

async function main() {
	const ROOT = opt("workdir", null) || fs.mkdtempSync(path.join(os.tmpdir(), "mt-"));
	fs.mkdirSync(ROOT, { recursive: true });
	log("workdir:", ROOT);
	const checks = {};
	const observed = {};
	try {
		// A. injection-unconfigured
		log("── A: injection-unconfigured ──");
		{
			const { agentDir, workDir } = makeAgentDir(ROOT, "A", {});
			const sys = await capturePrompt(agentDir, workDir);
			const hasTiers = sys.includes("## Model Tiers");
			const noAvail = !sys.includes("## Available Models");
			const rows = ["cheap", "medium", "smart", "frontier"].map((t) => tierRow(sys, t));
			const allDefault = rows.every((r) => r && r.includes(DEFAULT_MODEL) && r.includes("(default)"));
			observed.A = { rows };
			checks.A = hasTiers && noAvail && allDefault;
		}

		// B. injection-overlay
		log("── B: injection-overlay ──");
		{
			const { agentDir, workDir } = makeAgentDir(ROOT, "B", {
				global: { cheap: "gpt-5.4-nano", medium: "genitsec-haiku-4-5" },
				project: { cheap: "gpt-5.4-mini" },
			});
			const sys = await capturePrompt(agentDir, workDir);
			const cheap = tierRow(sys, "cheap");
			const medium = tierRow(sys, "medium");
			const smart = tierRow(sys, "smart");
			observed.B = { cheap, medium, smart };
			checks.B =
				!!cheap &&
				cheap.includes("gpt-5.4-mini") && // project override wins
				!!medium &&
				medium.includes("genitsec-haiku-4-5") && // global survives
				!!smart &&
				smart.includes("(default)"); // unconfigured tier defaults
		}

		// C. untrusted-project gating
		log("── C: untrusted-project ──");
		{
			const { agentDir, workDir } = makeAgentDir(ROOT, "C", {
				global: { cheap: "gpt-5.4-nano" },
				project: { cheap: "gpt-5.4-mini" },
				trust: "never",
			});
			const sys = await capturePrompt(agentDir, workDir);
			const cheap = tierRow(sys, "cheap");
			observed.C = { cheap };
			// project override must be ignored -> global value shown, not project's
			checks.C = !!cheap && cheap.includes("gpt-5.4-nano") && !cheap.includes("gpt-5.4-mini");
		}

		// D. spawn-configured + raw-id passthrough
		log("── D: spawn-configured ──");
		{
			const { agentDir, workDir } = makeAgentDir(ROOT, "D", {
				global: { cheap: "gpt-5.4-nano" },
			});
			const sessionDir = path.join(ROOT, "D", "sessions");
			fs.mkdirSync(sessionDir, { recursive: true });
			const res = await driveSpawn(agentDir, workDir, sessionDir, {
				spawns: [
					{ id: "tier", model: "cheap" },
					{ id: "raw", model: "gpt-5.4-mini" },
				],
				wantListModels: true,
			});
			const models = await readChildModels(res.parentSessionFile, ["tier", "raw"]);
			observed.D = { models, notices: res.notices, listModelsPresent: !!res.listModelsText };
			const noUnconfigured = !res.notices.some((n) => /unconfigured/i.test(n));
			checks.D_tierResolved = !!models.tier && models.tier.includes("gpt-5.4-nano");
			checks.D_rawResolved = !!models.raw && models.raw.includes("gpt-5.4-mini");
			checks.D_noUnconfiguredNotice = noUnconfigured;
			// F. list_models (folded into D's session)
			const t = res.listModelsText || "";
			observed.F = { sample: t.slice(0, 400) };
			checks.F =
				/context/i.test(t) &&
				/(input|\$\/Mtok|cost|pricing)/i.test(t) &&
				/\|/.test(t); // table formatting
		}

		// E. spawn-unconfigured -> session default + unconfigured notice
		log("── E: spawn-unconfigured ──");
		{
			const { agentDir, workDir } = makeAgentDir(ROOT, "E", {});
			const sessionDir = path.join(ROOT, "E", "sessions");
			fs.mkdirSync(sessionDir, { recursive: true });
			const res = await driveSpawn(agentDir, workDir, sessionDir, {
				spawns: [{ id: "tier", model: "cheap" }],
				wantListModels: false,
			});
			const models = await readChildModels(res.parentSessionFile, ["tier"]);
			observed.E = { models, notices: res.notices };
			checks.E_defaultModel = !!models.tier && models.tier.includes(DEFAULT_MODEL);
			checks.E_unconfiguredNotice = res.notices.some((n) => /unconfigured/i.test(n));
		}
	} catch (e) {
		checks.error = String(e && e.stack ? e.stack : e);
	} finally {
		if (!KEEP && !opt("workdir", null)) {
			try {
				fs.rmSync(ROOT, { recursive: true, force: true });
			} catch {}
		}
	}

	const pass =
		!checks.error &&
		Object.entries(checks).every(([k, v]) => k === "error" || v === true);
	process.stdout.write(JSON.stringify({ verdict: pass ? "PASS" : "FAIL", checks, observed }, null, 2) + "\n");
	process.exit(pass ? 0 : 1);
}

main();
