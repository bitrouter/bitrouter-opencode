import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { toConfigModel, withAutoModel } from "../src/models.js";
import type { DiscoveredModel } from "../src/discovery.js";

/**
 * Regression tests against bodies captured verbatim from both BitRouter data
 * planes, so a future change to the field mapping is caught by the wire and
 * not by a hand-written guess at it.
 *
 * The fixtures are trimmed to the fields this package reads; every value in
 * them is exactly what the endpoint served.
 */
function catalog(name: string): DiscoveredModel[] {
  const path = fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url));
  return (JSON.parse(readFileSync(path, "utf8")) as { data: DiscoveredModel[] }).data;
}

function mapped(name: string) {
  const models = withAutoModel(catalog(name)).map(toConfigModel);
  return { models, byId: Object.fromEntries(models.map((m) => [m.id, m])) };
}

describe("BitRouter Cloud wire shape", () => {
  it("reads the context window off max_input_tokens", () => {
    const { byId } = mapped("cloud-models");
    // Before this mapping existed the plugin read `context_window`, which
    // neither plane sends, so every one of these showed the 128K default.
    expect(byId["anthropic/claude-fable-5"].limit.context).toBe(1_000_000);
    expect(byId["anthropic/claude-haiku-4.5"].limit.context).toBe(200_000);
    expect(byId["anthropic/claude-opus-4.6"].limit.context).toBe(200_000);
  });

  it("reads the output cap off max_output_tokens", () => {
    const { byId } = mapped("cloud-models");
    expect(byId["anthropic/claude-fable-5"].limit.output).toBe(128_000);
    expect(byId["anthropic/claude-haiku-4.5"].limit.output).toBe(8192);
  });

  it("reads per-million cost off the nested pricing block", () => {
    const { byId } = mapped("cloud-models");
    // Previously read as a flat `cost` object, which cloud never sends — so
    // every model was displayed as free.
    expect(byId["anthropic/claude-fable-5"].cost).toEqual({
      input: 10,
      output: 50,
      cache_read: 1,
      cache_write: 12.5,
    });
  });

  it("reads reasoning and tool use off the capability tokens", () => {
    const { byId } = mapped("cloud-models");
    expect(byId["anthropic/claude-fable-5"].reasoning).toBe(true);
    // Fable advertises `reasoning` and not `tools`.
    expect(byId["anthropic/claude-fable-5"].tool_call).toBe(false);
    expect(byId["anthropic/claude-haiku-4.5"].reasoning).toBe(false);
    expect(byId["anthropic/claude-haiku-4.5"].tool_call).toBe(true);
  });

  it("leads with the auto route", () => {
    const { models } = mapped("cloud-models");
    expect(models[0].id).toBe("auto");
    expect(models).toHaveLength(4); // three served + auto
  });
});

describe("local daemon wire shape", () => {
  it("falls back to opencode's defaults, since the daemon describes nothing", () => {
    const { byId } = mapped("local-models");
    // `{ id, object, providers }` is the whole of what `bitrouter start` serves.
    const m = byId["anthropic/claude-fable-5"];
    expect(m.name).toBe("anthropic/claude-fable-5");
    expect(m.limit).toEqual({ context: 128000, output: 4096 });
    expect(m.reasoning).toBe(false);
    // No capability tokens at all reads as "the plane did not say", and a
    // coding agent is unusable against a model it believes cannot call tools.
    expect(m.tool_call).toBe(true);
    expect(m.cost).toEqual({ input: 0, output: 0, cache_read: 0, cache_write: 0 });
  });

  it("still leads with the auto route", () => {
    expect(mapped("local-models").models[0].id).toBe("auto");
  });
});
