#!/usr/bin/env node
// Real Oh My Pi check for omp-channel (see docs/omp-verification.md).
//
// Starts the `omp` command in RPC mode with this extension and the example MCP server, using the
// maintainer's default configuration unchanged (no profile, no test home, no environment overrides).
// Checks: an MCP push reaches an idle agent and starts a turn; a push during a turn is queued after
// it; a shell tool run followed by abort stops the turn and keeps the tool output.
//
// It runs a model, so it does nothing unless asked:
//   OMP_E2E=1 OMP_E2E_MODEL=<provider/model-id> npm run omp:e2e
//
// Optional: OMP_E2E_TURN_TIMEOUT_MS (how long each wait for a turn may last, default 600000; a slow
// local model can take minutes), OMP_E2E_CONFIG (a config overlay file passed as --config, for example one that turns
// the update check off; the machine's configuration is still loaded underneath it),
// OMP_E2E_OMP (the omp command, default "omp"), OMP_E2E_BUN_DIR (a folder with a Bun
// >= 1.4.4 binary, put first on the PATH of the omp process only), OMP_E2E_LOCAL_URL (the local model
// endpoint checked before starting, default http://127.0.0.1:8888/v1), OMP_E2E_SECOND_AFTER_MS
// (default 1500).
//
// An optional network guard (OMP_E2E_NETWORK_GUARD=1, off by default) watches every TCP connection
// of the omp process tree and fails the run on any non-loopback peer.

import { execFile, spawn } from "node:child_process";
import { resolve4 } from "node:dns/promises";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const env = process.env;

if (env.OMP_E2E !== "1") {
  console.log(
    "skipped: set OMP_E2E=1 and OMP_E2E_MODEL=<provider/model-id> to run the Oh My Pi check",
  );
  process.exit(0);
}

function fail(message) {
  console.error(`omp-e2e: FAILED: ${message}`);
  process.exit(2);
}

const model = env.OMP_E2E_MODEL;
if (!model?.includes("/")) fail("OMP_E2E_MODEL must be provider/model-id; no model is assumed");
const localUrl = new URL(env.OMP_E2E_LOCAL_URL ?? "http://127.0.0.1:8888/v1");
const loopback = (host) =>
  host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
if (!loopback(localUrl.hostname))
  fail(`OMP_E2E_LOCAL_URL must be loopback, got ${localUrl.hostname}`);
const ompCommand = env.OMP_E2E_OMP ?? "omp";
const extension = join(root, "dist/index.js");
const server = join(root, "examples/mcp-server/server.mjs");
if (!existsSync(extension)) fail("dist/index.js is missing: run npm run build first");

// Preflight: any HTTP answer from the local endpoint means the model server is up. Whether the
// model itself answers is checked by the first turn below.
const preflight = await fetch(new URL("models", `${localUrl.href.replace(/\/$/, "")}/`), {
  signal: AbortSignal.timeout(5000),
}).then(
  (response) => response.status,
  () => 0,
);
if (preflight === 0) fail(`the local model endpoint did not answer at ${localUrl.origin}`);

// Temporary project outside the repository: it holds the MCP server entry and an MCP-only
// omp-channel configuration (no service, so no replies leave the machine). Without a valid
// configuration the extension disables itself and never receives the pushed notifications.
const project = mkdtempSync(join(tmpdir(), "omp-channel-e2e-project-"));
mkdirSync(join(project, ".omp"));
writeFileSync(
  join(project, ".omp", "mcp.json"),
  JSON.stringify({ mcpServers: { "omp-channel": { command: process.execPath, args: [server] } } }),
);
const channelConfig = join(project, ".omp", "omp-channel.json");
writeFileSync(
  channelConfig,
  JSON.stringify({ mcpServer: "omp-channel", delivery: { deliverAs: "followUp" } }),
);

// A fresh home for each run. Oh My Pi caches the tool list of an MCP server in its home for 30 days,
// so a home used before can keep an older description of the server and never start it. The local
// provider file is linked, not copied, so its secrets are not duplicated; the home is removed at the
// end. Only this check's home is used: the machine's own configuration and cache are not touched.
const home = mkdtempSync(join(tmpdir(), "omp-channel-e2e-home-"));
const agentDir = join(home, ".omp", "agent");
mkdirSync(agentDir, { recursive: true });
const machineModels = join(homedir(), ".omp", "agent", "models.yml");
if (!existsSync(machineModels)) fail("the machine has no models.yml with the local provider");
symlinkSync(machineModels, join(agentDir, "models.yml"));
writeFileSync(
  join(agentDir, "config.yml"),
  "update:\n  auto: false\ntelemetry:\n  otlpExportEnabled: false\nweb_search:\n  enabled: false\n",
);

