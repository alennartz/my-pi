#!/usr/bin/env node
/**
 * persona-workspaces — drive real `pi` processes to verify persona takeover
 * end-to-end (the live wiring in extensions/persona-workspaces/index.ts and
 * the subagents spawn path that pure-function unit tests cannot reach).
 *
 * Every check runs a real top-level pi under a controlled PI_CODING_AGENT_DIR
 * (a temp agent dir whose settings.json loads this repo as a package plus a
 * `before_provider_request` probe extension). The probe appends each assembled
 * provider payload to a NDJSON file so the harness can inspect the exact
 * system prompt, tool list, and model every request ran with. Notices and
 * binding state are read from session JSONL, the subagents persistence files,
 * and RPC `get_state`/`get_commands` — never from model narration.
 *
 * Root checks (fresh `pi --mode rpc` sessions; R5/R6 use two):
 *   R1 boot-takeover     — `kind: persona` AGENTS.md: body replaces the
 *                          preamble (generic preamble gone, body exactly
 *                          once — the file is not double-appended as
 *                          context), one boot notice naming persona +
 *                          absolute source path, front-matter model (with
 *                          `:<level>` thinking suffix), tools (exactly
 *                          resolveChildToolPolicy normalization), skills
 *                          filter, and unlisted skills' slash commands still
 *                          loaded (the documented root limitation).
 *   R2 explicit-prompt   — `--system-prompt` outranks the ambient persona:
 *                          nothing binds, nothing announces, AGENTS.md stays
 *                          ordinary project context.
 *   R3 plain-agents      — a plain AGENTS.md never takes over: generic
 *                          preamble intact, content rides as project context,
 *                          no notice.
 *   R4 unknown-kind      — `kind:` other than `persona` is silently ignored.
 *   R5 mid-session-edit  — editing the workspace body takes effect on the
 *                          next run of the same session; the notice is not
 *                          re-emitted.
 *   R6 resume-rebinds     — persona-authoritative at session boundaries: a
 *                          resume whose AGENTS.md model/tools were edited
 *                          meanwhile re-applies the edited declaration —
 *                          model (with `:<level>` thinking) and tools — over
 *                          the user's in-session `set_model` +
 *                          `set_thinking_level` (the `/model` API) choices,
 *                          which stand only until the session is next
 *                          opened; the edited body still binds and nothing
 *                          announces.
 *   R7 reload-rebinds     — an extension-command-triggered reload (the
 *                          probe's pw-reload calls ctx.reload(), the same
 *                          session.reload() the builtin /reload runs) is
 *                          dispatched as a `reload` session start — a
 *                          continuation boundary, the same thing as a
 *                          resume: the edited declaration re-applies in
 *                          full (model with `:<level>` thinking + tools
 *                          whitelist) over the user's mid-session choices,
 *                          the edited body still binds per-run, no second
 *                          notice.
 *
 * Drive checks (LLM-driven parent sessions spawning real children):
 *   D1 spawned-identity  — a spawned persona's body IS the child's preamble
 *                          (generic preamble gone, body once — not stacked in
 *                          the addendum) with a name-only boot notice; a
 *                          persona without a `model` lets an explicit spawn
 *                          `model` gap-fill; a child spawned into an
 *                          arbitrary folder loads that folder's project
 *                          resources (project skill, plain AGENTS.md as
 *                          context, project `.pi/extensions`); messaging
 *                          (expect-response and fire-and-forget) works.
 *   D2 override+resurrect — a named persona spawned into a persona workspace
 *                          loses wholesale to the workspace (body + pin),
 *                          the override notice names both; after teardown the
 *                          workspace file is edited and the resurrected child
 *                          re-resolves its tool policy from the edited file
 *                          while its persisted model survives; a fork child
 *                          wears the inherited workspace persona; a bogus
 *                          resurrect errors cleanly.
 *
 * CRITICAL: spawned pi processes must NOT inherit PI_PARENT_LINK / PI_CODING_
 * AGENT / PI_SESSION_*, or they act as sub-agents of this harness's own
 * session and skip top-level behavior. Scrubbed.
 *
 * Inputs (flags): --keep (don't delete workdir), --timeout <sec> (per phase,
 * default 300), --workdir <dir>, --only <ids> (comma list, e.g. R1,D2).
 * Env overrides: PW_PROVIDER, PW_MODEL (session default), PW_PIN_A +
 * PW_PIN_A_LEVEL (R1/R6 pin), PW_PIN_B (workspace W2 pin), PW_PIN_C (spawned
 * persona pin + R6 user choice), PW_RAW (explicit spawn model), PW_THINK
 * (R6 user thinking level), PW_THINK2 (R6 rebound thinking level).
 * Output: human phase log on stderr; JSON verdict on stdout
 *   { verdict, checks, observed }. Exit 0 = PASS, 1 = FAIL.
 *
 * Prerequisites: `pi` on PATH with this repo loadable as a package;
 * LLMGATEWAY_API_KEY in env (the devpass quota-provider implementation is
 * registered in the temp agent dir and discovers models at startup). The
 * temp quota config relaxes `lookaheadHours` so the quota soft-cap
 * backpressure cannot block these checks' provider calls (the account's real
 * spend pace is ahead of budget; quota behavior is out of scope here).
 */

import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

// ─── args / config ───────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => {
	const i = argv.indexOf(`--${n}`);
	return i !== -1 && argv[i + 1] ? argv[i + 1] : d;
};
const KEEP = flag("keep");
const TIMEOUT = Number(opt("timeout", "300")) * 1000;
const ONLY = opt("only", "")
	.split(",")
	.map((s) => s.trim())
	.filter(Boolean);

const CFG = {
	provider: process.env.PW_PROVIDER || "devpass-openai-completions",
	model: process.env.PW_MODEL || "mimo-v2.6-pro",
	pinA: process.env.PW_PIN_A || "gpt-6-luna",
	pinALevel: process.env.PW_PIN_A_LEVEL || "low",
	pinB: process.env.PW_PIN_B || "gpt-6.1-sol",
	pinC: process.env.PW_PIN_C || "claude-haiku-5-5",
	raw: process.env.PW_RAW || "gpt-6-luna",
	think: process.env.PW_THINK || "medium",
	think2: process.env.PW_THINK2 || "high",
};

