# Verification in a real Oh My Pi session

The automated tests (`npm test`) run omp-channel against fakes and against a loopback service.
They do not start Oh My Pi. This document lists what was checked in a real Oh My Pi session, how
to repeat the checks, and what is still open. Until the open items are closed, the package is not
published.

Oh My Pi version under test: **19.2.1** (devDependency `@oh-my-pi/pi-coding-agent`, exact version).
Oh My Pi needs **Bun 1.4.4 or later** at runtime. On 26/11/2026 the system Bun was upgraded to 1.4.5.

## Status

| Check                                                            | Status       | How it was checked                                                                      |
| ---------------------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------- |
| Oh My Pi starts in RPC mode with `-e dist/index.js`              | verified     | RPC `ready` frame received                                                              |
| The extension loads and runs with a valid configuration          | not verified | the check does not capture the extension's stderr yet; see "Last real run"              |
| MCP server connects and `mcp_notification` reaches the extension | not verified | the run stopped before any turn; see "Last real run"                                    |
| First push starts a turn on an idle agent                        | not verified | scenario 1: not reached                                                                 |
| Push during a running turn is queued as follow-up (not steer)    | not verified | scenario 2: not reached                                                                 |
| `attribution` values (`user`, `agent`): the example uses `user`  | decided      | the value is a contract choice; its effect in Oh My Pi is open, see "Attribution" below |
| Effect of `attribution` in Oh My Pi                              | not verified | needs a run with each value; see "Attribution" below                                    |
| `abort` stops the turn and keeps tool results                    | not verified | scenario 3: not reached                                                                 |
| Agent status (`working`/`free`) reported to a service            | not verified | needs a service; not part of the script                                                 |
| Plain JSON Schema tool parameters accepted by Oh My Pi           | not verified | see "Tool parameter schema" below                                                       |

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
- A network guard checks every TCP connection of the `omp` process tree every 300 ms. On the first
  connection to a non-loopback address it stops `omp` and fails the run. A run that fails this way
  is not a pass for any scenario.
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
status and `abort` remain not verified. Earlier runs stopped the same way on `104.26.10.114:443`.

A single prompt turn with the local model completed in about 100 seconds, so a slow answer is not
the cause of the failures.

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
