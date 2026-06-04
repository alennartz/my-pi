#!/usr/bin/env node
/**
 * resume-restore — drive a real parent `pi --mode rpc` through the full
 * subagent resume-restore journey and assert restored status is faithful.
 *
 * Journey:
 *   1. SPAWN: launch a parent pi (rpc), have it spawn a subagent that does a
 *      trivial task and idles. Poll persistence until the child session file
 *      contains a completed assistant turn, then kill the parent (simulating
 *      shutdown).
 *   2. RESUME: relaunch the parent with `--session <parentSessionFile>`. The
 *      subagents extension's session_start hook restores the child from its
 *      session file. Drive the resumed parent's `check_status` tool (the only
 *      tool enabled, so the model cannot deviate) and capture the verbatim
 *      detail for the restored agent.
 *   3. ASSERT: restored agent shows state=idle (not stuck running), recomputed
 *      usage/cost/turns/model/lastOutput from the child session file, and the
 *      reported totals match an independent re-parse of the child session.
 *
 * Why this is end-to-end: the status is produced by the real restore path in
 * agent-set.ts (parseSessionSnapshot + childHasLiveSubagents wiring) running in
 * a genuinely resumed pi process, observed through the real check_status tool
 * surface — not a unit harness.
 *
 * CRITICAL: the spawned pi processes must NOT inherit PI_PARENT_LINK. When this
 * tool runs inside a pi subagent, that env var is set, and any child pi would
 * treat itself as a sub-agent (parentLink) and skip restore entirely. The tool
 * scrubs it.
 *
 * Inputs (CLI flags or env):
 *   --workdir <dir>   scratch dir (default: a fresh mkdtemp under $TMPDIR)
 *   --model <id>      model for both parent and worker (default: pi default)
 *   --nested          worker also spawns its own subagent, exercising the
 *                     hasSubgroup recompute input (worker's own agents.jsonl)
 *   --keep            do not delete the scratch dir on exit
 *   --timeout <sec>   per-phase timeout (default 120)
 *
 * Output: human-readable phase log to stderr; a final JSON verdict to stdout:
 *   { "verdict": "PASS"|"FAIL", "checks": {...}, "observed": {...}, "expected": {...} }
 * Exit code 0 on PASS, 1 on FAIL.
 *
 * Prerequisites: `pi` on PATH with this repo loaded as a package (automatic
 * when alenna-pi is the active pi package). No API key handling here — relies
 * on the ambient pi provider config.
 */

import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ─── arg parsing ─────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function flag(name) {
	const i = argv.indexOf(`--${name}`);
	return i !== -1;
}
function opt(name, def) {
	const i = argv.indexOf(`--${name}`);
	return i !== -1 && argv[i + 1] ? argv[i + 1] : def;
}
const MODEL = opt("model", process.env.RR_MODEL || null);
const NESTED = flag("nested");
const KEEP = flag("keep");
const TIMEOUT = Number(opt("timeout", "240")) * 1000;
let WORKDIR = opt("workdir", null);

function log(...a) {
	process.stderr.write("[resume-restore] " + a.join(" ") + "\n");
}

// scrub PI_PARENT_LINK so spawned pi processes act as top-level parents.
function cleanEnv() {
	const env = { ...process.env };
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

function piArgs(extra) {
	const base = ["--mode", "rpc"];
	if (MODEL) base.push("--model", MODEL);
	return [...base, ...extra];
}

// ─── persistence helpers (read-only, mirror persistence.ts path derivation) ──
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

// Independent re-parse of a child session file (the oracle the restore path
// should agree with). Mirrors parseSessionSnapshot's contract.
function reparse(sessionFile) {
	const snap = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, model: undefined, lastOutput: undefined };
	let contents;
	try {
		contents = fs.readFileSync(sessionFile, "utf8");
	} catch {
		return snap;
	}
	for (const raw of contents.split("\n")) {
		const l = raw.trim();
		if (!l || !l.includes('"role":"assistant"')) continue;
		let e;
		try {
			e = JSON.parse(l);
		} catch {
			continue;
		}
		if (e.type !== "message" || e.message?.role !== "assistant") continue;
		const m = e.message;
		const u = m.usage || {};
		snap.turns += 1;
		snap.input += u.input ?? 0;
		snap.output += u.output ?? 0;
		snap.cacheRead += u.cacheRead ?? 0;
		snap.cacheWrite += u.cacheWrite ?? 0;
		snap.cost += u.cost?.total ?? 0;
		if (typeof m.model === "string") snap.model = m.model;
		if (Array.isArray(m.content)) {
			let lastText;
			for (const p of m.content) if (p?.type === "text" && typeof p.text === "string") lastText = p.text;
			if (lastText !== undefined) snap.lastOutput = lastText;
		}
	}
	return snap;
}

