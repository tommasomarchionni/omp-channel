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
| MCP server connects and `mcp_notification` reaches the extension        | not verified | needs a model turn or a log that shows admission                                                                                                |
| First push starts a turn on an idle agent                               | not verified | `test/omp-e2e/run.mjs`, scenario 1                                                                                                              |
| Push during a running turn is queued as follow-up (not steer)           | not verified | scenario 2                                                                                                                                      |
| `sendUserMessage` attribution values (`user`, `agent`) and their effect | open point   | see below                                                                                                                                       |
| `abort` stops the turn and keeps tool results                           | not verified | scenario 3                                                                                                                                      |
| Agent status (`working`/`free`) reported to a service                   | not verified | needs a service; not part of the script                                                                                                         |
| Plain JSON Schema tool parameters accepted by Oh My Pi                  | not verified | see "Tool parameter schema" below                                                                                                               |

Notes from the first probes (no prompt was sent by the probes):

- An RPC probe started Oh My Pi with the user's environment. Oh My Pi chose a remote default model
  (a Hugging Face router). No turn events were seen within 20 seconds, but a turn may have been
  started by the pushed test message, and the probe did not check for provider requests. The
  provider's usage log for that time should be checked.
- A second probe used an isolated `HOME` with no credentials. Oh My Pi then chose a local
  `llama.cpp` model at `127.0.0.1:8080`, which was listening. No turn events were seen within 15
  seconds.

## How to run the check

Prerequisites: Bun 1.4.4 or later, `npm ci`, `npm run build`, and a model that you choose.

```sh
OMP_E2E=1 OMP_E2E_MODEL=<provider/model> npm run omp:e2e
```

- Without `OMP_E2E=1` the script does nothing and exits 0.
- Without `OMP_E2E_MODEL` it refuses to run, so the default model is never used.
- `OMP_E2E_BUN` selects the Bun binary; `OMP_E2E_CLI` selects another Oh My Pi `cli.js`.
- The script starts the example MCP server on this machine. It contacts no other host itself, but
  the model you select may be a remote service, and a turn is a paid request in that case.

The script prints one line per check (`pass`, `fail` or `not-exercised`) and a JSON summary.

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
