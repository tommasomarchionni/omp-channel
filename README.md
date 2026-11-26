# omp-channel

**omp-channel** is an extension for [Oh My Pi](https://github.com/can1357/oh-my-pi) (OMP), a
terminal agent harness. It delivers messages from an external service (a chat, a console, or any
system that exchanges messages with a person) into an agent session, and sends the agent's replies
back to that service.

It is for people who run an agent in a terminal and want an outside service to be able to send
it work and receive the answers, including while the agent is busy. It is **not** a hosting
service, it contains **no models**, and it does **not** manage accounts. You provide the service
and the model; omp-channel is the link between them.

> **Status: alpha.** The behaviour is covered by automated tests that use fakes and a loopback
> HTTP service. It has **not yet been run inside a live Oh My Pi session**. Oh My Pi's extension
> types are reproduced in `src/omp-api.d.ts` and must be re-checked when Oh My Pi changes (see
> [Compatibility](#compatibility)).

## Contents

- [How it works](#how-it-works)
- [Connect a service in three steps](#connect-a-service-in-three-steps)
- [Complete example](#complete-example)
- [Configuration](#configuration)
- [Security](#security)
- [Compatibility](#compatibility)
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

### 1. Install the extension

```sh
git clone https://github.com/OWNER/omp-channel.git
cd omp-channel
npm ci
npm run build
```

Oh My Pi loads an extension from the path you give it. The simplest way is the `-e` flag, shown in
the example below. You can also copy or link `dist/index.js` into one of the extension folders
that Oh My Pi reads (for example `<project>/.omp/extensions` or `~/.omp/agent/extensions`), or
list it in the `extensions` setting of your Oh My Pi configuration. Check the loading rules of
your Oh My Pi version.

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
    "deliverAs": "followUp",
    "attribution": "agent"
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
| `delivery.attribution`     | `"agent"`                                           | Attribution of a message when the service does not set one: `user` or `agent`.                  |
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

- **Node.js:** 20 or later (22 is used in CI; see `.nvmrc`).
- **Oh My Pi:** the extension API is reproduced in `src/omp-api.d.ts`, from Oh My Pi at commit
  `eded751bee10cedac1df7ace6616b8d2cf121a8a` and checked against the declarations published in
  `@oh-my-pi/pi-coding-agent@19.2.1`. Those declarations are the reference. **Re-check
  `src/omp-api.d.ts` against the Oh My Pi version you run.** The published package is not a
  dependency of this project, because it is a complete agent with a large dependency tree.
- **Not verified yet:** a run inside Oh My Pi (loading, `mcp_notification` delivery for stdio
  servers, interrupt behaviour during a running turn, the tool-parameter schema format).

## Development

```sh
npm ci
npm run check          # typecheck, lint, format check and tests
npm run build          # compile to dist/
```

Single commands: `npm run typecheck`, `npm run lint`, `npm run format` (writes), `npm run
format:check`, `npm test`. Tests use the Node.js built-in test runner through `tsx`; see
[CONTRIBUTING.md](CONTRIBUTING.md).

## Documentation

- [docs/protocol.md](docs/protocol.md): the integration contract, lease policy and decisions.
- [schema/](schema): JSON Schemas of the events, replies, status and configuration.
- [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), [CHANGELOG.md](CHANGELOG.md).

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). This project is independent and
is not affiliated with or endorsed by the Oh My Pi project.
