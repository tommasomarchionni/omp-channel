import { readFileSync } from "node:fs";
import { ConfigError, type ReadText, loadConfig } from "./config.js";
import { createChannelExtension } from "./extension.js";
import { createHttpAdapter } from "./http-adapter.js";
import { loadAdapterModule } from "./module-adapter.js";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";

export { type ChannelAdapter, type Delivery, AdapterError, isChannelAdapter } from "./adapter.js";
export { type ChannelConfig, ConfigError, loadConfig, parseServiceUrl } from "./config.js";
export { createChannelExtension, REPLY_TOOL_NAME } from "./extension.js";
export { createHttpAdapter } from "./http-adapter.js";
export {
  DEFAULT_LIMITS,
  MCP_NOTIFICATION_METHOD,
  PROTOCOL_VERSION,
  formatForSession,
  parseInboundEvent,
  parseMcpNotification,
  parseReplyInput,
  type InboundEvent,
  type MessageEvent,
  type ActivityState,
  type OutboundActivity,
  type OutboundReply,
  type OutboundStatus,
} from "./protocol.js";

const readText: ReadText = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
};

/**
 * Entry point loaded by Oh My Pi. A configuration problem disables the channel and is written to
 * stderr (stdout belongs to the terminal interface). The message never contains a key.
 */
export default async function ompChannel(pi: ExtensionAPI): Promise<void> {
  const log = (line: string): void => {
    process.stderr.write(`[omp-channel] ${line}\n`);
  };
  try {
    const cwd = process.cwd();
    const config = loadConfig({ env: process.env, cwd, readText });
    const adapter =
      config.adapterModule !== undefined
        ? await loadAdapterModule(config.adapterModule, cwd)
        : config.service !== undefined
          ? createHttpAdapter({
              service: config.service,
              poll: config.poll,
              limits: config.limits,
              log,
            })
          : undefined;
    createChannelExtension({ config, adapter, log })(pi);
  } catch (error) {
    const reason = error instanceof ConfigError ? error.message : "unexpected error";
    log(`disabled: ${reason}`);
  }
}
