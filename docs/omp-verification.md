# Verification in a real Oh My Pi session

The automated tests (`npm test`) run omp-channel against fakes and against a loopback service.
They do not start Oh My Pi. This document lists what was checked in a real Oh My Pi session, how
to repeat the checks, and what is still open. Until the open items are closed, the package is not
published.

Oh My Pi version under test: **19.2.1** (devDependency `@oh-my-pi/pi-coding-agent`, exact version).
Oh My Pi needs **Bun 1.4.4 or later** at runtime.

## Status

| Check                                                                   | Status       | How it was checked                                                                                                                              |
| ----------------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Oh My Pi starts in RPC mode with `-e dist/index.js`                     | verified     | RPC `ready` frame received                                                                                                                      |
| The extension module is loaded and its default export runs              | verified     | Oh My Pi printed `[omp-channel] disabled: ...` on stderr when the configuration path did not exist; that line comes only from the loaded module |
| MCP server connects and `mcp_notification` reaches the extension        | not verified | the run stopped before any turn (see "Last real run")                                                                                           |
| First push starts a turn on an idle agent                               | not verified | scenario 1: not reached, see "Last real run"                                                                                                    |
| Push during a running turn is queued as follow-up (not steer)           | not verified | scenario 2: not reached                                                                                                                         |
| `sendUserMessage` attribution values (`user`, `agent`) and their effect | open point   | see below                                                                                                                                       |
| `abort` stops the turn and keeps tool results                           | not verified | scenario 3: not reached                                                                                                                         |
| Agent status (`working`/`free`) reported to a service                   | not verified | needs a service; not part of the script                                                                                                         |
| Plain JSON Schema tool parameters accepted by Oh My Pi                  | not verified | see "Tool parameter schema" below                                                                                                               |

## How to run the check

Prerequisites: an `omp` command (Oh My Pi 19.2.1) on the PATH with its default configuration, Bun 1.4.4 or later for it, `npm ci`, `npm run build`, and the model you choose.

```sh
OMP_E2E=1 OMP_E2E_MODEL=<provider/model-id> OMP_E2E_BUN_DIR=<folder with bun 1.4.4> npm run omp:e2e
```

- Without `OMP_E2E=1` the script does nothing and exits 0.
- Without `OMP_E2E_MODEL` it refuses to run, so the default model is never used.
- The script starts `omp` (`OMP_E2E_OMP` changes the command) in RPC mode, with the default
  configuration of the machine, unchanged. It adds only the extension, a temporary project with the
  example MCP server, `OMP_CHANNEL_CONFIG` empty, and `OMP_E2E_BUN_DIR` (a folder put first on the PATH
  of the `omp` process, to provide Bun 1.4.4 without changing the system Bun).
- A network guard checks every TCP connection of the `omp` process tree every 300 ms. On the first
  connection to a non-loopback address it stops `omp` and fails the run. A run that fails this way
  is not a pass for any scenario.
- The script never edits the configuration. The default configuration of a machine can contain
  remote fallbacks, web search endpoints and Oh My Pi's automatic update check. These are
  deliberate choices of the machine owner and the script does not change or disable them.
  Because the guard stops the run on any non-loopback connection, a default configuration with
  the update check enabled cannot pass the guard; see "Open decision: the network guard".

The script prints one line per check (`pass`, `fail` or `not-exercised`) and a JSON summary.

### Last real run

Command: `OMP_E2E=1 OMP_E2E_MODEL=<provider/model-id> OMP_E2E_BUN_DIR=<folder with bun 1.4.4> npm run omp:e2e`
(Oh My Pi 19.2.1, the default configuration, a local model endpoint).

| Check               | Result       | Duration | What was observed                                                    |
| ------------------- | ------------ | -------- | -------------------------------------------------------------------- |
| startup             | pass         | 807 ms   | RPC `ready` frame received                                           |
| run (scenarios 1-3) | fail (guard) | 0 ms     | `omp` connected to a non-loopback address (port 443) before any turn |

Other loopback peers seen: the model endpoint and one local port that was not identified. Earlier
runs of the same script stopped the same way, on another non-loopback address (port 443). The
connection is Oh My Pi's automatic update check, which is enabled on purpose in that configuration
(information from the maintainer, not observed by the script). It happens before any scenario. No
scenario was executed, so the model answer, delivery, ack, branch response, `working`/`free` status
and `abort` remain not verified.

### Open decision: the network guard

The guard was written to protect a machine from unexpected traffic. The update check is expected,
so with that configuration the guard always stops the run before the first scenario. The options
for the maintainer are: run the check with an Oh My Pi configuration that has the update check off
(a separate configuration, not an edit of the default one), or add an explicit, opt-in allowlist
of expected remote hosts to the script, listed in its output. Neither is implemented yet, because
it changes what the guard protects against.

### Scenarios

1. **Idle delivery.** The example server pushes `example-1` after startup. The script waits for
   the first turn and checks that the message is in the branch.
2. **Busy delivery.** The example server pushes `example-1-2` 1.5 seconds later
   (`OMP_E2E_SECOND_AFTER_MS` changes the delay). The script checks that its `message_start` comes
   after the first `agent_end`. If the model finishes before the second push, the result is
   `not-exercised`, not a pass.
3. **Abort.** The script asks for a shell command and a long answer, then sends `abort`. It checks
   that the agent becomes idle and that the tool output is still in the branch, if a tool ran.

## Open point: `attribution`

`attribution` is required on every message. omp-channel passes it unchanged to
`sendUserMessage`. The effect of `"user"` and `"agent"` in Oh My Pi is not verified: it may change
how the turn is recorded or billed. To close the point:

1. Run the script once with a message whose `attribution` is `"user"`, and once with `"agent"`
   (the example server uses `"agent"`; change `attribution` in `examples/mcp-server/server.mjs` for
   the other run).
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

Do not publish a release until every row above that is marked open or not verified is verified,
or the README states the gap explicitly.