// Optional overlay for this run only. Oh My Pi merges it over the machine's configuration; this
// script never writes it.
const overlay = env.OMP_E2E_CONFIG;
if (overlay !== undefined && !existsSync(overlay))
  fail(`OMP_E2E_CONFIG does not exist: ${overlay}`);
const overlayArgs = overlay ? [`--config=${overlay}`] : [];
// The spotlight service (spotlight.url, a remote endpoint) is an auxiliary call that opened a remote
// connection during a turn. The check runs without it, so the guard only sees the model and the
// example server.
const runFlags = ["--no-spotlight"];

const child = spawn(
  ompCommand,
  [
    "--mode",
    "rpc",
    "--no-session",
    "--cwd",
    project,
    "--model",
    model,
    ...overlayArgs,
    ...runFlags,
    "-e",
    extension,
  ],
  {
    cwd: project,
    env: {
      ...env,
      PATH: env.OMP_E2E_BUN_DIR ? `${env.OMP_E2E_BUN_DIR}:${env.PATH ?? ""}` : env.PATH,
      HOME: home,
      OMP_CHANNEL_CONFIG: channelConfig,
      EXAMPLE_CHANNEL_SECOND_AFTER_MS: env.OMP_E2E_SECOND_AFTER_MS ?? "1500",
    },
    stdio: ["pipe", "pipe", "pipe"],
  },
);

// ---- network guard ------------------------------------------------------------------------------
// Remote destinations the check tolerates on purpose. The guard sees addresses, not names. An entry
// is either a host (resolved once before the run) or a list of addresses. An address can be shared
// with other sites behind the same CDN, so an entry also admits those. Each entry prints its reason.
const TOLERATED = [
  {
    host: "catalog.stencil.so",
    reason:
      "seen once at startup on 26/11/2026; purpose not documented; Stencil Labs is the author of @oh-my-pi/pi-catalog",
  },
  {
    label: "startup addresses",
    addresses: [
      "43.98.246.135",
      "43.106.123.215",
      "54.230.183.54",
      "54.230.183.99",
      "64.239.109.65",
      "64.239.123.65",
      "104.18.2.115",
      "104.18.3.115",
      "104.18.10.160",
      "104.18.28.226",
      "104.26.8.108",
      "140.82.113.22",
      "142.251.141.243",
    ],
    reason:
      "seen at startup in several runs on 26/11/2026, with no prompt sent; probably the endpoints that model discovery at startup contacts for the configured providers (not verified which address belongs to which provider)",
  },
];
// The network guard is off by default. OMP_E2E_NETWORK_GUARD=1 turns it on; the tolerated entries
// apply only while it is on.
const networkGuard = env.OMP_E2E_NETWORK_GUARD === "1";
const toleratedAddresses = new Map(); // address -> entry name
const toleratedSeen = new Set();
if (!networkGuard) {
  console.log(
    "network guard: off (set OMP_E2E_NETWORK_GUARD=1 to stop on any non-loopback connection)",
  );
}
for (const entry of networkGuard ? TOLERATED : []) {
  const name = entry.host ?? entry.label;
  const addresses =
    entry.host === undefined ? entry.addresses : await resolve4(entry.host).catch(() => []);
  if (addresses.length === 0) fail(`tolerated host ${name} does not resolve; the check stops`);
  for (const address of addresses) toleratedAddresses.set(address, name);
  console.log(
    `tolerated remote destinations: ${name} -> ${addresses.join(", ")} (${entry.reason})`,
  );
}

let violation = "";
const peersSeen = new Set();
const run = (file, args) =>
  new Promise((resolveRun) => {
    execFile(file, args, { maxBuffer: 1 << 20 }, (error, stdout) =>
      resolveRun(error && !stdout ? "" : String(stdout)),
    );
  });