// ─── phase 1: spawn a worker and let it idle ─────────────────────────────────
function spawnPhase(sessionDir, workCwd) {
	return new Promise((resolve, reject) => {
		const proc = spawn("pi", piArgs(["--session-dir", sessionDir]), {
			cwd: workCwd,
			stdio: ["pipe", "pipe", "pipe"],
			env: cleanEnv(),
		});
		let parentSessionFile;
		let settled = false;
		const to = setTimeout(() => {
			if (!settled) {
				killGroup(proc);
				reject(new Error("spawn phase timed out"));
			}
		}, TIMEOUT);
		const send = (o) => proc.stdin.write(JSON.stringify(o) + "\n");

		const workerTask = NESTED
			? "First, use the subagent tool to spawn one agent with id 'helper' and task 'Reply with exactly the word PONG and nothing else, then stop.' After the subagent tool returns, reply with exactly the word ACK and nothing else, then stop."
			: "Reply with exactly the word ACK and nothing else, then stop.";
		const spawnPrompt =
			`Use the subagent tool to spawn exactly one agent with id 'worker' and task: '${workerTask}' ` +
			"After the subagent tool returns, immediately end your turn. Do not call await_agents.";

		attach(proc.stdout, (p) => {
			if (p.type === "response" && p.command === "get_state") {
				parentSessionFile = p.data.sessionFile;
				log("parent session:", parentSessionFile);
				send({ type: "prompt", id: "p1", message: spawnPrompt });
			}
		});
		proc.stderr.on("data", (d) => process.stderr.write("[pi-spawn] " + d));
		proc.on("spawn", () => setTimeout(() => send({ type: "get_state", id: "s1" }), 800));

		// Poll persistence for a completed worker turn.
		const poll = setInterval(() => {
			if (!parentSessionFile) return;
			const { logFile } = persistencePaths(parentSessionFile);
			const agents = liveAgents(logFile);
			const worker = agents.find((a) => a.id === "worker");
			if (!worker || !fs.existsSync(worker.sessionFile)) return;
			const cc = fs.readFileSync(worker.sessionFile, "utf8");
			if (!cc.includes('"role":"assistant"')) return;
			// In nested mode, also wait for the helper's session to complete a turn.
			if (NESTED) {
				const wp = persistencePaths(worker.sessionFile);
				const subs = liveAgents(wp.logFile);
				const helper = subs.find((a) => a.id === "helper");
				if (!helper || !fs.existsSync(helper.sessionFile)) return;
				if (!fs.readFileSync(helper.sessionFile, "utf8").includes('"role":"assistant"')) return;
			}
			settled = true;
			clearInterval(poll);
			clearTimeout(to);
			log("worker idle; killing parent");
			killGroup(proc);
			setTimeout(() => resolve({ parentSessionFile, worker }), 500);
		}, 1000);
	});
}

// ─── phase 2: resume and read restored status via check_status ───────────────
function resumePhase(parentSessionFile, sessionDir, workCwd) {
	return new Promise((resolve, reject) => {
		const proc = spawn("pi", piArgs(["--session", parentSessionFile, "--session-dir", sessionDir, "--tools", "check_status"]), {
			cwd: workCwd,
			stdio: ["pipe", "pipe", "pipe"],
			env: cleanEnv(),
		});
		let settled = false;
		const to = setTimeout(() => {
			if (!settled) {
				killGroup(proc);
				reject(new Error("resume phase timed out"));
			}
		}, TIMEOUT);
		const send = (o) => proc.stdin.write(JSON.stringify(o) + "\n");
		// The resumed parent AUTO-RESUMES a turn (session-resume protocol) to
		// continue its original task. We must wait for it to go idle before
		// driving check_status — a prompt sent mid-turn is rejected. Tools are
		// restricted to check_status so that auto-resume turn cannot mutate the
		// restored agent (e.g. teardown) before we observe it. We drive a fresh
		// check_status turn on each idle boundary until the tool is called.
		const DRIVE_MSG =
			"Call the check_status tool now with agent set to 'worker'. Do not narrate or explain — just call the tool, then end your turn.";
		let attempts = 0;
		let settleTimer;
		const drive = () => {
			if (settled || attempts >= 5) return;
			attempts += 1;
			log(`driving check_status (attempt ${attempts})`);
			send({ type: "prompt", id: `drive-${attempts}`, message: DRIVE_MSG });
		};
		attach(proc.stdout, (p) => {
			if (p.type === "response" && p.command === "get_state") {
				log("resumed; messageCount", p.data.messageCount, "streaming", p.data.isStreaming);
				if (p.data.isStreaming) {
					// Auto-resume in flight — wait for its agent_end below.
				} else {
					// No auto-resume; agent idle. Give it a brief grace period in
					// case auto-resume is about to start, else drive directly.
					settleTimer = setTimeout(() => drive(), 8000);
				}
			}
			if (p.type === "agent_end") {
				clearTimeout(settleTimer);
				// A turn just finished and the agent is idle. Drive (or re-drive
				// if the prior turn narrated instead of calling the tool).
				setTimeout(() => drive(), 600);
			}
			if (p.type === "response" && p.command === "prompt" && !p.success) {
				// Sent while still streaming — back off and let agent_end re-drive.
				attempts = Math.max(0, attempts - 1);
			}
			if (process.env.RR_VERBOSE) {
				if (p.type === "message_end") {
					const m = p.message;
					const txt = (Array.isArray(m.content) ? m.content : []).filter((x) => x.type === "text").map((x) => x.text).join("|");
					const tc = (Array.isArray(m.content) ? m.content : []).filter((x) => x.type === "toolCall").map((x) => x.name);
					log("MSG", m.role, "text:", txt.slice(0, 160), "tools:", JSON.stringify(tc));
				} else if (p.type === "extension_error") log("EXT_ERR", p.error);
			}
			if (p.type === "tool_execution_end" && p.toolName === "check_status") {
				clearTimeout(settleTimer);
				const text = (p.result?.content || []).map((c) => c.text).join("\n");
				settled = true;
				clearTimeout(to);
				killGroup(proc);
				setTimeout(() => resolve(text), 400);
			}
		});
		proc.stderr.on("data", (d) => process.stderr.write("[pi-resume] " + d));
		proc.on("spawn", () => setTimeout(() => send({ type: "get_state", id: "s1" }), 1200));
	});
}

