import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";

/** Parameter schema type that Oh My Pi expects for tools (a TypeBox schema). */
export type ToolParameters = ToolDefinition["parameters"];

/**
 * Turns a plain JSON Schema object into the `parameters` of a tool.
 *
 * Oh My Pi declares `parameters` as a TypeBox schema. A TypeBox schema is a JSON Schema object
 * with a hidden kind marker, so a plain object is accepted at runtime when it has the same shape.
 * The cast is the one known gap between this project and the published type declarations: the
 * runtime acceptance of a plain object is not verified yet. It is checked by the OMP end-to-end
 * script in test/omp-e2e/ (see docs/omp-verification.md).
 */
export function jsonSchemaParameters(schema: object): ToolParameters {
  return schema as unknown as ToolParameters;
}
