# Integration protocol (version 1)

This document is the public contract between an external **service** (any system that exchanges
messages with a person or with another agent) and an agent
session of [Oh My Pi](https://github.com/can1357/oh-my-pi) running omp-channel. Any service can
implement it. The contract is independent of any product.

The machine-readable schemas are in [`schema/`](../schema):

| File                         | Describes                                                               |
| ---------------------------- | ----------------------------------------------------------------------- |
| `inbound-event.schema.json`  | events the service sends to the agent (`message`, `interrupt`, `close`) |
| `outbound-reply.schema.json` | a reply the agent posts to the service                                  |
| `status.schema.json`         | agent state the agent reports to the service                            |
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

| Field            | Required | Type and limits                                                              | Meaning                                                                                  |
| ---------------- | -------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `type`           | yes      | `"message"`                                                                  |                                                                                          |
| `conversationId` | yes      | identifier                                                                   | The conversation the message belongs to (section 5).                                     |
| `messageId`      | yes      | identifier                                                                   | Unique id of this message. Used to reply and to deduplicate.                             |
| `sender`         | yes      | string, 1 to 64 characters after cleanup                                     | Display name. Control characters become spaces.                                          |
| `text`           | yes      | string, 1 to 4000 characters, no control characters except tab and line feed | The content.                                                                             |
| `sentAt`         | no       | ISO 8601 timestamp                                                           | Set by the service. Informational.                                                       |
| `replyTo`        | no       | identifier                                                                   | `messageId` of an earlier message this one answers. Informational.                       |
| `attribution`    | yes      | `"user"` or `"agent"`                                                        | Who wrote the message. Passed to Oh My Pi unchanged. See section 3.4 for the open point. |

### 3.4 Open point: `attribution` values

`attribution` is required, and omp-channel sets no default for it. The value is handed to Oh My Pi
as the `attribution` option of `sendUserMessage`. What Oh My Pi does with each value (for
example whether it changes how the turn is billed or which initiator it records) is **not verified**.

The service sets `attribution` to the value that describes who wrote the message: `"user"` for text
a person wrote (the example server sends `"user"`), `"agent"` for text another agent wrote.
omp-channel does not choose a value on the service's behalf.

How to verify: run the end-to-end script in `test/omp-e2e/` once with each value, then compare the
recorded initiator of the turn in the Oh My Pi session output. The result is recorded in
`docs/omp-verification.md`. Only then may a default be documented.

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

## 4. HTTP transport

Paths are relative to `service.url` and configurable in `service.paths`. Defaults:

| Call        | Method and path         | Body or query               |
| ----------- | ----------------------- | --------------------------- |
| Poll        | `GET /messages?limit=N` | none                        |
| Acknowledge | `POST /messages/ack`    | `{ "deliveryIds": ["d1"] }` |
| Reply       | `POST /replies`         | outbound reply (section 7)  |
| Status      | `POST /status`          | agent status (section 8)    |

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
  interrupt?(conversationId: string): Promise<void>; // after an interrupt is applied
  close?(conversationId: string): Promise<void>; // after a close is applied
}
```

`receive` must stop when `signal` aborts. Yield deliveries in order. Throwing from `reply` means
the reply was not accepted. Errors must not contain secrets.

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
{ "type": "status", "conversationId": "c1", "status": "working", "at": "2026-11-26T10:00:00.000Z" }
```

`status` is `working` when a turn starts and `free` when it ends, for the open conversation.
Status is best effort: a failed report is logged and not retried. Status is not part of the
acknowledgement logic.

## 9. Activity (optional, not emitted in version 1)

The protocol reserves an optional `activity` report (for example, a tool started or finished)
for showing progress to the service. Version 1 of omp-channel does not emit it. A service must
not require it.

## 10. Security rules

- The service key is read from an environment variable named in the configuration
  (`service.keyEnv`), or from a file named by `<keyEnv>_FILE`. It is never written in the
  configuration file or in the code.
- The key is never given to the model, never returned by a tool, and never written to a log.
- `service.url` must use `https`. Plain `http` is accepted only for loopback addresses. URLs
  with credentials are refused.
- Inbound text is data from an outside party. It is handed to the model inside an envelope that
  says so, and angle brackets are escaped so the text cannot close the envelope.
- Inbound events are validated before use. Unknown fields and out-of-range values are rejected.

## 11. Versioning

`PROTOCOL_VERSION` is `1`. Version 1 is alpha: fields may still change before the first stable
release, and each change is recorded in CHANGELOG.md. A future incompatible change will use a
new version number.

## 12. Not in this contract

- Delivery of messages from the agent to a person without a reply to a message.
- Attachments and other non-text content.
- Multiple concurrent conversations in one agent session.
- Authentication schemes other than a bearer key. Use an adapter module for anything else.