const GENERIC_PREAMBLE = "You are an expert coding assistant operating inside pi";
const CHILD_IDENTITY = "<subagent_identity>";

function log(...a) {
	process.stderr.write("[persona-workspaces] " + a.join(" ") + "\n");
}

const checks = {};
const observed = {};
function check(id, ok, detail) {
	checks[id] = !!ok;
	if (detail !== undefined) observed[id] = detail;
	log(ok ? "PASS" : "FAIL", id, detail !== undefined ? JSON.stringify(detail).slice(0, 160) : "");
}
function wanted(id) {
	return ONLY.length === 0 || ONLY.includes(id);
}

// ─── process plumbing ────────────────────────────────────────────────────────
function cleanEnv(extra) {
	const env = { ...process.env, ...extra };
	delete env.PI_PARENT_LINK;
	delete env.PI_CODING_AGENT;
	delete env.PI_SESSION_FILE;
	delete env.PI_SESSION_ID;
	return env;
}

// JSONL-framed reader (LF only, strip trailing CR).
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

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(pred, ms, every = 300) {
	const deadline = Date.now() + ms;
	for (;;) {
		const v = await pred();
		if (v) return v;
		if (Date.now() > deadline) return undefined;
		await sleep(every);
	}
}

/**
 * A `pi --mode rpc` session. Commands are JSON lines on stdin; every stdout
 * object is retained in `events` for predicate scans.
 */
function rpcSession({ cwd, agentDir, extraArgs = [], probeOut }) {
	const proc = spawn("pi", ["--mode", "rpc", ...extraArgs], {
		cwd,
		detached: true,
		stdio: ["pipe", "pipe", "pipe"],
		env: cleanEnv({ PI_CODING_AGENT_DIR: agentDir, PROBE_OUT: probeOut }),
	});
	const events = [];
	let stderr = "";
	const s = { proc, events, id: 0 };
	s.send = (o) => proc.stdin.write(JSON.stringify(o) + "\n");
	attach(proc.stdout, (o) => events.push(o));
	proc.stderr.on("data", (d) => {
		stderr += d;
		if (process.env.PW_VERBOSE) process.stderr.write("[pi] " + d);
	});
	s.stderr = () => stderr;
	s.waitEvent = (pred, ms = TIMEOUT) =>
		waitFor(() => events.find((e) => pred(e)) || undefined, ms, 200);
	s.request = async (cmd, pred, ms = 20000) => {
		const id = `r${++s.id}`;
		s.send({ ...cmd, id });
		return s.waitEvent((e) => e.type === "response" && e.id === id && pred(e), ms);
	};
	// Retry idempotent commands until the process is up AND the model registry
	// has resolved the session model (an unresolved registry reports id
	// "unknown" — prompts sent then hang and declared pins cannot bind).
	s.ready = async (cmd = { type: "get_state" }, ms = 90000) => {
		const id = `init`;
		const deadline = Date.now() + ms;
		for (;;) {
			s.send({ ...cmd, id });
			const resp = await s.waitEvent(
				(e) => e.type === "response" && e.id === id,
				Math.min(2500, deadline - Date.now() || 0),
			);
			if (resp && resp.data?.model?.id && resp.data.model.id !== "unknown") return resp;
			if (Date.now() > deadline) throw new Error("rpc session did not become ready (model never resolved)");
		}
	};
	s.prompt = async (message) => {
		const before = events.length;
		const id = `p${++s.id}`;
		s.send({ type: "prompt", id, message });
		return s.waitEvent(
			(e) => events.indexOf(e) >= before && e.type === "agent_end",
			TIMEOUT * 1.5,
		);
	};
	s.toolResults = (name) =>
		events.filter((e) => e.type === "tool_execution_end" && e.toolName === name);
	s.kill = () => killGroup(proc);
	return s;
}

