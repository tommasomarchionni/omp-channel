import type {
  ExtensionAPI,
  ExtensionContext,
  McpNotificationEvent,
  ToolDefinition,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { SendUserMessageOptions } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";

/** Lifecycle events used by the fake API. Only the event type is needed. */
export interface LifecycleEvent {
  type: "session_start" | "session_switch" | "agent_start" | "agent_end" | "session_shutdown";
  willContinue?: boolean;
  awaitingAsyncWork?: boolean;
  messages?: unknown[];
}

export interface SentPrompt {
  content: string;
  options: SendUserMessageOptions | undefined;
}

/**
 * Fake Oh My Pi API. It records registrations and prompts, and lets a test fire events.
 * `sendMode` controls how sendUserMessage settles: "accept" resolves at once, "hold" never
 * settles until release() is called, "reject" refuses the prompt.
 */
export function fakePi(sendMode: "accept" | "hold" | "reject" = "accept") {
  const notificationHandlers: ((event: McpNotificationEvent, ctx: ExtensionContext) => void)[] = [];
  const lifecycleHandlers = new Map<
    string,
    ((event: LifecycleEvent, ctx: ExtensionContext) => void)[]
  >();
  const tools: ToolDefinition[] = [];
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const sent: SentPrompt[] = [];
  const held: (() => void)[] = [];

  const api = {
    on(event: string, handler: (...args: never[]) => unknown) {
      if (event === "mcp_notification") {
        notificationHandlers.push(
          handler as (event: McpNotificationEvent, ctx: ExtensionContext) => void,
        );
        return;
      }
      const list = lifecycleHandlers.get(event) ?? [];
      list.push(handler as (event: LifecycleEvent, ctx: ExtensionContext) => void);
      lifecycleHandlers.set(event, list);
    },
    registerTool(tool: ToolDefinition) {
      tools.push(tool);
    },
    registerCommand(
      name: string,
      options: { handler: (args: string, ctx: unknown) => Promise<void> },
    ) {
      commands.set(name, options);
    },
    sendUserMessage(content: string, options?: SendUserMessageOptions) {
      sent.push({ content, options });
      if (sendMode === "reject") {
        return Promise.reject(Object.assign(new Error("dropped"), { name: "PromptDroppedError" }));
      }
      if (sendMode === "hold") {
        return new Promise<void>((resolve) => held.push(resolve));
      }
      return Promise.resolve();
    },
  } as unknown as ExtensionAPI;

  return {
    api,
    tools,
    sent,
    release: () => {
      for (const resolve of held.splice(0)) {
        resolve();
      }
    },
    notify(event: McpNotificationEvent, ctx: ExtensionContext = fakeContext()) {
      for (const handler of notificationHandlers) {
        handler(event, ctx);
      }
    },
    lifecycle(
      name: LifecycleEvent["type"],
      ctx: ExtensionContext = fakeContext(),
      data: Omit<LifecycleEvent, "type"> = { messages: [] },
    ) {
      for (const handler of lifecycleHandlers.get(name) ?? []) {
        handler({ type: name, ...data }, ctx);
      }
    },
    command(name: string) {
      const command = commands.get(name);
      if (command === undefined) {
        throw new Error(`command ${name} not registered`);
      }
      return command;
    },
    tool(name: string): ToolDefinition {
      const tool = tools.find((candidate) => candidate.name === name);
      if (tool === undefined) {
        throw new Error(`tool ${name} not registered`);
      }
      return tool;
    },
  };
}

/** Text of a tool result (the first content item, when it is text). */
export function resultText(result: { content: { type: string }[] }): string {
  const first = result.content[0] as { type: string; text?: string } | undefined;
  return first?.text ?? "";
}

export function fakeContext(
  overrides: { idle?: boolean; aborts?: { count: number } } = {},
): ExtensionContext {
  const aborts = overrides.aborts ?? { count: 0 };
  const context = {
    hasUI: false,
    isIdle: () => overrides.idle ?? true,
    abort: () => {
      aborts.count += 1;
    },
  };
  return context as unknown as ExtensionContext;
}

export const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