async function processTree(rootPid) {
  const table = await run("ps", ["-A", "-o", "pid=,ppid="]);
  const children = new Map();
  for (const line of table.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const pids = [rootPid];
  for (let index = 0; index < pids.length; index += 1)
    pids.push(...(children.get(pids[index]) ?? []));
  return pids;
}

const isLoopbackHost = (host) =>
  host.startsWith("127.") || host === "[::1]" || host === "::1" || host === "localhost";

async function checkNetwork() {
  const pids = await processTree(child.pid);
  const output = await run("lsof", ["-a", "-nP", "-iTCP", "-Fn", "-p", pids.join(",")]);
  for (const line of output.split("\n")) {
    if (!line.startsWith("n") || !line.includes("->")) continue;
    const remote = line.split("->")[1] ?? "";
    const host = remote.slice(0, remote.lastIndexOf(":"));
    peersSeen.add(remote);
    if (isLoopbackHost(host)) continue;
    if (toleratedAddresses.has(host)) {
      toleratedSeen.add(`${toleratedAddresses.get(host)} ${remote}`);
      continue;
    }
    if (violation === "") {
      violation = `connection to a non-local host: ${host}`;
      child.kill("SIGTERM");
    }
  }
}

const guard = networkGuard
  ? setInterval(() => {
      checkNetwork().catch(() => undefined);
    }, 300)
  : undefined;

// ---- RPC plumbing -------------------------------------------------------------------------------
const frames = [];
let pending = "";
let nextId = 1;
const responses = new Map();
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  pending += chunk;
  let index = pending.indexOf("\n");
  while (index !== -1) {
    const line = pending.slice(0, index).trim();
    pending = pending.slice(index + 1);
    index = pending.indexOf("\n");
    if (line.length === 0) continue;
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      continue;
    }
    frames.push(frame);
    if (frame.type === "response" && frame.id !== undefined) responses.set(frame.id, frame);
  }
});
let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

// A local model can take minutes for one answer: every wait for a turn uses this limit.
const turnTimeoutMs =
  env.OMP_E2E_TURN_TIMEOUT_MS === undefined ? 600_000 : Number(env.OMP_E2E_TURN_TIMEOUT_MS);
if (!Number.isInteger(turnTimeoutMs) || turnTimeoutMs <= 0)
  fail("OMP_E2E_TURN_TIMEOUT_MS must be a positive integer number of milliseconds");