// ─── probe / session / persistence oracles ───────────────────────────────────
function readNdjson(file) {
	try {
		return fs
			.readFileSync(file, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((l) => {
				try {
					return JSON.parse(l);
				} catch {
					return null;
				}
			})
			.filter(Boolean);
	} catch {
		return [];
	}
}

/** The assembled system prompt of a captured provider payload. */
function systemOf(p) {
	if (typeof p.system === "string") return p.system;
	return (p.messages || [])
		.filter((m) => m.role === "system" || m.role === "developer")
		.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
		.join("\n");
}
function toolsOf(p) {
	return (p.tools || [])
		.map((t) => t.name || (t.function && t.function.name))
		.filter(Boolean)
		.sort();
}
function payloads(probeOut) {
	return readNdjson(probeOut).map((p) => ({ raw: p, sys: systemOf(p), tools: toolsOf(p) }));
}
const count = (s, needle) => s.split(needle).length - 1;

function sessionEntries(sessionFile) {
	return readNdjson(sessionFile);
}
function noticesIn(entries) {
	return entries.filter((e) => e.type === "custom_message" && e.customType === "persona-notice");
}
function assistantTexts(entries) {
	return entries
		.filter((e) => e.type === "message" && e.message?.role === "assistant")
		.map((e) =>
			(e.message.content || [])
				.filter((c) => c.type === "text")
				.map((c) => c.text)
				.join(""),
		);
}
function assistantModels(entries) {
	return entries
		.filter((e) => e.type === "message" && e.message?.role === "assistant")
		.map((e) => e.message.model);
}

// Subagents persistence (mirror persistence.ts path derivation).
function persistencePaths(parentSessionFile) {
	const dir = path.dirname(parentSessionFile);
	const base = path.basename(parentSessionFile, path.extname(parentSessionFile));
	const rootDir = path.join(dir, `${base}.subagents`);
	return { logFile: path.join(rootDir, "agents.jsonl"), sessionsDir: path.join(rootDir, "sessions") };
}
function agentRecords(logFile) {
	const all = new Map();
	for (const e of readNdjson(logFile)) {
		if (e.type === "agent_added") all.set(e.id, e);
	}
	return all;
}

// ─── temp agent dir scaffolding ──────────────────────────────────────────────
const PROBE_EXT = `import * as fs from "node:fs";
export default function(pi) {
  // Manual-test hook: pi's builtin /reload is dispatched by the TUI input
  // pipeline only, but prompt("/name") dispatches EXTENSION commands with a
  // command ctx — whose reload() is the same session.reload() the builtin uses.
  pi.registerCommand("pw-reload", {
    description: "manual-test hook: reload extensions via ctx.reload()",
    handler: async (_args, ctx) => { await ctx.reload(); },
  });
  pi.on("session_start", (event) => {
    const out = process.env.PROBE_OUT;
    try { if (out) fs.appendFileSync(out + ".reasons", JSON.stringify({ at: Date.now(), reason: event.reason }) + "\\n"); } catch {}
    return undefined;
  });
  pi.on("before_provider_request", (event) => {
    const out = process.env.PROBE_OUT;
    try { if (out) fs.appendFileSync(out, JSON.stringify(event.payload) + "\\n"); } catch {}
    return undefined;
  });
}
`;

function personaFile({ name, description = "test persona", tools, model, skills, body }) {
	const fm = [
		"---",
		"kind: persona",
		`name: ${name}`,
		`description: ${description}`,
		...(tools ? [`tools: ${tools}`] : []),
		...(model ? [`model: ${model}`] : []),
		...(skills ? [`skills: ${skills}`] : []),
		"---",
		"",
	].join("\n");
	return fm + body + "\n";
}
function agentsFile({ name, description = "discovered persona", tools, model, body }) {
	const fm = [
		"---",
		`name: ${name}`,
		`description: ${description}`,
		...(tools ? [`tools: ${tools}`] : []),
		...(model ? [`model: ${model}`] : []),
		"---",
		"",
	].join("\n");
	return fm + body + "\n";
}

function makeAgentDir(root) {
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(path.join(agentDir, "agents"), { recursive: true });
	fs.writeFileSync(path.join(agentDir, "probe-ext.mjs"), PROBE_EXT);
	fs.writeFileSync(
		path.join(agentDir, "settings.json"),
		JSON.stringify(
			{
				defaultProvider: CFG.provider,
				defaultModel: CFG.model,
				defaultThinkingLevel: "medium",
				packages: [REPO_ROOT],
				extensions: [path.join(agentDir, "probe-ext.mjs")],
				defaultProjectTrust: "always",
			},
			null,
			2,
		),
	);
	fs.writeFileSync(
		path.join(agentDir, "quota-providers.json"),
		JSON.stringify({
			providers: {
				devpass: {
					module: path.join(REPO_ROOT, "extensions/quota-providers/impls/devpass.ts"),
					enabled: true,
					billingCycleAnchor: "2026-11-01T13:33:00.000Z",
					bypassAllowed: true,
					enforceHardCap: false,
					// Test harness: relax the spend-backpressure lookahead so the
					// account's real (ahead-of-budget) spend pace cannot block the
					// provider calls these checks make. The quota feature is out of
					// scope here; hard-cap policy is unchanged.
					lookaheadHours: 876000,
				},
			},
		}),
	);
	// A tier overlay so declarations can pin by tier name (DR-038 vocabulary).
	fs.writeFileSync(
		path.join(agentDir, "model-tiers.json"),
		JSON.stringify({ cheap: `${CFG.provider}/${CFG.pinA}` }),
	);
	// Discovered persona definitions (the subagent spawn vocabulary).
	fs.writeFileSync(
		path.join(agentDir, "agents", "zeta.md"),
		agentsFile({
			name: "zeta",
			model: `${CFG.provider}/${CFG.pinC}`,
			body: "You are zeta. ZETA-BODY-11. Be brief and literal.",
		}),
	);
	fs.writeFileSync(
		path.join(agentDir, "agents", "eta.md"),
		agentsFile({ name: "eta", body: "You are eta. ETA-BODY-22. Be brief and literal." }),
	);
	return agentDir;
}

/** The fx fixture: a plain, arbitrary folder with its own project resources. */
function makeFxFixture(root) {
	const dir = path.join(root, "fixtures", "fx");
	fs.mkdirSync(path.join(dir, ".pi", "skills", "fx-skill"), { recursive: true });
	fs.mkdirSync(path.join(dir, ".pi", "extensions"), { recursive: true });
	fs.writeFileSync(path.join(dir, "AGENTS.md"), "This is the fx fixture. CTX-MARKER-55.\n");
	fs.writeFileSync(
		path.join(dir, ".pi", "skills", "fx-skill", "SKILL.md"),
		"---\nname: fx-skill\ndescription: A fixture skill loaded from a child's project.\n---\n\nDo the fx thing.\n",
	);
	fs.writeFileSync(
		path.join(dir, ".pi", "extensions", "marker-ext.js"),
		`import * as fs from "node:fs";\nimport * as path from "node:path";\nexport default function() {\n  try { fs.writeFileSync(path.join(${JSON.stringify(dir)}, "ext-loaded.txt"), "loaded"); } catch {}\n}\n`,
	);
	return dir;
}

const FULL_TOOL_V1 = "read, bash, subagent, fork, teardown, resurrect";

// ─── checks ──────────────────────────────────────────────────────────────────

async function R1(root, agentDir, probeOut) {
	log("── R1: boot-takeover ──");
	const dir = path.join(root, "R1", "work");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, "AGENTS.md"),
		personaFile({
			name: "BenchLead",
			tools: "read, bash",
			model: `${CFG.provider}/${CFG.pinA}:${CFG.pinALevel}`,
			skills: "codemap",
			body: "You are BenchLead. PREAMBLE-R1. Follow the user's instructions exactly.",
		}),
	);
	const s = rpcSession({ cwd: dir, agentDir, probeOut, extraArgs: ["--session-dir", path.join(root, "R1", "sessions")] });
	try {
		const st = await s.ready();
		await s.prompt("Reply with exactly the word OK and nothing else.");
		const state = st.data || {};
		const sessionFile = state.sessionFile;
		const entries = sessionEntries(sessionFile);
		const notices = noticesIn(entries);
		const p = payloads(probeOut).filter((x) => x.sys.includes("PREAMBLE-R1"));
		const sys = p[0]?.sys || "";
		const cmds = (await s.request({ type: "get_commands" }, (e) => e.success))?.data?.commands || [];
		const skillCmds = cmds.filter((c) => c.source === "skill").map((c) => c.name);

		check("r1_preamble", sys.startsWith("You are BenchLead. PREAMBLE-R1.") && !sys.includes(GENERIC_PREAMBLE), {
			generic: sys.includes(GENERIC_PREAMBLE),
		});
		check("r1_no_double_append", count(sys, "PREAMBLE-R1") === 1, { occurrences: count(sys, "PREAMBLE-R1") });
		check(
			"r1_boot_notice",
			notices.length === 1 &&
				notices[0].details?.condition === "boot" &&
				notices[0].details?.persona === "BenchLead" &&
				(notices[0].content || "").includes(path.join(dir, "AGENTS.md")) &&
				notices[0].display === true,
			notices.map((n) => ({ content: n.content, details: n.details })),
		);
		const model = state.model?.id || assistantModels(entries).at(-1) || "";
		check(
			"r1_model_pin",
			String(model).includes(CFG.pinA) && state.thinkingLevel === CFG.pinALevel,
			{ model, thinkingLevel: state.thinkingLevel },
		);
		check("r1_tools_bind", JSON.stringify(p[0]?.tools) === JSON.stringify(["bash", "read", "respond"]), {
			tools: p[0]?.tools,
		});
		check(
			"r1_skills_filter",
			sys.includes("<name>codemap</name>") && !sys.includes("<name>debugging</name>"),
			{},
		);
		check(
			"r1_slash_residue",
			skillCmds.length === 0 || skillCmds.some((n) => /debug/.test(n)),
			{ skillCommands: skillCmds },
		);
	} finally {
		s.kill();
	}
}

