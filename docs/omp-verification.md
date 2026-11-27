---
title: Verification in Oh My Pi
description: What was verified in a real Oh My Pi session, and what was not.
---

# Verification in a real Oh My Pi session

The automated tests (`npm test`) run omp-channel against fakes and against a loopback service.
They do not start Oh My Pi. This document lists what was checked in a real Oh My Pi session, how
to repeat the checks, and what is still open. Until the open items are closed, the package is not
published.

Oh My Pi version under test: **19.2.1** (devDependency `@oh-my-pi/pi-coding-agent`, exact version).
Oh My Pi needs **Bun 1.4.4 or later** at runtime. On 26/11/2026 the system Bun was upgraded to 1.4.5.

## Status

| Check                                                                         | Status       | How it was checked                                                                      |
| ----------------------------------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------- |
| Oh My Pi starts in RPC mode with `-e dist/index.js`                           | verified     | RPC `ready` frame received                                                              |
| The extension loads and runs with a valid configuration                       | verified     | startup of 27/11/2026: extension loaded, no `disabled` line on stderr                   |
| MCP server connects and `mcp_notification` reaches the extension              | verified     | scenarios 1-3 of 27/11/2026: the pushes arrived as `message_start` frames               |
| First push starts a turn on an idle agent                                     | verified     | scenario 1, run of 27/11/2026: pass, message in the session branch                      |
| Push during a running turn is taken at a turn boundary (docs/protocol.md 3.5) | verified     | scenario 2, run of 27/11/2026: pass                                                     |
| `attribution` values (`user`, `agent`): the example uses `user`               | decided      | the value is a contract choice; its effect in Oh My Pi is open, see "Attribution" below |
| Effect of `attribution` in Oh My Pi                                           | not verified | needs a run with each value; see "Attribution" below                                    |
| `abort` stops the turn and keeps tool results                                 | verified     | scenario 3, run of 27/11/2026: pass, agent idle after abort                             |
| Agent status (`working`/`free`) reported to a service                         | not verified | needs a service; not part of the script                                                 |
| Plain JSON Schema tool parameters accepted by Oh My Pi                        | not verified | see "Tool parameter schema" below                                                       |

## How to run the check

Prerequisites: an `omp` command (Oh My Pi 19.2.1) on the PATH, Bun 1.4.4 or later on the PATH (or
in `OMP_E2E_BUN_DIR`), `npm ci`, `npm run build`, and the model you choose.

```sh
OMP_E2E=1 OMP_E2E_MODEL=<provider/model-id> npm run omp:e2e
```

- Without `OMP_E2E=1` the script does nothing and exits 0.
- Without `OMP_E2E_MODEL` it refuses to run, so the default model is never used.
- The script starts `omp` (`OMP_E2E_OMP` changes the command) in RPC mode. It adds only the
  extension, a temporary project with the example MCP server and an MCP-only omp-channel
  configuration (`OMP_CHANNEL_CONFIG` points to it), and the flag `--no-spotlight`. Optional:
  `OMP_E2E_BUN_DIR` (a folder put first on the PATH of the `omp` process) and `OMP_E2E_CONFIG` (an
  overlay file passed as `--config`).
- `OMP_E2E_TURN_TIMEOUT_MS` sets how long each wait for a turn may last (default 600000 ms). A
  local model can take minutes for one answer, so the default is longer than a typical turn.
- `OMP_E2E_CONFIG` is an overlay for this run only. Oh My Pi still loads the machine's
  configuration underneath it, so the providers stay the same. The script never writes it.
- The network guard is **off by default** (decision of 26/11/2026). It is enabled with
  `OMP_E2E_NETWORK_GUARD=1`. When on, it checks every TCP connection of the `omp` process tree every
  300 ms and, on the first connection to a non-loopback address, stops `omp` and fails the run. The
  entries of `TOLERATED` in the script apply only while it is on. With the guard off, the run is not
  restricted at the network level: it can reach any remote host that `omp` contacts.
- The machine's configuration is not edited. It keeps its remote fallbacks, web search endpoints,
  the spotlight service and the automatic update check, which are deliberate choices of the machine
  owner. The run adds `--no-spotlight` because the spotlight service (`spotlight.url`) was seen
  opening remote connections during a turn. Any other remote connection still fails the run.

The script prints one line per check (`pass`, `fail` or `not-exercised`) and a JSON summary.

### Last real run

