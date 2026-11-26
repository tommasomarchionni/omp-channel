import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { ConfigError } from "../src/config.js";
import { loadAdapterModule } from "../src/module-adapter.js";

const fixturesDir = fileURLToPath(new URL("./fixtures/", import.meta.url));

describe("loadAdapterModule", () => {
  it("loads a default export that implements ChannelAdapter", async () => {
    const adapter = await loadAdapterModule("./good-adapter.mjs", fixturesDir);
    assert.equal(typeof adapter.receive, "function");
    assert.equal(typeof adapter.reply, "function");
  });

  it("refuses a module that does not implement ChannelAdapter", async () => {
    await assert.rejects(loadAdapterModule("./bad-adapter.mjs", fixturesDir), ConfigError);
  });

  it("refuses a module that cannot be loaded, without its path in the message", async () => {
    await assert.rejects(loadAdapterModule("./missing.mjs", fixturesDir), (error: unknown) => {
      return error instanceof ConfigError && !/missing\.mjs/.test(error.message);
    });
  });
});