async function R2(root, agentDir, probeOut) {
	log("── R2: explicit-prompt ──");
	const dir = path.join(root, "R2", "work");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, "AGENTS.md"),
		personaFile({ name: "Shadow", body: "You are Shadow. R2-PERSONA-BODY." }),
	);
	const s = rpcSession({
		cwd: dir,
		agentDir,
		probeOut,
		extraArgs: ["--session-dir", path.join(root, "R2", "sessions"), "--system-prompt", "You are ExplicitBot. EXPLICIT-MARKER-77."],
	});
	try {
		await s.ready();
		await s.prompt("Reply with exactly the word OK and nothing else.");
		const st = await s.request({ type: "get_state" }, (e) => e.success);
		const entries = sessionEntries(st.data?.sessionFile);
		const p = payloads(probeOut).filter((x) => x.sys.includes("EXPLICIT-MARKER-77"));
		const sys = p[0]?.sys || "";
		check("r2_explicit_wins", sys.trimStart().startsWith("You are ExplicitBot. EXPLICIT-MARKER-77."), {
			head: sys.slice(0, 80),
		});
		check("r2_no_notice", noticesIn(entries).length === 0, {});
		check("r2_context_intact", count(sys, "R2-PERSONA-BODY") === 1, {
			occurrences: count(sys, "R2-PERSONA-BODY"),
		});
	} finally {
		s.kill();
	}
}

async function plainFileCase(root, agentDir, probeOut, { id, file, marker }) {
	const dir = path.join(root, id, "work");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "AGENTS.md"), file);
	const s = rpcSession({ cwd: dir, agentDir, probeOut, extraArgs: ["--session-dir", path.join(root, id, "sessions")] });
	try {
		await s.ready();
		await s.prompt("Reply with exactly the word OK and nothing else.");
		const st = await s.request({ type: "get_state" }, (e) => e.success);
		const entries = sessionEntries(st.data?.sessionFile);
		const p = payloads(probeOut).filter((x) => x.sys.includes(marker));
		const sys = p[0]?.sys || "";
		check(`${id}_generic_intact`, sys.includes(GENERIC_PREAMBLE), {});
		check(`${id}_context_rides`, count(sys, marker) === 1, { occurrences: count(sys, marker) });
		check(`${id}_no_notice`, noticesIn(entries).length === 0, {});
	} finally {
		s.kill();
	}
}

async function R3(root, agentDir, probeOut) {
	log("── R3: plain-agents ──");
	await plainFileCase(root, agentDir, probeOut, {
		id: "R3",
		file: "This repository holds demo fixtures. CTX-MARKER-33.\n",
		marker: "CTX-MARKER-33",
	});
}

async function R4(root, agentDir, probeOut) {
	log("── R4: unknown-kind ──");
	await plainFileCase(root, agentDir, probeOut, {
		id: "R4",
		file: "---\nkind: overlay\nname: Sneaky\nmodel: something-else\n---\n\nYou are Sneaky. KIND-MARKER-44.\n",
		marker: "KIND-MARKER-44",
	});
}

