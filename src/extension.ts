import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { ActivityReports } from "./activity.js";
import type { ChannelAdapter, Delivery } from "./adapter.js";
import type { ChannelConfig } from "./config.js";
import {
  ACKNOWLEDGED_OUTCOMES,
  CLOSED_REASON,
  Dispatcher,
  SWITCHED_REASON,
  type SessionPort,
} from "./dispatcher.js";
import { parseMcpNotification, parseReplyInput } from "./protocol.js";
import { jsonSchemaParameters } from "./tool-schema.js";
import { segmentsOf } from "./turn.js";

export const REPLY_TOOL_NAME = "reply";

export interface ChannelExtensionOptions {
  readonly config: ChannelConfig;
  /** Transport adapter (HTTP service or a custom module). Undefined: MCP push only, no replies. */
  readonly adapter?: ChannelAdapter | undefined;
  /** Receives short diagnostic lines. They never contain message text or keys. */
  readonly log?: (line: string) => void;
  /** Waits between two attempts to deliver (tests replace it). */
  readonly wait?: (ms: number) => Promise<void>;
}

/**
 * Creates the extension factory. It registers:
 * - `mcp_notification`: messages pushed by the configured MCP server enter the agent;
 * - the `reply` tool: the model answers a message by its messageId;
 * - lifecycle hooks: the agent state is reported, no message is left without an answer or a
 *   report when a run ends or the session goes away, and the adapter stops on shutdown;
 * - tool hooks, when the adapter takes activity reports: which tools are used for a message;
 * - the adapter receive loop, when an adapter is given.
 */
