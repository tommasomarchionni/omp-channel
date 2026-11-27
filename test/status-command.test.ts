import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { ChannelAdapter } from "../src/adapter.js";
import { loadConfig } from "../src/config.js";
import {
  channelStatusText,
  createChannelExtension,
  STATUS_COMMAND_NAME,
} from "../src/extension.js";
import { fakePi } from "./helpers.js";

const config = loadConfig({ env: {}, cwd: "/", readText: () => undefined });

function adapterWith(describe: () => string | Promise<string>): ChannelAdapter {
  return {
    receive: async function* () {},
    reply: async () => undefined,
    describe,
  };
}

/** Runs the command and returns what it showed. */
async function runStatus(adapter?: ChannelAdapter): Promise<string[]> {
  const pi = fakePi();
  createChannelExtension({ config, adapter })(pi.api);
  const shown: string[] = [];
  const ctx = {
    ui: { notify: (text: string) => shown.push(text) },
  } as unknown as ExtensionCommandContext;
  await pi.command(STATUS_COMMAND_NAME).handler("", ctx);
  return shown;
}

describe("/channel-status", () => {
  it("is registered by the extension", () => {
    const pi = fakePi();
    createChannelExtension({ config })(pi.api);
    assert.equal(typeof pi.command(STATUS_COMMAND_NAME).handler, "function");
  });

  it("says MCP push only when there is no adapter and no service", async () => {
    const [text] = await runStatus();
    assert.match(text ?? "", /MCP push only \(replies are not configured\)/);
    assert.match(text ?? "", /MCP server omp-channel/);
  });

  it("shows what the adapter describes, after the transport line", async () => {
    const [text] = await runStatus(
      adapterWith(() => "Paired: waiting for the approval of the owner."),
    );
    assert.equal(
      text,
      "Channel: adapter module, MCP server omp-channel.\nPaired: waiting for the approval of the owner.",
    );
  });

  it("reports a failing description in one line, without the error text", async () => {
    const logs: string[] = [];
    const text = await channelStatusText(
      config,
      adapterWith(() => {
        throw new Error("secret token abc123");
      }),
      (line) => logs.push(line),
    );
    assert.match(text, /could not report its state/);
    assert.doesNotMatch(text, /abc123/);
    assert.equal(logs.length, 1);
    assert.doesNotMatch(logs[0] ?? "", /abc123/);
  });
});