// ─── parse the check_status detail block ─────────────────────────────────────
function parseDetail(text) {
	const get = (re) => {
		const m = text.match(re);
		return m ? m[1].trim() : undefined;
	};
	const usage = get(/Usage:\s*↑(\d+)\s*↓(\d+)\s*\$([0-9.]+)\s*\((\d+)\s*turns?\)/);
	const um = text.match(/Usage:\s*↑(\d+)\s*↓(\d+)\s*\$([0-9.]+)\s*\((\d+)\s*turns?\)/);
	return {
		raw: text,
		state: get(/State:\s*(.+)/),
		model: get(/Model:\s*(.+)/),
		lastOutput: get(/Last output:\s*(.+)/),
		inputTotal: um ? Number(um[1]) : undefined,
		output: um ? Number(um[2]) : undefined,
		cost: um ? Number(um[3]) : undefined,
		turns: um ? Number(um[4]) : undefined,
	};
}

// ─── main ────────────────────────────────────────────────────────────────────
async function main() {
	let cleanup = false;
	if (!WORKDIR) {
		WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), "rr-"));
		cleanup = !KEEP;
	}
	const sessionDir = path.join(WORKDIR, "sessions");
	const workCwd = path.join(WORKDIR, "work");
	fs.mkdirSync(sessionDir, { recursive: true });
	fs.mkdirSync(workCwd, { recursive: true });
	log("workdir:", WORKDIR, NESTED ? "(nested)" : "");

	const checks = {};
	let observed = {};
	let expected = {};
	try {
		log("── phase 1: spawn ──");
		const { parentSessionFile, worker } = await spawnPhase(sessionDir, workCwd);

		log("── phase 2: resume ──");
		const detailText = await resumePhase(parentSessionFile, sessionDir, workCwd);
		log("check_status:\n" + detailText);
		observed = parseDetail(detailText);

		// Oracle: independent re-parse of the worker session file.
		const oracle = reparse(worker.sessionFile);
		const oracleInput = oracle.input + oracle.cacheRead + oracle.cacheWrite;
		expected = { inputTotal: oracleInput, output: oracle.output, turns: oracle.turns, model: oracle.model, lastOutput: oracle.lastOutput, costNonZero: oracle.cost > 0 };

		// hasSubgroup recompute input (childHasLiveSubagents reads this log).
		const wp = persistencePaths(worker.sessionFile);
		const workerSubs = liveAgents(wp.logFile);
		expected.subgroup = NESTED;
		observed.subgroupInput = workerSubs.length > 0;

		checks.notStuckRunning = observed.state === "idle";
		checks.modelRecomputed = !!observed.model && observed.model === oracle.model;
		checks.lastOutputRecomputed = observed.lastOutput === oracle.lastOutput && !!oracle.lastOutput;
		checks.turnsRecomputed = observed.turns >= 1 && observed.turns === oracle.turns;
		checks.inputUsageMatchesOracle = observed.inputTotal === oracleInput && oracleInput > 0;
		checks.outputUsageMatchesOracle = observed.output === oracle.output;
		checks.costRecomputed = observed.cost > 0;
		checks.subgroupInputMatches = observed.subgroupInput === NESTED;
	} catch (e) {
		checks.error = String(e && e.stack ? e.stack : e);
	} finally {
		if (cleanup) {
			try {
				fs.rmSync(WORKDIR, { recursive: true, force: true });
			} catch {}
		}
	}

	const pass = !checks.error && Object.entries(checks).every(([k, v]) => k === "error" || v === true);
	const result = { verdict: pass ? "PASS" : "FAIL", nested: NESTED, checks, observed, expected };
	process.stdout.write(JSON.stringify(result, null, 2) + "\n");
	process.exit(pass ? 0 : 1);
}

main();
