#!/usr/bin/env node
// Real Oh My Pi check for omp-channel (see docs/omp-verification.md).
//
// It starts Oh My Pi in RPC mode with this extension and the example MCP server, then checks:
//   1. an MCP push reaches an idle agent and starts a turn;
//   2. a push that arrives during a turn is queued as a follow-up, after the turn ends;
//   3. abort stops the turn, and tool results produced before it are kept.
//
// It needs a model and runs a real turn, so it does nothing unless you ask for it:
//   OMP_E2E=1 OMP_E2E_MODEL=<provider/model> npm run omp:e2e
// Optional: OMP_E2E_CLI (path to the Oh My Pi cli.js; default: the devDependency) and
// OMP_E2E_BUN (Bun >= 1.4.4; default: "bun"). It never sends anything to a service: the only
// peer is the example MCP server on this machine. The model is whatever you pass.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const env = process.env;

if (env.OMP_E2E !== "1") {
  console.log(
    "skipped: set OMP_E2E=1 and OMP_E2E_MODEL=<provider/model> to run the Oh My Pi check",
  );
  process.exit(0);
}

function fail(message) {
  console.error(`omp-e2e: ${message}`);
  process.exit(2);
}

const model = env.OMP_E2E_MODEL;
if (!model) {
  fail("OMP_E2E_MODEL is required. The check never uses the default model.");
}
const bun = env.OMP_E2E_BUN ?? "bun";
const cli = env.OMP_E2E_CLI ?? join(root, "node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js");
const extension = join(root, "dist/index.js");
const server = join(root, "examples/mcp-server/server.mjs");
if (!existsSync(extension)) fail("dist/index.js is missing: run npm run build first");
if (!existsSync(cli)) fail(`Oh My Pi cli.js not found at ${cli}`);

const project = mkdtempSync(join(tmpdir(), "omp-channel-e2e-"));
mkdirSync(join(project, ".omp"));
writeFileSync(
  join(project, ".omp", "mcp.json"),
  JSON.stringify({ mcpServers: { "omp-channel": { command: process.execPath, args: [server] } } }),
);

const child = spawn(
  bun,
  [cli, "--mode", "rpc", "--no-session", "--cwd", project, "--model", model, "-e", extension],
  {
    cwd: project,
    env: {
      ...env,
      OMP_CHANNEL_CONFIG: "",
      EXAMPLE_CHANNEL_SECOND_AFTER_MS: env.OMP_E2E_SECOND_AFTER_MS ?? "1500",
    },
    stdio: ["pipe", "pipe", "pipe"],
  },
);

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
child.stderr.setEncoding("utf8");
let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, label, timeoutMs = 180_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const found = predicate();
    if (found !== undefined && found !== false) return found;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function command(type, payload = {}) {
  const id = `e2e-${nextId++}`;
  child.stdin.write(`${JSON.stringify({ id, type, ...payload })}\n`);
  const response = await waitFor(() => responses.get(id), `response to ${type}`, 30_000);
  if (response.success !== true) throw new Error(`${type} failed: ${response.error ?? "unknown"}`);
  return response.data;
}

function userTexts(messages) {
  return (messages ?? []).flatMap((message) => {
    const content = Array.isArray(message.content) ? message.content : [message.content];
    return content
      .map((part) => (typeof part === "string" ? part : (part?.text ?? "")))
      .filter(Boolean);
  });
}

const results = [];
function record(name, status, detail) {
  results.push({ name, status, detail });
  console.log(`${status.toUpperCase().padEnd(15)} ${name}${detail ? ` - ${detail}` : ""}`);
}

function indexOfFrame(predicate, from = 0) {
  for (let index = from; index < frames.length; index += 1) {
    if (predicate(frames[index])) return index;
  }
  return -1;
}

async function waitForIdle(label) {
  for (let attempt = 0; attempt < 1800; attempt += 1) {
    const state = await command("get_state");
    if (state.isStreaming === false) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for idle (${label})`);
}

async function run() {
  await waitFor(
    () => frames.some((frame) => frame.type === "ready"),
    "the RPC ready frame",
    60_000,
  );
  record("startup", "pass", "RPC ready");

  // 1 and 2: the first push starts a turn; the second push (sent 1.5 s later) arrives while it may run.
  await waitFor(
    () => frames.some((frame) => frame.type === "agent_start"),
    "the first agent_start",
  );
  const firstEnd = await waitFor(() => {
    const index = frames.findIndex((frame, position) => frame.type === "agent_end" && position > 0);
    return index === -1 ? undefined : index;
  }, "the first agent_end");
  await waitForIdle("after the first turn");
  const branch = await command("get_branch_messages");
  const texts = userTexts(branch.messages).join("\n");
  record(
    "MCP push starts a turn",
    texts.includes('messageId="example-1"') ? "pass" : "fail",
    "the first message is in the branch",
  );
  const secondIndex = frames.findIndex(
    (frame) => frame.type === "message_start" && JSON.stringify(frame).includes("example-1-2"),
  );
  if (secondIndex < 0) {
    record(
      "push during a turn is queued after it",
      "not-exercised",
      "no message_start for the second push was seen",
    );
  } else {
    record(
      "push during a turn is queued after it",
      secondIndex > firstEnd ? "pass" : "fail",
      secondIndex > firstEnd
        ? "the second push starts after the first agent_end"
        : "the second push started during the first turn",
    );
  }

  // 3: abort during a tool run keeps the tool result.
  await command("prompt", {
    message: "First run the shell command `echo omp-channel-marker`. Then write a very long story.",
  });
  const toolRan = await waitFor(
    () => frames.some((frame) => frame.type === "tool_execution_end") || undefined,
    "a tool execution (the model may not call a tool)",
    120_000,
  ).then(
    () => true,
    () => false,
  );
  await command("abort");
  await waitForIdle("after the abort");
  if (!toolRan) {
    record(
      "abort keeps tool results",
      "not-exercised",
      "the model did not run a tool before the abort",
    );
  } else {
    const after = await command("get_branch_messages");
    const kept = JSON.stringify(after.messages).includes("omp-channel-marker");
    record(
      "abort keeps tool results",
      kept ? "pass" : "fail",
      "the marker output is still in the branch",
    );
  }
  const state = await command("get_state");
  record("agent is idle after abort", state.isStreaming === false ? "pass" : "fail", "");
}

let exitCode = 0;
try {
  await run();
} catch (error) {
  exitCode = 1;
  record("run", "fail", error instanceof Error ? error.message : String(error));
} finally {
  child.kill("SIGTERM");
  await sleep(500);
  rmSync(project, { recursive: true, force: true });
}

const failed = results.filter((item) => item.status === "fail");
console.log(JSON.stringify({ model, results }, null, 2));
if (stderr.trim().length > 0) {
  console.log("--- stderr of the Oh My Pi process (first 2000 characters)");
  console.log(stderr.slice(0, 2000));
}
process.exit(exitCode !== 0 || failed.length > 0 ? 1 : 0);
