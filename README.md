# omp-channel

[![CI](https://github.com/tommasomarchionni/omp-channel/actions/workflows/ci.yml/badge.svg)](https://github.com/tommasomarchionni/omp-channel/actions/workflows/ci.yml)

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
![Node.js 20+](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)

Documentation: <https://tommasomarchionni.github.io/omp-channel/>

**omp-channel** is an extension for [Oh My Pi](https://github.com/can1357/oh-my-pi) (OMP), a
terminal agent harness. It delivers messages from an external service (any system that exchanges messages
with a person) into an agent session, and sends the agent's replies
back to that service.

It is for people who run an agent in a terminal and want an outside service to be able to send
it work and receive the answers, including while the agent is busy. It is **not** a hosting
service, it contains **no models**, and it does **not** manage accounts. You provide the service
and the model; omp-channel is the link between them.

> **Status: alpha, version 0.1.0 on npm.** The behaviour is covered by automated tests that use fakes and
> a loopback HTTP service. Startup, delivery to an idle session, queueing during a turn and abort
> have passed in a live Oh My Pi session; the status report and the attribution values are not yet
> verified. See
> [docs/omp-verification.md](docs/omp-verification.md) for each check and what is open.

## Contents

- [How it works](#how-it-works)
- [Connect a service in three steps](#connect-a-service-in-three-steps)
- [Complete example](#complete-example)
- [Configuration](#configuration)
- [Security](#security)
- [Compatibility](#compatibility)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Documentation](#documentation)
- [License](#license)

## How it works

1. A service has a message for the agent. omp-channel receives it, either by polling an HTTP
   endpoint or from an MCP server that pushes it.
2. The message is handed to the agent as a follow-up, so it waits until the current turn ends if
   the agent is busy. The text is marked as data from an outside party.
3. The agent answers with the `reply` tool, using the `messageId` of the message. omp-channel posts
   the reply to the service.
4. While a turn runs, omp-channel reports `working` to the service; when the turn ends, `free`.
5. Delivery is at least once with acknowledgements, so a message is neither lost nor handled
   twice when the extension restarts. Details are in [docs/protocol.md](docs/protocol.md).

One conversation is open at a time per agent session. A message for another conversation waits
until the open one is closed.

## Connect a service in three steps

### 0. Install the extension

```sh
omp install omp-channel
```

This installs the published package into Oh My Pi's plugin folder (`~/.omp/plugins`). The
extension then loads in every session: no `-e` flag and no path to set. Check it by starting a
session and running `/channel-status`: it shows the transport in use and, when an adapter is
configured, what the adapter reports.

The configuration file is read from `.omp/omp-channel.json` in the directory where Oh My Pi
starts, or from the path in `OMP_CHANNEL_CONFIG` when that variable is set. Without either, the
extension has no transport and only offers MCP push. The steps below write this file.

A service that needs its own protocol connects through an adapter module (section 6 of
[docs/protocol.md](docs/protocol.md)). Point `adapterModule` at it in the configuration file, and
give the adapter the environment it reads:

```json
{
  "mcpServer": "my-service",
  "adapterModule": "/path/to/adapter.mjs",
  "delivery": { "deliverAs": "followUp" }
}
```

### 1. Install from a clone (for development)

Use this only to change the extension itself. The steps below need the built `dist/index.js`:

```sh
git clone https://github.com/tommasomarchionni/omp-channel.git
cd omp-channel
npm ci
npm run build
```

Load the built file with the `-e` flag, as in the example below, instead of `omp install`.

### 2. Choose how messages arrive

- **HTTP service (most integrations).** Set `service.url` in the configuration file. omp-channel
  then polls `GET <url>/messages`, acknowledges with `POST <url>/messages/ack`, and posts replies
  and status to `<url>/replies` and `<url>/status`. The service needs to implement those calls;
  the contract is in [docs/protocol.md](docs/protocol.md). No code is needed.
- **MCP push (local tools and tests).** Run an MCP server that sends the notification
  `notifications/omp/channel`. The example in [examples/mcp-server](examples/mcp-server) does this.
  Messages pushed this way are not leased, so they are not redelivered if lost. Replies still need
  an HTTP service or an adapter module.
- **Adapter module (custom protocol).** Point `adapterModule` at a JavaScript module that exports
  a `ChannelAdapter`. See [examples/adapter-module](examples/adapter-module).

### 3. Configure the URL and the key

The key is never written in the configuration file or in the code. The file names the
environment variable that holds it:

```sh
export EXAMPLE_CHANNEL_KEY="replace-with-the-key-from-your-service"
```

Or put the key in a file and name that file with the variable `<keyEnv>_FILE`, for example
`EXAMPLE_CHANNEL_KEY_FILE=/path/to/key`.

## Complete example

This example uses a placeholder service (`chat.example.com`). Replace the URL and the key with
your own. It also includes a local MCP test message that needs no service.

**1. Configuration file** (`examples/config/omp-channel.json`, which you can copy):

```json
{
  "$schema": "../../schema/config.schema.json",
  "mcpServer": "omp-channel",
  "service": {
    "url": "https://chat.example.com/api/omp-channel",
    "keyEnv": "EXAMPLE_CHANNEL_KEY"
  },
  "delivery": {
    "deliverAs": "followUp"
  }
}
```

**2. Environment:**

```sh
export OMP_CHANNEL_CONFIG="$PWD/examples/config/omp-channel.json"
export EXAMPLE_CHANNEL_KEY="replace-with-your-key"
```

**3. Start Oh My Pi with the extension:**

```sh
omp -e "$PWD/dist/index.js"
```

**4. Test message without any service.** Run the example MCP server by itself. It prints the
notification that it would push to the agent once the client sends `notifications/initialized`:

```sh
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  | node examples/mcp-server/server.mjs
```

The second line of output is the test message:

```json
{
  "jsonrpc": "2.0",
  "method": "notifications/omp/channel",
  "params": {
    "type": "message",
    "conversationId": "example-conversation",
    "messageId": "example-1",
    "sender": "example-user",
    "text": "Hello from the example service.",
    "sentAt": "..."
  }
}
```

To make Oh My Pi use the example server, add it to the MCP configuration of Oh My Pi. The exact
file and key depend on the Oh My Pi version; the entry runs `node` on the example file:

```json
{
  "mcpServers": {
    "omp-channel": {
      "command": "node",
      "args": ["/absolute/path/to/omp-channel/examples/mcp-server/server.mjs"]
    }
  }
}
```

The name `omp-channel` must equal `mcpServer` in the configuration file.

## Configuration

Every message the service sends must carry `attribution` (`"user"` for text a person wrote,
`"agent"` for text another agent wrote). That value is passed to Oh My Pi unchanged. How Oh My Pi
records each value is still unverified; see [docs/protocol.md](docs/protocol.md), section 3.4.

The configuration file is read from `OMP_CHANNEL_CONFIG`, or from `.omp/omp-channel.json` in the
working directory when it exists. Without a file the defaults apply and nothing is connected: the
extension still receives MCP pushes, but replies are reported as not configured. The file is
validated against [schema/config.schema.json](schema/config.schema.json). An invalid file disables
the extension and writes the reason (with its path) to stderr.

| Key                        | Default                                             | Meaning                                                                                         |
| -------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `mcpServer`                | `"omp-channel"`                                     | MCP server name that may push messages.                                                         |
| `service.url`              | none                                                | Base URL of the service. `https` required; `http` only for loopback.                            |
| `service.keyEnv`           | `"OMP_CHANNEL_KEY"`                                 | Environment variable holding the key (`<keyEnv>_FILE` for a file). Required with `service.url`. |
| `service.requestTimeoutMs` | `10000`                                             | Timeout of each request.                                                                        |
| `service.paths.*`          | `/messages`, `/messages/ack`, `/replies`, `/status` | Endpoint paths.                                                                                 |
| `poll.intervalMs`          | `2000`                                              | Wait between polls when the queue is empty.                                                     |
| `poll.maxBackoffMs`        | `30000`                                             | Longest wait after failed polls.                                                                |
| `poll.batchSize`           | `10`                                                | Deliveries requested per poll.                                                                  |
| `limits.maxTextLength`     | `4000`                                              | Longest message text, in characters.                                                            |
| `limits.maxSenderLength`   | `64`                                                | Longest sender name.                                                                            |
| `limits.maxPending`        | `5`                                                 | Events waiting to be admitted; more are dropped and not acknowledged.                           |
| `delivery.deliverAs`       | `"followUp"`                                        | How a message is queued in Oh My Pi: `steer`, `followUp` or `aside`.                            |
| `adapterModule`            | none                                                | Path to a module that exports a `ChannelAdapter`. Replaces the HTTP transport.                  |

Environment variables:

| Variable                                       | Meaning                                                             |
| ---------------------------------------------- | ------------------------------------------------------------------- |
| `OMP_CHANNEL_CONFIG`                           | Path of the configuration file. Must exist when set.                |
| `<keyEnv>` (for example `EXAMPLE_CHANNEL_KEY`) | The service key.                                                    |
| `<keyEnv>_FILE`                                | Path of a file that holds the key, used when `<keyEnv>` is not set. |

## Security

- **The key stays out of the model.** It is used only in HTTP headers. It is not in tool results,
  prompts, logs or error messages. Error messages name the HTTP status or the error type only.
- **Inbound text is data.** Messages are wrapped in an envelope that tells the model the content
  comes from an outside party and must not change its rules. Angle brackets are escaped so the
  text cannot close the envelope.
- **Strict validation.** Events with unknown fields, invalid identifiers, control characters or
  text over the limit are rejected before they reach the agent.
- **Transport.** `https` is required for the service. Plain `http` is accepted only for loopback
  addresses, for local tests.
- **Replies are limited.** The `reply` tool accepts only a `messageId` that was delivered in the
  current session.

Report vulnerabilities privately, as described in [SECURITY.md](SECURITY.md).

## Compatibility

| Component          | Version               | Status                                                          |
| ------------------ | --------------------- | --------------------------------------------------------------- |
| Node.js            | 20 and 22 (CI matrix) | Tested in CI on both. `.nvmrc` pins 22 for development.         |
| Oh My Pi           | 19.2.1                | Starts and loads the extension. Delivery not yet verified live. |
| Bun (for Oh My Pi) | 1.4.4 or later        | Required by Oh My Pi itself, not by omp-channel.                |
| Protocol           | 1 (alpha)             | Fields may still change before 1.0; see the changelog.          |

- The extension types come from the exact devDependency `@oh-my-pi/pi-coding-agent@19.2.1`. They
  are imported, not copied. One gap is documented in `src/tool-schema.ts`: the tool parameters are
  plain JSON Schema where Oh My Pi declares a TypeBox schema.
- **Verified in a live Oh My Pi session (19.2.1, local model):** startup, delivery of a pushed
  message to an idle session, a message pushed during a turn (taken at a turn boundary, see
  [docs/protocol.md](docs/protocol.md) section 3.5), and abort.
- **Not verified yet:** the status report (`working`/`free`) to a service, and the effect of each
  `attribution` value. See [docs/omp-verification.md](docs/omp-verification.md).
- `npm ci` also installs the Oh My Pi package for type checking; it is large.

## Troubleshooting

The extension never stops Oh My Pi. When it cannot start it writes one line to stderr and stays
off:

| Message                                                   | Cause and fix                                                                     |
| --------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `disabled: invalid configuration: unknown key "x" at ...` | A key is misspelled. The message lists the allowed keys.                          |
| `disabled: ... must be one of: ...`                       | A value is not allowed. The message lists the allowed values.                     |
| `disabled: set <keyEnv> (or <keyEnv>_FILE) ...`           | The key variable named in `service.keyEnv` is not set in the `omp` process.       |
| `disabled: OMP_CHANNEL_CONFIG points to a file ...`       | The path in `OMP_CHANNEL_CONFIG` does not exist.                                  |
| `disabled: service.url must use https ...`                | Use `https`, or a loopback address for local tests.                               |
| Messages arrive but replies fail                          | Without `service` or `adapterModule`, MCP pushes work but replies cannot be sent. |

## Development

```sh
npm ci
npm run check          # typecheck, lint, format check and tests
npm run pack:check     # list the files that would be published (publishes nothing)
npm run build          # compile to dist/
OMP_E2E=1 OMP_E2E_MODEL=<provider/model> npm run omp:e2e   # real Oh My Pi check, runs a model
```

Single commands: `npm run typecheck`, `npm run lint`, `npm run format` (writes), `npm run
format:check`, `npm test`. Tests use the Node.js built-in test runner through `tsx`; see
[CONTRIBUTING.md](CONTRIBUTING.md).

## Documentation

- [docs/protocol.md](docs/protocol.md): the integration contract, lease policy and decisions.
- [schema/](schema): JSON Schemas of the events, replies, status and configuration.
- [docs/omp-verification.md](docs/omp-verification.md): what was checked in a real session and what is open.
- [docs/releasing.md](docs/releasing.md): how a release is made.
- [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), [SUPPORT.md](SUPPORT.md), [CHANGELOG.md](CHANGELOG.md).

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). This project is independent and
is not affiliated with or endorsed by the Oh My Pi project.