export function createChannelExtension(options: ChannelExtensionOptions): ExtensionFactory {
  return (pi: ExtensionAPI): void => {
    const { config } = options;
    const adapter = options.adapter;
    const log = options.log ?? (() => undefined);
    let context: ExtensionContext | undefined;

    const session: SessionPort = {
      send: (content, sendOptions) => pi.sendUserMessage(content, sendOptions),
      abort: () => context?.abort(),
      isIdle: () => context?.isIdle() ?? true,
    };
    // Assigned below: the two need each other.
    let activity: ActivityReports | undefined;
    const dispatcher = new Dispatcher({
      config,
      session,
      adapter,
      log,
      beforeOutcome: () => activity?.flush(),
      ...(options.wait === undefined ? {} : { wait: options.wait }),
    });
    if (config.reports.activity && adapter?.activity !== undefined) {
      const reports = new ActivityReports({
        send: async (report) => adapter.activity?.(report),
        conversationOfOpen: (messageId) => dispatcher.conversationOfOpen(messageId),
        ignored: new Set([REPLY_TOOL_NAME]),
        log,
      });
      // The handlers only note the event: Oh My Pi waits for them.
      pi.on("message_start", (event) => reports.heard(event.message));
      pi.on("tool_execution_start", (event) => reports.started(event));
      pi.on("tool_execution_end", (event) => reports.ended(event));
      activity = reports;
    }
    // Counts the runs, so the end of an old one never marks free a newer one.
    let runs = 0;

    pi.on("session_start", (_event, ctx) => {
      context = ctx;
    });

    pi.on("mcp_notification", (event, ctx) => {
      context = ctx;
      const parsed = parseMcpNotification(event, config.mcpServer, config.limits);
      if (parsed === null) {
        return;
      }
      if (!parsed.ok) {
        log(`dropped invalid MCP channel notification: ${parsed.reason}`);
        return;
      }
      void dispatcher.submit(parsed.value).then((outcome) => {
        if (!ACKNOWLEDGED_OUTCOMES.has(outcome)) {
          log(`MCP channel event not admitted: ${outcome}`);
        }
      });
    });

    pi.on("agent_start", (_event, ctx) => {
      context = ctx;
      runs += 1;
      dispatcher.setStatus("working");
    });

    pi.on("agent_end", (event, ctx) => {
      context = ctx;
      // A run that Oh My Pi continues (a retry, for example) has not ended: still working.
      if (event.willContinue === true) {
        return;
      }
      const run = runs;
      // The answers go first: a service that hears "free" has already received them.
      void dispatcher.settle(segmentsOf(event)).finally(() => {
        if (run === runs) {
          dispatcher.setStatus("free");
        }
      });
    });

    // A new, resumed or forked session no longer holds the messages that were waiting.
    pi.on("session_switch", async (_event, ctx) => {
      context = ctx;
      activity?.reset();
      await dispatcher.abandon(SWITCHED_REASON);
    });

    if (adapter !== undefined) {
      const controller = new AbortController();
      pi.on("session_shutdown", async () => {
        // Oh My Pi waits a short time for this handler: report first, then stop the transport.
        if (dispatcher.hasOpenMessages) {
          await dispatcher.abandon(CLOSED_REASON);
        }
        controller.abort();
      });
      void runReceiveLoop(adapter, dispatcher, controller.signal, log);
    }

    pi.registerTool({
      name: REPLY_TOOL_NAME,
      label: "Reply to service",
      // Without this Oh My Pi leaves an extension tool out of the tools it sends to the model.
      loadMode: "essential",
      description:
        "Send a reply to an external message. Pass the messageId shown with that message. Only messageIds received in this session are accepted.",
      parameters: jsonSchemaParameters({
        type: "object",
        properties: {
          messageId: { type: "string", minLength: 1, maxLength: 128 },
          text: { type: "string", minLength: 1, maxLength: config.limits.maxTextLength },
        },
        required: ["messageId", "text"],
        additionalProperties: false,
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult> {
        context = ctx;
        const parsed = parseReplyInput(params, config.limits);
        if (!parsed.ok) {
          return textResult(`Reply rejected: ${parsed.reason}.`);
        }
        const result = await dispatcher.reply(parsed.value.messageId, parsed.value.text);
        return textResult(result.ok ? "Reply sent." : `Reply not sent: ${result.reason}.`);
      },
    });

    pi.registerCommand(STATUS_COMMAND_NAME, {
      description: "Show how the channel is connected and what its adapter reports",
      handler: async (_args, ctx) => {
        ctx.ui.notify(await channelStatusText(config, adapter, log), "info");
      },
    });
  };
}

/** Name of the command that shows the channel state (`/channel-status`). */
export const STATUS_COMMAND_NAME = "channel-status";

/**
 * The text of `/channel-status`: the transport in use, then the adapter's own description when it
 * has one. A failing description is reported in one line and never shown raw.
 */
export async function channelStatusText(
  config: ChannelConfig,
  adapter: ChannelAdapter | undefined,
  log: (line: string) => void,
): Promise<string> {
  const transport =
    config.service !== undefined
      ? "HTTP service"
      : adapter !== undefined
        ? "adapter module"
        : "MCP push only (replies are not configured)";
  const lines = [`Channel: ${transport}, MCP server ${config.mcpServer}.`];
  if (adapter?.describe !== undefined) {
    try {
      lines.push(await adapter.describe());
    } catch {
      log("the adapter could not describe its state");
      lines.push("The adapter could not report its state.");
    }
  }
  return lines.join("\n");
}

/**
 * Takes deliveries from the adapter one at a time. A delivery is acknowledged only after the agent
 * admitted it, so a crash before that point leads to redelivery rather than loss.
 */
async function runReceiveLoop(
  adapter: ChannelAdapter,
  dispatcher: Dispatcher,
  signal: AbortSignal,
  log: (line: string) => void,
): Promise<void> {
  try {
    for await (const delivery of adapter.receive(signal) as AsyncIterable<Delivery>) {
      const outcome = await dispatcher.submit(delivery.event, delivery.deliveryId);
      if (!ACKNOWLEDGED_OUTCOMES.has(outcome)) {
        log(`delivery not admitted (${outcome}); the service will deliver it again`);
        continue;
      }
      if (delivery.deliveryId !== undefined && adapter.ack !== undefined) {
        await adapter.ack(delivery.deliveryId).catch(() => {
          log("could not acknowledge a delivery; the service may deliver it again");
        });
      }
    }
  } catch (error) {
    if (!signal.aborted) {
      log(`receive loop stopped (${error instanceof Error ? error.name : "unknown"})`);
    }
  }
}

function textResult(text: string): AgentToolResult {
  return { content: [{ type: "text", text }] };
}