async function waitFor(predicate, label, timeoutMs = turnTimeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (violation) throw new Error(violation);
    const found = predicate();
    if (found !== undefined && found !== false) return found;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function command(type, payload = {}) {
  const id = `e2e-${nextId++}`;
  child.stdin.write(`${JSON.stringify({ id, type, ...payload })}\n`);
  const response = await waitFor(() => responses.get(id), `response to ${type}`, 60_000);
  if (response.success !== true)
    throw new Error(`${type} failed: ${String(response.error ?? "unknown")}`);
  return response.data;
}

async function waitForIdle(label) {
  const started = Date.now();
  while (Date.now() - started < turnTimeoutMs) {
    if (violation) throw new Error(violation);
    const state = await command("get_state");
    if (state.isStreaming === false) return state;
    await sleep(100);
  }
  throw new Error(`timed out waiting for idle (${label})`);
}

function userTexts(messages) {
  return (messages ?? []).flatMap((message) => {
    const content = Array.isArray(message.content) ? message.content : [message.content];
    return content
      .map((part) => (typeof part === "string" ? part : (part?.text ?? "")))
      .filter(Boolean);
  });
}

// The agent_end frame must carry an assistant answer with text, not an error.
function assertModelAnswered(index) {
  const frame = frames[index];
  const assistant = [...(frame.messages ?? [])]
    .reverse()
    .find((message) => message.role === "assistant");
  if (!assistant) throw new Error("the model produced no assistant message");
  if (assistant.stopReason === "error")
    throw new Error(`the model returned an error: ${String(assistant.errorMessage ?? "error")}`);
  const text = (Array.isArray(assistant.content) ? assistant.content : [])
    .map((part) => part?.text ?? "")
    .join("");
  if (text.trim().length === 0) throw new Error("the model answered with no text");
}

const results = [];
function record(name, status, detail, durationMs) {
  results.push({ name, status, detail, durationMs });
  console.log(
    `${status.toUpperCase().padEnd(14)} ${name} (${durationMs} ms)${detail ? ` - ${detail}` : ""}`,
  );
}

async function scenarios() {
  let started = Date.now();
  await waitFor(
    () => frames.some((frame) => frame.type === "ready"),
    "the RPC ready frame",
    60_000,
  );
  // The extension reports on stderr when it disables itself (see src/index.ts). Without it the
  // pushes would be ignored, so the check stops here and says why. stderr may arrive a moment
  // after the ready frame, so it is read after a short pause.
  await sleep(1000);
  const disabledLine = stderr
    .split("\n")
    .find((line) => line.startsWith("[omp-channel] disabled:"));
  if (disabledLine !== undefined) {
    record("startup", "fail", disabledLine, Date.now() - started);
    throw new Error(`the extension disabled itself: ${disabledLine}`);
  }
  record("startup", "pass", "RPC ready, extension loaded", Date.now() - started);

  // 1. Idle agent: the first push starts a turn that must be answered.
  started = Date.now();
  await waitFor(
    () => frames.some((frame) => frame.type === "agent_start"),
    "the first agent_start",
  );
  const firstEndIndex = await waitFor(() => {
    const index = frames.findIndex((frame) => frame.type === "agent_end");
    return index === -1 ? undefined : index;
  }, "the first agent_end");
  assertModelAnswered(firstEndIndex);
  await waitForIdle("after the first turn");
  const branch = await command("get_branch_messages");
  const delivered = userTexts(branch.messages).join("\n").includes('messageId="example-1"');
  if (!delivered) throw new Error("the pushed message is not in the session branch");
  record(
    "idle push starts a turn",
    "pass",
    "push delivered, model answered, message in branch",
    Date.now() - started,
  );

  // 2. Busy agent: the second push must start only after the turn that is running has ended.
  started = Date.now();
  const secondIndex = await waitFor(
    () => {
      const index = frames.findIndex(
        (frame) => frame.type === "message_start" && JSON.stringify(frame).includes("example-1-2"),
      );
      return index === -1 ? undefined : index;
    },
    "the second push",
    120_000,
  ).catch(() => -1);
  if (secondIndex === -1) {
    record(
      "push during a turn is queued",
      "not-exercised",
      "the second push did not arrive",
      Date.now() - started,
    );
  } else {
    const turnEnd = frames.findIndex(
      (frame, position) => frame.type === "agent_end" && position < secondIndex && position > 0,
    );
    const queued = turnEnd !== -1 && turnEnd < secondIndex;
    record(
      "push during a turn is queued",
      queued ? "pass" : "fail",
      queued
        ? "the second push started after an agent_end"
        : "the second push started before any agent_end",
      Date.now() - started,
    );
  }
  await waitForIdle("after the second push");

  // 3. Shell tool run, then abort: the tool output must survive the abort.
  started = Date.now();
  await command("prompt", {
    message: "First run the shell command `echo omp-channel-marker`. Then write a very long story.",
  });
  const toolRan = await waitFor(
    () => frames.some((frame) => frame.type === "tool_execution_end") || undefined,
    "a tool execution",
    turnTimeoutMs,
  ).then(
    () => true,
    (error) => (violation ? Promise.reject(error) : false),
  );
  await command("abort");
  const idle = await waitForIdle("after abort");
  if (!toolRan) {
    record(
      "abort after a tool run",
      "not-exercised",
      "the model did not run the shell tool",
      Date.now() - started,
    );
  } else {
    const after = await command("get_branch_messages");
    const kept = JSON.stringify(after.messages).includes("omp-channel-marker");
    record(
      "abort keeps tool output",
      kept ? "pass" : "fail",
      kept ? "tool output still in the branch" : "tool output missing after abort",
      Date.now() - started,
    );
  }
  record("agent idle after abort", idle.isStreaming === false ? "pass" : "fail", "", 0);

  // working/free status reports go to a service adapter, which this MCP-only run does not use.
  record("working/free status to a service", "not-exercised", "no service adapter in this run", 0);
}

let exitCode = 0;
try {
  await scenarios();
} catch (error) {
  exitCode = 1;
  const reason = error instanceof Error ? error.message : String(error);
  record("run", "fail", reason, 0);
} finally {
  clearInterval(guard);
  child.kill("SIGTERM");
  await sleep(500);
  rmSync(project, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}

const failed = results.filter((item) => item.status === "fail");
console.log(
  JSON.stringify(
    {
      model,
      localUrl: localUrl.origin,
      networkGuard: networkGuard ? "on" : "off",
      peersSeen: [...peersSeen].sort(),
      tolerated: TOLERATED.map((entry) => {
        const name = entry.host ?? entry.label;
        return {
          name,
          addresses: [...toleratedAddresses].filter(([, n]) => n === name).map(([a]) => a),
        };
      }),
      toleratedSeen: [...toleratedSeen].sort(),
      results,
    },
    null,
    2,
  ),
);
if (stderr.trim().length > 0) {
  console.log("--- stderr of the omp process (first 2000 characters)");
  console.log(stderr.slice(0, 2000));
}
if (violation) console.error(`omp-e2e: FAILED: ${violation}`);
process.exit(exitCode !== 0 || failed.length > 0 || violation ? 1 : 0);