Command: `OMP_E2E=1 OMP_E2E_MODEL=unsloth/inkling-2-mini-unsloth:UD-Q4_K_XL npm run omp:e2e`
(Oh My Pi 19.2.1, the machine's configuration, a local model endpoint, system Bun 1.4.5).

| Check               | Result       | Duration | What was observed                                          |
| ------------------- | ------------ | -------- | ---------------------------------------------------------- |
| startup             | pass         | 909 ms   | RPC `ready` frame received                                 |
| run (scenarios 1-3) | fail (guard) | 0 ms     | `omp` connected to `172.67.75.165:443` before any scenario |

No scenario was executed, so the model answer, delivery, ack, branch response, `working`/`free`
status and `abort` remain not verified.

A single prompt turn with the local model completed in about 100 seconds, so a slow answer is not
the cause of the failures.

### First real results with a fresh home (26/11/2026, guard off)

| Check                            | Result                     | What was observed                                                                              |
| -------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------- |
| startup                          | pass                       | RPC ready, extension loaded                                                                    |
| idle push starts a turn          | pass                       | the push was delivered, the model answered, the message is in the session branch               |
| push during a turn is queued     | fail (check, before 27/11) | the second message entered the same agent run at a turn boundary, before the final `agent_end` |
| abort keeps tool output          | pass                       | the tool output stayed in the branch and the agent became idle                                 |
| working/free status to a service | not exercised              | no service adapter in this run                                                                 |

The queued message was not lost and was not inserted in the middle of a tool call. The check
expected it after the final `agent_end`, which is not how `followUp` behaves in Oh My Pi 19.2.1: the
message was taken at a turn boundary of the same run. Whether this is the queueing the extension
must provide is a decision about the expected behaviour, and it is open; the check's criterion has
not been changed yet.

### Run with the queueing contract (27/11/2026, guard off)

Command: `OMP_E2E=1 OMP_E2E_MODEL=unsloth/inkling-2-mini-unsloth:UD-Q4_K_XL npm run omp:e2e`.
The check now follows the contract in docs/protocol.md section 3.5: a push made while busy is taken
at a turn boundary (`turn_end` or `agent_end`) and never inside a tool call. The criterion of the
earlier run (after the final `agent_end`) was not the contract and was replaced.

| Check                            | Result        |
| -------------------------------- | ------------- |
| startup                          | pass          |
| idle push starts a turn          | pass (34.8 s) |
| push during a turn is queued     | pass          |
| abort keeps tool output          | pass          |
| agent idle after abort           | pass          |
| working/free status to a service | not exercised |

### Run with the tool-declaring server and a fresh home (26/11/2026)

The example server now declares one tool (`example_status`) and the `tools` capability. In a fresh
home, the server stayed connected for more than 30 seconds, and the push started a turn (`agent_start`
and `agent_end`) in a manual probe. The check now uses a new home for each run and links the
machine's `models.yml`, so the cached tool list of the machine is not used.

The check reached the model and stopped there: the provider answered `401 Invalid token payload`.
The model's credentials are not in `models.yml`, and the fresh home does not have them. Reading the
machine's credential store to copy them was refused by the permission check, so this was not
resolved. No scenario has run.

### Latest run with the guard off (26/11/2026)

With `OMP_E2E_NETWORK_GUARD` unset (guard off), the startup passed with the extension loaded. The
first scenario did not start: no `agent_start` arrived within the turn timeout, so the example
server's push did not start a turn. A probe found that `omp` does not start the example MCP server
from the project's `.omp/mcp.json` in RPC mode: no server process appears during the session, both
with the shared MCP daemon (default) and with `mcp.shared: false`. The cause is not identified yet;
the next step is to find how `omp` loads MCP servers for an RPC session (configuration location,
trust of the project folder, or the global `mcp.json`). Until then, no scenario has run.

### Status: blocked by the network guard (26/11/2026)

The check cannot pass on this machine as configured. At startup, before any scenario, `omp`
opens connections to many remote addresses, and the set changes between runs. Seen across runs:

- `catalog.stencil.so` (tolerated on purpose; its addresses are `104.26.10.114`, `104.26.11.114`,
  `172.67.75.165`).
- Not tolerated, and the guard stops on the first one: `140.82.113.22` (GitHub), `142.251.141.243`
  (Google), `54.230.183.54` (AWS), `43.106.123.215`, `43.98.246.135`, `64.239.123.65`,
  `104.18.10.160`, `104.18.28.226`, `104.26.8.108`.

Two checks did not change the result. A home folder with a minimal configuration (updates,
telemetry, web search and fallbacks off) still shows the same kind of connections, so they do not
come from the user's configuration. The tolerated list is per address, and the addresses are shared
behind CDNs, so it cannot be made complete by adding entries one run at a time.

This status was recorded while the guard was on. Since the decision to make it optional, the
scenarios can run without it. They have not been run to completion yet: the next run must show the
scenario results, with the guard off, and say which remote hosts `omp` contacted.

### Source of the remote connections

The source is not identified. What was measured on 26/11/2026, one prompt turn per row:

| Run                                   | Remote connection during the turn |
| ------------------------------------- | --------------------------------- |
| baseline (overlay with update off)    | yes, `172.67.75.165:443`          |
| `--offline --no-spotlight --no-judge` | none                              |
| `--no-spotlight`                      | none                              |
| `--no-judge`                          | yes, `104.26.10.114:443`          |

`spotlight.url` points to `cloud.stencil.so`, which resolves to both addresses. The table is not a
proof: each row is a single run, and `--no-spotlight` only restricts the spotlight calls to the
model's provider (the flag's own description); it does not disable them. Startup-only traces were
also inconsistent: the same configuration showed `104.26.10.114` in some runs and nothing in others.
An earlier reading attributed `104.26.10.114` to the update check; that reading was wrong, because
the update overlay did not remove it.