async function R5(root, agentDir, probeOut) {
	log("── R5: mid-session-edit ──");
	const dir = path.join(root, "R5", "work");
	fs.mkdirSync(dir, { recursive: true });
	const agents = path.join(dir, "AGENTS.md");
	fs.writeFileSync(agents, personaFile({ name: "Fluid", body: "You are Fluid. R5-BODY-71." }));
	const s = rpcSession({ cwd: dir, agentDir, probeOut, extraArgs: ["--session-dir", path.join(root, "R5", "sessions")] });
	try {
		await s.ready();
		await s.prompt("Reply with exactly the word OK and nothing else.");
		fs.writeFileSync(agents, personaFile({ name: "Fluid", body: "You are Fluid. R5-BODY-72." }));
		await s.prompt("Reply with exactly the word AGAIN and nothing else.");
		const st = await s.request({ type: "get_state" }, (e) => e.success);
		const entries = sessionEntries(st.data?.sessionFile);
		const all = payloads(probeOut);
		const v1 = all.find((x) => x.sys.includes("R5-BODY-71"));
		const v2 = all.find((x) => x.sys.includes("R5-BODY-72"));
		check("r5_edit_applies_next_run", !!v1 && !!v2 && !v1.sys.includes("R5-BODY-72") && !v2.sys.includes("R5-BODY-71"), {});
		check("r5_notice_once", noticesIn(entries).length === 1, {});
	} finally {
		s.kill();
	}
}

async function R6(root, agentDir, probeOut) {
	log("── R6: resume-rebinds (persona-authoritative at session boundaries) ──");
	const dir = path.join(root, "R6", "work");
	fs.mkdirSync(dir, { recursive: true });
	const agents = path.join(dir, "AGENTS.md");
	fs.writeFileSync(
		agents,
		personaFile({
			name: "Resu",
			tools: "read, bash",
			// Tier name (not a raw id) — resolves through model-tiers.json at bind.
			model: "cheap",
			body: "You are Resu. R6-BODY-61.",
		}),
	);
	const sessionDir = path.join(root, "R6", "sessions");
	let sessionFile;
	const s1 = rpcSession({ cwd: dir, agentDir, probeOut, extraArgs: ["--session-dir", sessionDir] });
	try {
		const st0 = await s1.ready();
		await s1.prompt("Reply with exactly the word OK and nothing else.");
		const bound = st0.data?.model?.id || "";
		check("r6_tier_pin_binds", String(bound).includes(CFG.pinA), { bound });
		// The user's mid-session choice — the same pi API behind `/model`.
		await s1.request({ type: "set_model", provider: CFG.provider, modelId: CFG.pinC }, (e) => e.success === true);
		await s1.request({ type: "set_thinking_level", level: CFG.think }, (e) => e.success === true);
		await s1.prompt("Reply with exactly the word AGAIN and nothing else.");
		const st = await s1.request({ type: "get_state" }, (e) => e.success);
		sessionFile = st.data?.sessionFile;
		const midModel = st.data?.model?.id;
		check("r6_user_choice_applied", String(midModel).includes(CFG.pinC), { midModel });
		// Spot-check: the run AFTER the /model change must run with the user's
		// model — mid-session run boundaries never slap the pin back.
		const midRuns = payloads(probeOut).filter((x) => x.sys.includes("R6-BODY-61"));
		const lastMid = midRuns.at(-1);
		check(
			"r6_midrun_model_stands",
			midRuns.length >= 2 && !!lastMid && String(lastMid.raw.model).includes(CFG.pinC),
			{ runs: midRuns.length, lastModel: lastMid?.raw.model },
		);
	} finally {
		s1.kill();
	}
	// The workspace changes while the session is down. The persona is
	// authoritative at session boundaries: the next open re-applies the edited
	// declaration — model (with its `:<level>` suffix) and tools — over the
	// user's mid-session choices.
	fs.writeFileSync(
		agents,
		personaFile({
			name: "Resu",
			tools: "read",
			model: `${CFG.provider}/${CFG.pinB}:${CFG.think2}`,
			body: "You are Resu. R6-BODY-62.",
		}),
	);
	const s2 = rpcSession({ cwd: dir, agentDir, probeOut, extraArgs: ["--session", sessionFile] });
	try {
		const st = await s2.ready();
		await s2.prompt("Reply with exactly the word THIRD and nothing else.");
		const state = st.data || {};
		const entries = sessionEntries(sessionFile);
		const all = payloads(probeOut);
		const resumed = [...all].reverse().find((x) => x.sys.includes("R6-BODY-6") || x.sys.includes(GENERIC_PREAMBLE));
		const model = state.model?.id || "";
		check(
			"r6_model_rebinds",
			String(model).includes(CFG.pinB) && !String(model).includes(CFG.pinC),
			{ model, thinkingLevel: state.thinkingLevel },
		);
		check("r6_thinking_rebinds", state.thinkingLevel === CFG.think2, {
			thinkingLevel: state.thinkingLevel,
			userChoice: CFG.think,
		});
		check(
			"r6_prompt_still_binds",
			!!resumed && resumed.sys.includes("R6-BODY-62") && !resumed.sys.includes("R6-BODY-61"),
			{},
		);
		check("r6_tools_rebind", !!resumed && JSON.stringify(resumed.tools) === JSON.stringify(["read", "respond"]), {
			tools: resumed?.tools,
			note: "the edited declaration's whitelist rebinds at the next open (exactly resolveChildToolPolicy normalization: ask_user dropped, respond appended); pi does not persist active tool selection across process restarts, so the rebind is also what restores the declared set",
		});
		check("r6_no_reannounce", noticesIn(entries).length === 1, {
			notices: noticesIn(entries).map((n) => n.details),
		});
	} finally {
		s2.kill();
	}
}

