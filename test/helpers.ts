import type {
  ExtensionAPI,
  ExtensionContext,
  LifecycleEvent,
  McpNotificationEvent,
  SendUserMessageOptions,
  ToolDefinition,
} from "../src/omp-api.js";

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
    lifecycle(name: LifecycleEvent["type"], ctx: ExtensionContext = fakeContext()) {
      for (const handler of lifecycleHandlers.get(name) ?? []) {
        handler({ type: name }, ctx);
      }
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

export function fakeContext(
  overrides: { idle?: boolean; aborts?: { count: number } } = {},
): ExtensionContext {
  const aborts = overrides.aborts ?? { count: 0 };
  return {
    hasUI: false,
    isIdle: () => overrides.idle ?? true,
    abort: () => {
      aborts.count += 1;
    },
  };
}

export const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
