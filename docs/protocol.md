---

title: Integration protocol
description: The public contract between a service and an Oh My Pi agent session.
---

# Integration protocol (version 1)

This document is the public contract between an external **service** (any system that exchanges
messages with a person or with another agent) and an agent
session of [Oh My Pi](https://github.com/can1357/oh-my-pi) running omp-channel. Any service can
implement it. The contract is independent of any product.

The machine-readable schemas are in [`schema/`](https://github.com/tommasomarchionni/omp-channel/tree/main/schema):

| File                         | Describes                                                               |
| ---------------------------- | ----------------------------------------------------------------------- |
| `inbound-event.schema.json`  | events the service sends to the agent (`message`, `interrupt`, `close`) |
| `outbound-reply.schema.json` | a reply the agent posts to the service                                  |
| `status.schema.json`         | agent state the agent reports to the service                            |
| `failure.schema.json`        | a turn that ended in an error and left a message unanswered             |
| `config.schema.json`         | the omp-channel configuration file                                      |

The TypeScript module `src/protocol.ts` implements the same rules. Both must change together.

## 1. Transports

A service can connect in one of three ways. They carry the same events.

1. **MCP push** (`notifications/omp/channel`). An MCP server running next to the agent sends a
   JSON-RPC notification whose `params` is an inbound event. Notifications are not leased: a lost
   notification is not redelivered. Use it for local tools and tests.
2. **HTTP service with leases** (section 4). omp-channel polls the service over HTTPS. Delivery is
   at least once, and each delivery is acknowledged. This is the transport for most integrations
   and needs only configuration.
3. **Custom adapter module** (section 6). A JavaScript module implements the `ChannelAdapter`
   interface. Use it when the service needs its own protocol.

## 2. Identifiers

`conversationId`, `messageId`, `replyTo` and `deliveryId` are strings that match
`^[A-Za-z0-9._:-]{1,128}$`.

Why: such identifiers are safe in URLs, headers, file names and log lines without escaping, and
they cannot hide control characters or path separators. The service chooses the format within
that pattern (a UUID or a prefixed counter are both fine). The agent treats them as opaque
strings and compares them exactly; they are case-sensitive.

Uniqueness: `messageId` should be unique for the service. The agent remembers the last 1000
admitted message ids and never admits the same one twice.

## 3. Inbound events (service to agent)

Every event is a JSON object. Unknown fields are rejected, so a typo is detected instead of
silently ignored. Limits are configurable (`limits` in the configuration file); the values below
are the defaults.

### 3.1 `message`

| Field            | Required | Type and limits                                                              | Meaning                                                               |
| ---------------- | -------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `type`           | yes      | `"message"`                                                                  |                                                                       |
| `conversationId` | yes      | identifier                                                                   | The conversation the message belongs to (section 5).                  |
| `messageId`      | yes      | identifier                                                                   | Unique id of this message. Used to reply and to deduplicate.          |
| `sender`         | yes      | string, 1 to 64 characters after cleanup                                     | Display name. Control characters become spaces.                       |
| `text`           | yes      | string, 1 to 4000 characters, no control characters except tab and line feed | The content.                                                          |
| `sentAt`         | no       | ISO 8601 timestamp                                                           | Set by the service. Informational.                                    |
| `replyTo`        | no       | identifier                                                                   | `messageId` of an earlier message this one answers. Informational.    |
| `attribution`    | yes      | `"user"` or `"agent"`                                                        | Who wrote the message. Passed to Oh My Pi unchanged. See section 3.4. |

### 3.2 `interrupt`

```json
{ "type": "interrupt", "conversationId": "c1" }
```

Asks the agent to stop the turn in progress in that conversation. Effects, as implemented:

- If the agent is busy and the conversation is the open one, the current turn is aborted.
- Tool results already produced in the turn stay in the session. The interrupt does not undo them.
- Follow-up messages already queued are not removed; they run after the interrupt.
- If the agent is idle, nothing is aborted.
- An interrupt for a conversation that is not open is acknowledged and ignored.

### 3.3 `close`

```json
{ "type": "close", "conversationId": "c1" }
```

Ends the open conversation so another conversation can start. A turn in progress is not
aborted; send `interrupt` first to stop it. A `close` for a conversation that is not open is
acknowledged and ignored.

### 3.4 `attribution` values

`attribution` is required on every message, and omp-channel sets no default for it. The value is
handed to Oh My Pi as the `attribution` option of `sendUserMessage`. The service sets it to the value
that describes who wrote the message: `"user"` for text a person wrote (the example server sends
`"user"`), `"agent"` for text another agent wrote. omp-channel does not choose a value on the
service's behalf.

What Oh My Pi does with each value (for example whether it changes how the turn is billed or which
initiator it records) is **not verified**. The result will be recorded in
`docs/omp-verification.md`, section "Attribution".

### 3.5 Delivery while the agent is busy

An inbound `message` that arrives while a turn runs is delivered with `delivery.deliverAs`
(default `followUp`; `steer` and `aside` are the other values, see the README). The contract for
`followUp`:

- The message is not lost and is not dropped.
- It is taken at a turn boundary: the next `turn_end` of the running agent, or the `agent_end` when
  no turn follows. It is never inserted inside a tool call.
- It is not guaranteed to wait for the final `agent_end` of the run. Oh My Pi 19.2.1 can take it at
  an earlier turn boundary of the same run, and that is the expected behaviour.

The check in `test/omp-e2e/run.mjs` tests this rule (scenario 2). It is `not-exercised` when the
model finishes before the second push.

## 4. HTTP transport

Paths are relative to `service.url` and configurable in `service.paths`. Defaults:

| Call        | Method and path         | Body or query               |
| ----------- | ----------------------- | --------------------------- |
| Poll        | `GET /messages?limit=N` | none                        |
| Acknowledge | `POST /messages/ack`    | `{ "deliveryIds": ["d1"] }` |
| Reply       | `POST /replies`         | outbound reply (section 7)  |
| Status      | `POST /status`          | agent status (section 8)    |
| Failure     | `POST /failures`        | failed turn (section 9)     |

All calls carry `Authorization: Bearer <key>`. A non-2xx answer is an error. The key is never
included in a log line, an error message or a tool result.

### 4.1 Poll response

```json
{
  "deliveries": [
    {
      "deliveryId": "d1",
      "leaseExpiresAt": "2026-11-26T10:00:30Z",
      "event": {
        "type": "message",
        "conversationId": "c1",
        "messageId": "m1",
        "sender": "ann",
        "text": "Hello"
      }
    }
  ]
}
```

- `deliveries` is in the order the service wants them handled. The agent handles them in that
  order, one at a time.
- `deliveryId` identifies one delivery. The same message can be delivered more than once under
  different `deliveryId`s, so the agent also deduplicates by `messageId`.
- `event` is an inbound event (section 3).
- A delivery whose `event` is invalid is acknowledged and discarded, and the reason is logged
  with its `deliveryId` only. It is not retried, because a retry would fail the same way.

### 4.2 Lease policy

This is the rule that keeps a message from being lost or handled twice.

1. The service leases each delivery until `leaseExpiresAt`. While the lease is valid the service
   does not return that delivery again. The service chooses the lease length; 30 to 60 seconds
   is a sensible range.
2. The agent acknowledges a delivery **after** the agent has admitted it into the session. An
   event that is refused (another conversation is open) or rejected by the session is **not**
   acknowledged.
3. If the agent stops before the acknowledgement, or does not acknowledge in time, the lease
   ends and the service delivers the event again. Nothing is lost.
4. If the agent acknowledges but the acknowledgement does not reach the service, the event may
   come back. The agent then recognizes the `messageId` (or the `deliveryId` of an interrupt or
   close) and acknowledges again without running the event a second time.

Result: **at-least-once delivery with idempotent handling**. The agent admits each message once
per process. Across a restart, the memory of admitted ids is lost, so a message whose
acknowledgement never arrived can be admitted again. Services that need stronger guarantees
should make their own `messageId` idempotent on their side, for example by not re-sending a
message whose reply they have already received.

### 4.3 Polling behaviour

- The agent polls every `poll.intervalMs` (default 2000 ms) when the last poll was empty.
- After a failed poll it waits longer each time, doubling up to `poll.maxBackoffMs` (default
  30000 ms).
- Each request has a timeout of `service.requestTimeoutMs` (default 10000 ms).
- Polling stops when the session shuts down.

## 5. Conversations

- One conversation is open at a time per agent session. The first admitted `message` opens its
  conversation.
- A `message` for another conversation is **refused**: it is not admitted and not
  acknowledged, so the service delivers it again after the open conversation has closed.
- A `close` event ends the open conversation. The next message for another conversation opens it.

Rationale: one agent session has one context. Mixing two conversations in it would send replies
to the wrong party. Holding the second conversation until the first closes keeps the order and the
replies correct, and needs no extra state from the service.

## 6. Custom adapter module

A module (path in `adapterModule`, relative to the working directory) exports a default object
that implements `ChannelAdapter` (`src/adapter.ts`):

```ts
interface ChannelAdapter {
  receive(signal: AbortSignal): AsyncIterable<{ deliveryId?: string; event: InboundEvent }>;
  reply(reply: OutboundReply): Promise<void>; // required
  ack?(deliveryId: string): Promise<void>; // after admission
  status?(status: OutboundStatus): Promise<void>; // best effort
  failure?(failure: OutboundFailure): Promise<void>; // a message got no answer (section 9)
  interrupt?(conversationId: string): Promise<void>; // after an interrupt is applied
  close?(conversationId: string): Promise<void>; // after a close is applied
  describe?(): Promise<string> | string; // plain-text state for the /channel-status command
}
```

`receive` must stop when `signal` aborts. Yield deliveries in order. Throwing from `reply` means
the reply was not accepted. Errors must not contain secrets.

`describe` is optional. The `/channel-status` command shows the transport in use and the text the
adapter returns. That text is for the person who runs the agent: it must not contain keys or
message text. A `describe` that throws is reported as one line; its error text is not shown.

## 7. Outbound reply (agent to service)

```json
{
  "type": "reply",
  "conversationId": "c1",
  "messageId": "r-7f3a2c10",
  "replyTo": "m1",
  "text": "Answer",
  "at": "2026-11-26T10:00:00.000Z"
}
```

- `replyTo` is the `messageId` of the inbound message being answered. The agent accepts a reply
  only for a `messageId` it admitted in this session, and the reply goes to that message's
  conversation.
- `messageId` is generated by the agent for each reply. The service may use it as an
  idempotency key.
- A 2xx answer means accepted. Any other answer is reported to the model as a failure. The agent
  does not retry automatically.

## 8. Agent status (agent to service)

```json
{
  "type": "status",
  "conversationId": "c1",
  "status": "working",
  "at": "2026-11-26T10:00:00.000Z"
}
```

`status` is `working` when a turn starts and `free` when it ends, for the open conversation. A run
that Oh My Pi continues on its own (a retry of a model request, for example) has not ended: the
state stays `working`. Status is best effort: a failed report is logged and not retried. Status is
not part of the acknowledgement logic.

## 9. Failed turn (agent to service)

A turn can end without a reply: with an error, for example because the model provider refuses the
request, or normally, when the model answers at the terminal and never calls the `reply` tool. In
both cases the service is told:

```json
{
  "type": "failure",
  "conversationId": "c1",
  "messageId": "f-41c0b9e2",
  "replyTo": "m1",
  "reason": "404 The model is downloaded but not loaded",
  "at": "2026-11-26T10:00:00.000Z"
}
```

- One report for each unanswered message: `replyTo` is its `messageId`. `messageId` is generated
  by the agent for each report.
- Sent only when the run is over. Oh My Pi retries some errors by itself, and background work can
  continue a run; while either happens, nothing is reported.
- A run that ended normally carries the reason `The agent finished without sending a reply`. The
  text the model wrote at the terminal is not sent: only the `reply` tool sends text.
- An aborted turn (an interrupt from the service, or from the person at the terminal) is not
  reported.
- A message that already got a reply is never reported. A run blames only the messages it took
  after the previous completed answer.
- `reason` is optional text for a person: one line, at most 500 characters. Common shapes of
  secrets (tokens, credentials in headers and addresses) and the name of the home folder are
  hidden before it is sent. The hiding covers known shapes and is no guarantee: set
  `failures.includeReason` to `false` to send no text at all.
- The report is best effort. A refused report is logged and sent again only if a later turn fails
  for the same message.
- A reply for the same message is still accepted afterwards, for example when a later turn
  succeeds. A service that has shown the failure decides what to do with it.
- A transport without the `failure` hook only logs the event. Over MCP push there is no way back
  to the service, so nothing is sent.

## 10. Activity (optional, not emitted in version 1)

The protocol reserves an optional `activity` report (for example, a tool started or finished)
for showing progress to the service. Version 1 of omp-channel does not emit it. A service must
not require it.

## 11. Security rules

- The service key is read from an environment variable named in the configuration
  (`service.keyEnv`), or from a file named by `<keyEnv>_FILE`. It is never written in the
  configuration file or in the code.
- The key is never given to the model, never returned by a tool, and never written to a log.
- `service.url` must use `https`. Plain `http` is accepted only for loopback addresses. URLs
  with credentials are refused.
- Inbound text is data from an outside party. It is handed to the model inside an envelope that
  says so, and angle brackets are escaped so the text cannot close the envelope.
- Inbound events are validated before use. Unknown fields and out-of-range values are rejected.
- The error text of a failed turn is cleaned of known secret shapes before it is sent (section 9).

## 12. Versioning

`PROTOCOL_VERSION` is `1`. Version 1 is alpha: fields may still change before the first stable
release, and each change is recorded in CHANGELOG.md. A future incompatible change will use a
new version number.

## 13. Not in this contract

- Delivery of messages from the agent to a person without a reply to a message.
- Attachments and other non-text content.
- Multiple concurrent conversations in one agent session.
- Authentication schemes other than a bearer key. Use an adapter module for anything else.