### Setup fault (fixed)

The script used to set `OMP_CHANNEL_CONFIG` to an empty value. The extension then found no
configuration and disabled itself before the first push, so earlier runs never exercised it. The
script now writes an MCP-only configuration in the temporary project and sets `OMP_CHANNEL_CONFIG`
to it.

### Scenarios

1. **Idle delivery.** The example server pushes `example-1` after startup. The script waits for
   the first turn and checks that the message is in the branch.
2. **Busy delivery.** The example server pushes `example-1-2` 1.5 seconds later
   (`OMP_E2E_SECOND_AFTER_MS` changes the delay). The script checks that its `message_start` comes
   after the first `agent_end`. If the model finishes before the second push, the result is
   `not-exercised`, not a pass.
3. **Abort.** The script asks for a shell command and a long answer, then sends `abort`. It checks
   that the agent becomes idle and that the tool output is still in the branch, if a tool ran.

## Attribution

`attribution` is required on every message and omp-channel passes it unchanged to
`sendUserMessage`. The example server sends `"user"`, because it stands for text a person wrote in
the console. The contract does not choose a value for the service.

The effect of `"user"` and `"agent"` in Oh My Pi is not verified: it may change how the turn is
recorded or billed. To verify it:

1. Run the check once with the example set to `"user"` and once with `"agent"` (change
   `attribution` in `examples/mcp-server/server.mjs` for the second run).
2. In the Oh My Pi session output and in the provider usage record, find how each turn is
   initiated. Compare the two runs.
3. Write the result here and in `docs/protocol.md` section 3.4. Only then may a default be
   documented.

## Tool parameter schema

`src/tool-schema.ts` passes a plain JSON Schema object where Oh My Pi declares a TypeBox schema.
The reply tool is accepted only if Oh My Pi validates it at runtime. This is checked by starting a
session with the extension and confirming that the `reply` tool is listed and its parameters are
validated (a call with a missing `messageId` must be rejected by Oh My Pi, not by the extension).

## Publication gate

Do not publish a release until every row above that is marked not verified is verified, or the
README states the gap explicitly.

## Install from the registry (27/11/2026, version 0.1.0)

Run in a scratch home, not in the maintainer's Oh My Pi configuration:

- `omp install omp-channel` installed `omp-channel@0.1.0` from npm into the plugin folder
  (`~/.omp/plugins/node_modules`).
- A session started with that home and no `-e` flag listed the `channel-status` command.

Not checked here: a session with a configuration file and a live service after the registry
install. The checks above that use `-e` still describe the clone setup.

## Failed turn (27/11/2026, Oh My Pi 19.2.1)

Method: a small OpenAI-compatible endpoint on loopback that refuses every model request, selected
with `LLAMA_CPP_BASE_URL`; `omp --mode rpc` with the built extension and a test adapter module
that yields one message and records the calls. No real model ran.

| Case                        | Result | Observed                                                                                                      |
| --------------------------- | ------ | ------------------------------------------------------------------------------------------------------------- |
| refused request (404)       | pass   | one `agent_end` with `stopReason: "error"`; one `failure` call with the message id and the error, then `free` |
| retried request (503), 40 s | pass   | `agent_end` with `willContinue: true` after each attempt; the state stayed `working`, no `failure` call       |

Not verified: the report after Oh My Pi gives up on a retried request (the run was stopped during
the retries; unit tests cover the logic), the interactive terminal interface (RPC mode only), and
the `failure` call of the HTTP transport against a real service.

## Reply tool (27/11/2026, Oh My Pi 19.2.1, RPC mode)

Method: a loopback endpoint that records the tools of each model request, then one run with a local
model; a test adapter module and a stand-in service.

| Case                           | Result | Observed                                                                |
| ------------------------------ | ------ | ----------------------------------------------------------------------- |
| tools sent to the model, 0.2.0 | fail   | built-in tools only: `reply` was missing (extension tools are deferred) |
| tools sent to the model, fixed | pass   | `reply` is listed with the built-in tools                               |
| local model answers a message  | pass   | the model called `reply`; the service received the text, then `free`    |

Not verified: a real model that ends without calling `reply` (unit tests cover the report), and the
interactive terminal interface.
