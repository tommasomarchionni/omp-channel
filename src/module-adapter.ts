import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { isChannelAdapter, type ChannelAdapter } from "./adapter.js";
import { ConfigError } from "./config.js";

/** Loads a ChannelAdapter from a JavaScript module (default export, or named `adapter`). */
export async function loadAdapterModule(specifier: string, cwd: string): Promise<ChannelAdapter> {
  const href = pathToFileURL(resolve(cwd, specifier)).href;
  let loaded: Record<string, unknown>;
  try {
    loaded = (await import(href)) as Record<string, unknown>;
  } catch (error) {
    throw new ConfigError(
      `adapterModule cannot be loaded (${error instanceof Error ? error.name : "unknown"})`,
    );
  }
  const candidate = loaded.default ?? loaded.adapter;
  if (!isChannelAdapter(candidate)) {
    throw new ConfigError("adapterModule must export a ChannelAdapter as default export");
  }
  return candidate;
}