async function D1(root, agentDir, probeOut) {
	log("── D1: spawned-identity + child project resources + messaging ──");
	const dir = path.join(root, "D1", "work");
	fs.mkdirSync(dir, { recursive: true });
	const fx = makeFxFixture(root);
	const s = rpcSession({ cwd: dir, agentDir, probeOut, extraArgs: ["--session-dir", path.join(root, "D1", "sessions")] });
	try {
		await s.ready();
		const prompt =
			"Do exactly the following tool calls in order, then end your turn. Do not narrate. " +
			"1. Call the subagent tool with await set to false and agents set to a single-element list: " +
			`id 'zeta-child', persona 'zeta', task 'Reply with exactly the word ACK and nothing else, then stop.' ` +
			"2. Call the subagent tool with await set to false and agents set to a single-element list: " +
			`id 'eta-child', persona 'eta', model '${CFG.raw}', task 'Reply with exactly the word ACK and nothing else, then stop.' ` +
			"3. Call the subagent tool with await set to false and agents set to a single-element list: " +
			`id 'fx-child', cwd '${fx}', task 'Reply with exactly the word ACK and nothing else, then stop.' ` +
			"4. Call the send tool with parameters to 'zeta-child', message 'Reply with exactly the word PONG and nothing else.', expectResponse true. " +
			"5. Call the send tool with parameters to 'fx-child', message 'Reply with exactly the word PONG2 and nothing else.'.";
		await s.prompt(prompt);
		const st = await s.request({ type: "get_state" }, (e) => e.success);
		const { logFile } = persistencePaths(st.data?.sessionFile);

		// Children run asynchronously; wait for their turns to persist. Replies may
		// arrive as text OR inside a `respond` tool call, so the raw entry JSON is
		// the oracle for messaging.
		const agents = await waitFor(() => {
			const m = agentRecords(logFile);
			const zeta = m.get("zeta-child");
			const eta = m.get("eta-child");
			const fxc = m.get("fx-child");
			const turned = (rec) =>
				rec && assistantTexts(sessionEntries(rec.sessionFile)).length >= 1;
			return zeta && eta && fxc && turned(zeta) && turned(eta) && turned(fxc) ? m : undefined;
		}, 120000, 1000);
		check("j1_children_live", !!agents, { ids: agents ? [...agents.keys()] : [] });
		if (!agents) return;

		const zetaEntries = sessionEntries(agents.get("zeta-child").sessionFile);
		const zetaNotices = noticesIn(zetaEntries);
		const zetaPayload = payloads(probeOut).find(
			(x) => x.sys.includes("ZETA-BODY-11") && x.sys.includes(CHILD_IDENTITY),
		);
		check(
			"d1_body_is_identity",
			!!zetaPayload &&
				count(zetaPayload.sys, "ZETA-BODY-11") === 1 &&
				!zetaPayload.sys.includes(GENERIC_PREAMBLE),
			{ occurrences: zetaPayload ? count(zetaPayload.sys, "ZETA-BODY-11") : null },
		);
		check(
			"d1_name_only_boot_notice",
			zetaNotices.length === 1 &&
				zetaNotices[0].details?.condition === "boot" &&
				zetaNotices[0].details?.persona === "zeta" &&
				zetaNotices[0].details?.sourcePath === undefined,
			zetaNotices.map((n) => n.details),
		);

		const etaPayload = payloads(probeOut).find(
			(x) => x.sys.includes("ETA-BODY-22") && x.sys.includes(CHILD_IDENTITY),
		);
		const etaModel = etaPayload?.raw.model || assistantModels(sessionEntries(agents.get("eta-child").sessionFile)).at(-1) || "";
		check("d1_gap_fill_model", String(etaModel).includes(CFG.raw), { etaModel });
		check(
			"d1_eta_body",
			!!etaPayload && count(etaPayload.sys, "ETA-BODY-22") === 1 && !etaPayload.sys.includes(GENERIC_PREAMBLE),
			{},
		);

		const fxPayload = payloads(probeOut).find((x) => x.sys.includes("CTX-MARKER-55"));
		check(
			"d1_child_project_resources",
			!!fxPayload &&
				count(fxPayload.sys, "CTX-MARKER-55") === 1 &&
				fxPayload.sys.includes("<name>fx-skill</name>") &&
				fs.existsSync(path.join(fx, "ext-loaded.txt")),
			{
				context: !!fxPayload && count(fxPayload.sys, "CTX-MARKER-55") === 1,
				skill: !!fxPayload && fxPayload.sys.includes("<name>fx-skill</name>"),
				projectExt: fs.existsSync(path.join(fx, "ext-loaded.txt")),
			},
		);

		const zetaFile = agents.get("zeta-child").sessionFile;
		const fxFile = agents.get("fx-child").sessionFile;
		const messaging = await waitFor(
			() =>
				JSON.stringify(sessionEntries(zetaFile)).includes("PONG") &&
				JSON.stringify(sessionEntries(fxFile)).includes("PONG2")
					? true
					: undefined,
			150000,
			1000,
		);
		check("j1_messaging", !!messaging, {});
	} finally {
		s.kill();
	}
}

async function D2(root, agentDir, probeOut) {
	log("── D2: override + resurrect re-resolution + fork persona ──");
	const dir = path.join(root, "D2", "work");
	fs.mkdirSync(dir, { recursive: true });
	const agents = path.join(dir, "AGENTS.md");
	const bodyV1 = personaFile({
		name: "wslead",
		tools: FULL_TOOL_V1,
		model: `${CFG.provider}/${CFG.pinB}`,
		body: "You are wslead. WS-BODY-33. Follow the user's instructions exactly and make exactly the tool calls requested.",
	});
	fs.writeFileSync(agents, bodyV1);
	const s = rpcSession({ cwd: dir, agentDir, probeOut, extraArgs: ["--session-dir", path.join(root, "D2", "sessions")] });
	try {
		const st0 = await s.ready();
		const parentState = st0.data || {};
		await s.prompt(
			"Do exactly the following tool calls in order, then end your turn. Do not narrate. " +
				"1. Call the subagent tool with await set to true and agents set to a single-element list: " +
				`id 'zeta-child', persona 'zeta', model '${CFG.raw}', task 'Reply with exactly the word ACK and nothing else, then stop.' ` +
				"2. Call the teardown tool with agent 'zeta-child'.",
		);
		const teardown = s.toolResults("teardown").at(-1);
		const teardownText = teardown
			? (teardown.result?.content || []).map((c) => c.text || "").join("\n")
			: "";
		const parentEntries = sessionEntries(parentState.sessionFile);
		const parentNotices = noticesIn(parentEntries);
		const parentPayload = payloads(probeOut).find(
			(x) => x.sys.includes("WS-BODY-33") && !x.sys.includes(CHILD_IDENTITY),
		);
		check(
			"d2_parent_takeover",
			!!parentPayload &&
				!parentPayload.sys.includes(GENERIC_PREAMBLE) &&
				parentNotices.length === 1 &&
				parentNotices[0].details?.condition === "boot" &&
				parentNotices[0].details?.persona === "wslead",
			parentNotices.map((n) => n.details),
		);

		const { logFile } = persistencePaths(parentState.sessionFile);
		const recs = agentRecords(logFile);
		const zetaRec = recs.get("zeta-child");
		// The session id resurrect needs: from the teardown report, else the
		// child session file name.
		const reportSid = (teardownText.match(/session[_ ]?id["'\s:=]+([0-9a-fA-F-]{36})/i) || [])[1];
		const fileSid = zetaRec
			? (path.basename(zetaRec.sessionFile, ".jsonl").match(/([0-9a-fA-F]{8}-[0-9a-fA-F-]{27,})/) || [])[1]
			: undefined;
		const sid = reportSid || fileSid;
		check("j2_teardown_report", !!sid && /session/i.test(teardownText), {
			reportSid,
			fileSid,
			report: teardownText.slice(0, 200),
		});

		const zetaV1 = payloads(probeOut).find(
			(x) => x.sys.includes("WS-BODY-33") && x.sys.includes(CHILD_IDENTITY),
		);
		const zetaEntries = zetaRec ? sessionEntries(zetaRec.sessionFile) : [];
		check(
			"d2_override_body",
			!!zetaV1 &&
				!zetaV1.sys.includes("ZETA-BODY-11") &&
				count(zetaV1.sys, "WS-BODY-33") === 1 &&
				!zetaV1.sys.includes(GENERIC_PREAMBLE),
			{},
		);
		const v1Notices = noticesIn(zetaEntries);
		check(
			"d2_override_notice",
			v1Notices.length === 1 &&
				v1Notices[0].details?.condition === "override" &&
				v1Notices[0].details?.persona === "wslead" &&
				v1Notices[0].details?.replaced === "zeta" &&
				(v1Notices[0].content || "").includes(path.join(dir, "AGENTS.md")),
			v1Notices.map((n) => n.details),
		);
		check(
			"d2_pin_beats_explicit",
			!!zetaV1 &&
				String(zetaV1.raw.model).includes(CFG.pinB) &&
				!String(zetaV1.raw.model).includes(CFG.pinC),
			{ model: zetaV1?.raw.model },
		);

		if (!sid) return;
		// The active file changes while the agent is torn down: a resurrect
		// must re-resolve capability gates (tools) but keep the persisted model.
		fs.writeFileSync(
			agents,
			personaFile({
				name: "wslead",
				tools: "read, bash",
				model: `${CFG.provider}/${CFG.pinA}`,
				body: "You are wslead. WS-BODY-44. Follow the user's instructions exactly and make exactly the tool calls requested.",
			}),
		);
		await s.prompt(
			"Do exactly the following tool calls in order, then end your turn. Do not narrate. " +
				"1. Call the resurrect tool with agents set to a single-element list: " +
				`id 'zeta-child', sessionId '${sid}', channels [], task 'Reply with exactly the word ACK2 and nothing else, then stop.' ` +
				"2. Call the fork tool with id 'fork-child', task 'Reply with exactly the word ACK3 and nothing else, then stop.' " +
				"3. Call the resurrect tool with agents set to a single-element list: " +
				"id 'bad-child', sessionId 'bogus-session-123', channels [], task 'x'.",
		);

		const recs2 = agentRecords(logFile);
		const zeta2 = recs2.get("zeta-child");
		const forkRec = recs2.get("fork-child");
		await waitFor(() => {
			const z = zeta2 ? assistantTexts(sessionEntries(zeta2.sessionFile)).join(" ") : "";
			const f = forkRec ? assistantTexts(sessionEntries(forkRec.sessionFile)).join(" ") : "";
			return z.includes("ACK2") && f.includes("ACK3") ? true : undefined;
		}, 120000, 1000);

		const zetaV2 = payloads(probeOut).find(
			(x) => x.sys.includes("WS-BODY-44") && x.sys.includes(CHILD_IDENTITY) && x.tools.length === 3,
		);
		check(
			"d2_resurrect_regates",
			!!zetaV2 &&
				JSON.stringify(zetaV2.tools) === JSON.stringify(["bash", "read", "respond"]) &&
				String(zetaV2.raw.model).includes(CFG.pinB),
			{ tools: zetaV2?.tools, model: zetaV2?.raw.model },
		);
		const zeta2Entries = zeta2 ? sessionEntries(zeta2.sessionFile) : [];
		check("d2_resurrect_body", assistantTexts(zeta2Entries).join(" ").includes("ACK2"), {});
		check("d2_no_reannounce", noticesIn(zeta2Entries).length === 1, {
			notices: noticesIn(zeta2Entries).map((n) => n.details),
		});

		// Fork children wear the inherited workspace persona wholesale: the
		// construction path binds the workspace declaration's model pin + tools,
		// and the per-run prompt binding supplies its body. (Fork children carry
		// no <subagent_identity> addendum — that is spawn-path-only.) Fork is a
		// silent continuation: the child's copied transcript already carries the
		// parent's takeover notice, so exactly one notice (the inherited one) may
		// be visible — a re-announcing fork would show two.
		const forkPayload = payloads(probeOut).find(
			(x) =>
				x.sys.includes("WS-BODY-44") &&
				!x.sys.includes("WS-BODY-33") &&
				String(x.raw.model).includes(CFG.pinA),
		);
		const forkNotices = forkRec ? noticesIn(sessionEntries(forkRec.sessionFile)) : [];
		check(
			"d2_fork_persona",
			!!forkPayload &&
				forkPayload.sys.trimStart().startsWith("You are wslead. WS-BODY-44") &&
				!forkPayload.sys.includes(GENERIC_PREAMBLE) &&
				!forkPayload.sys.includes("ZETA-BODY-11") &&
				JSON.stringify(forkPayload.tools) === JSON.stringify(["bash", "read", "respond"]) &&
				forkNotices.length === 1 &&
				forkNotices[0].details?.condition === "boot" &&
				forkNotices[0].details?.persona === "wslead" &&
				!!forkNotices[0].details?.sourcePath,
			{ tools: forkPayload?.tools, model: forkPayload?.raw.model, notices: forkNotices.map((n) => n.details),
				note: "silent continuation: the single notice is the parent's inherited takeover notice (fork copies the branch); the fork child announces nothing new" },
		);

		const resurrects = s.toolResults("resurrect");
		const bad = resurrects.find((r) =>
			((r.result?.content || []).map((c) => c.text || "").join("\n")).includes("bogus-session-123"),
		);
		const badText = bad ? (bad.result?.content || []).map((c) => c.text || "").join("\n") : "";
		check("j2_resurrect_error_path", /error|not found|unknown|no session|fail/i.test(badText), {
			text: badText.slice(0, 200),
		});
	} finally {
		s.kill();
	}
}

async function R7(root, agentDir, probeOut) {
	log("── R7: reload-rebinds (continuation boundary) ──");
	const dir = path.join(root, "R7", "work");
	fs.mkdirSync(dir, { recursive: true });
	const agents = path.join(dir, "AGENTS.md");
	fs.writeFileSync(
		agents,
		personaFile({
			name: "Relo",
			tools: "read, bash",
			model: `${CFG.provider}/${CFG.pinA}`,
			body: "You are Relo. R7-BODY-81.",
		}),
	);
	const s = rpcSession({
		cwd: dir,
		agentDir,
		probeOut,
		extraArgs: ["--session-dir", path.join(root, "R7", "sessions")],
	});
	try {
		await s.ready();
		await s.prompt("Reply with exactly the word OK and nothing else.");
		// The user's mid-session choices — the same pi API behind `/model`.
		await s.request({ type: "set_model", provider: CFG.provider, modelId: CFG.pinC }, (e) => e.success === true);
		await s.request({ type: "set_thinking_level", level: CFG.think }, (e) => e.success === true);
		await s.prompt("Reply with exactly the word MID and nothing else.");
		// The declaration changes while the session is live.
		fs.writeFileSync(
			agents,
			personaFile({
				name: "Relo",
				tools: "read",
				model: `${CFG.provider}/${CFG.pinB}:${CFG.think2}`,
				body: "You are Relo. R7-BODY-82.",
			}),
		);
		// Extension reload via the probe's pw-reload command (which calls
		// ctx.reload() — the same session.reload() pi's builtin /reload runs;
		// builtins are UI-dispatched only, but prompt("/name") dispatches
		// extension commands). Dispatch is observed via the probe's reason log.
		const reasonsFile = probeOut + ".reasons";
		const before = (() => {
			try {
				return fs.readFileSync(reasonsFile, "utf8").length;
			} catch {
				return 0;
			}
		})();
		s.send({ type: "prompt", id: "reload", message: "/pw-reload" });
		const reloaded = await waitFor(() => {
			let txt = "";
			try {
				txt = fs.readFileSync(reasonsFile, "utf8");
			} catch {}
			return txt.slice(before).includes('"reload"') ? true : undefined;
		}, 60000, 300);
		check("r7_reload_dispatched", !!reloaded, {});

		await s.prompt("Reply with exactly the word AFTER and nothing else.");
		const st = await s.request({ type: "get_state" }, (e) => e.success);
		const state = st.data || {};
		const entries = sessionEntries(state.sessionFile);
		const after = [...payloads(probeOut)].reverse().find((x) => x.sys.includes("R7-BODY-8"));
		check(
			"r7_reload_rebinds",
			String(state.model?.id || "").includes(CFG.pinB) &&
				!String(state.model?.id || "").includes(CFG.pinC) &&
				state.thinkingLevel === CFG.think2 &&
				!!after &&
				JSON.stringify(after.tools) === JSON.stringify(["read", "respond"]),
			{
				model: state.model?.id,
				thinkingLevel: state.thinkingLevel,
				tools: after?.tools,
				note: "reload is a continuation boundary: the edited declaration re-applies in full (model + :<level> thinking + tool whitelist) over the user's mid-session choices; pi-core reload resets active tool selection to defaults, and the rebind restores the declared set",
			},
		);
		check(
			"r7_reload_prompt_binds",
			!!after && after.sys.includes("R7-BODY-82") && !after.sys.includes("R7-BODY-81"),
			{},
		);
		check("r7_reload_no_notice", noticesIn(entries).length === 1, {});
	} finally {
		s.kill();
	}
}

// ─── main ────────────────────────────────────────────────────────────────────
async function main() {
	const root = opt("workdir", null) || fs.mkdtempSync(path.join(os.tmpdir(), "pw-"));
	fs.mkdirSync(root, { recursive: true });
	const probeOut = path.join(root, "payloads.ndjson");
	log("workdir:", root);
	log("models:", JSON.stringify(CFG));
	const agentDir = makeAgentDir(root);
	const steps = [
		["R1", R1],
		["R2", R2],
		["R3", R3],
		["R4", R4],
		["R5", R5],
		["R6", R6],
		["R7", R7],
		["D1", D1],
		["D2", D2],
	];
	try {
		for (const [id, fn] of steps) {
			if (!wanted(id)) continue;
			try {
				await fn(root, agentDir, probeOut);
			} catch (e) {
				check(`${id}_error`, false, String(e && e.stack ? e.stack : e));
			}
		}
	} finally {
		if (!KEEP && !opt("workdir", null)) {
			try {
				fs.rmSync(root, { recursive: true, force: true });
			} catch {}
		}
	}
	const pass = !Object.values(checks).includes(false);
	process.stdout.write(JSON.stringify({ verdict: pass ? "PASS" : "FAIL", checks, observed }, null, 2) + "\n");
	process.exit(pass ? 0 : 1);
}

main();
