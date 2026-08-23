import { describe, it, expect } from "vitest";
import {
  autoModel,
  toConfigModel,
  toCost,
  toRuntimeModel,
  withAutoModel,
  OPENAI_COMPATIBLE_NPM,
} from "../src/models.js";
import type { DiscoveredModel } from "../src/discovery.js";

/**
 * A cloud catalog entry exactly as `GET https://api.bitrouter.ai/v1/models`
 * serves one — nested per-million `pricing`, `max_input_tokens` rather than a
 * `context_window`, capability tokens rather than booleans, and `providers` as
 * a count object.
 */
const CLOUD: DiscoveredModel = {
  id: "anthropic/claude-opus-4.6",
  name: "Anthropic: Claude Opus 4.6",
  max_input_tokens: 200000,
  max_output_tokens: 16384,
  input_modalities: ["text", "image"],
  output_modalities: ["text"],
  pricing: {
    input_tokens: { no_cache: 5, cache_read: 0.5, cache_write: 6.25 },
    output_tokens: { text: 25 },
  },
  capabilities: ["reasoning", "structured_outputs", "tools"],
  providers: { total_online: 2 },
};

/** A local-daemon entry: the whole of what `bitrouter start` serves. */
const LOCAL: DiscoveredModel = {
  id: "anthropic/claude-opus-4.6",
  object: "model",
  providers: ["claude-code"],
};

const provider = {
  id: "bitrouter",
  models: {},
  options: { baseURL: "https://api.bitrouter.ai/v1" },
};

describe("toCost", () => {
  it("flattens BitRouter's nested per-million rates", () => {
    expect(toCost(CLOUD.pricing)).toEqual({
      input: 5,
      output: 25,
      cache_read: 0.5,
      cache_write: 6.25,
    });
  });

  it("reads an undeclared rate as zero rather than dropping the model", () => {
    expect(toCost({ output_tokens: { text: 5 } })).toEqual({
      input: 0,
      output: 5,
      cache_read: 0,
      cache_write: 0,
    });
    expect(toCost(undefined)).toEqual({
      input: 0,
      output: 0,
      cache_read: 0,
      cache_write: 0,
    });
  });
});

describe("toConfigModel", () => {
  it("maps a cloud entry off the fields cloud actually sends", () => {
    expect(toConfigModel(CLOUD)).toEqual({
      id: "anthropic/claude-opus-4.6",
      name: "Anthropic: Claude Opus 4.6",
      reasoning: true,
      tool_call: true,
      attachment: true,
      temperature: true,
      cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
      limit: { context: 200000, output: 16384 },
      modalities: { input: ["text", "image"], output: ["text"] },
      status: "active",
    });
  });

  it("reads reasoning and tool use from capability tokens, not booleans", () => {
    const plain = toConfigModel({ ...CLOUD, capabilities: ["tools"] });
    expect(plain.reasoning).toBe(false);
    expect(plain.tool_call).toBe(true);

    const thinker = toConfigModel({ ...CLOUD, capabilities: ["reasoning"] });
    expect(thinker.reasoning).toBe(true);
    // Cloud advertised its capabilities and did not include `tools`.
    expect(thinker.tool_call).toBe(false);
  });

  it("assumes tool use when the plane advertises no capabilities at all", () => {
    // The local daemon never sends capability tokens, and a coding agent is
    // unusable against a model it believes cannot call tools.
    expect(toConfigModel(LOCAL).tool_call).toBe(true);
    expect(toConfigModel(LOCAL).reasoning).toBe(false);
  });

  it("falls back to safe defaults for a local entry that describes nothing", () => {
    const m = toConfigModel(LOCAL);
    expect(m.name).toBe("anthropic/claude-opus-4.6");
    expect(m.attachment).toBe(false);
    expect(m.limit).toEqual({ context: 128000, output: 4096 });
    expect(m.modalities).toEqual({ input: ["text"], output: ["text"] });
    expect(m.cost).toEqual({ input: 0, output: 0, cache_read: 0, cache_write: 0 });
  });

  it("infers an input modality from a capability token", () => {
    const m = toConfigModel({ id: "x", capabilities: ["file_input", "tools"] });
    expect(m.modalities?.input).toEqual(["text", "pdf"]);
    expect(m.attachment).toBe(true);
  });

  it("drops modalities opencode does not model", () => {
    const m = toConfigModel({ id: "x", input_modalities: ["text", "hologram"] });
    expect(m.modalities).toEqual({ input: ["text"], output: ["text"] });
  });
});

describe("toRuntimeModel", () => {
  it("produces a fully-materialized opencode Model", () => {
    const m = toRuntimeModel(CLOUD, provider);
    expect(m.id).toBe("anthropic/claude-opus-4.6");
    expect(m.providerID).toBe("bitrouter");
    expect(m.api).toEqual({
      id: "bitrouter",
      url: "https://api.bitrouter.ai/v1",
      npm: OPENAI_COMPATIBLE_NPM,
    });
    expect(m.capabilities.reasoning).toBe(true);
    expect(m.capabilities.toolcall).toBe(true);
    expect(m.capabilities.input).toEqual({
      text: true,
      audio: false,
      image: true,
      video: false,
      pdf: false,
    });
    expect(m.cost).toEqual({
      input: 5,
      output: 25,
      cache: { read: 0.5, write: 6.25 },
    });
    expect(m.limit).toEqual({ context: 200000, output: 16384 });
  });

  it("inherits the api block from a model the provider already carries", () => {
    const inherited = { id: "custom", url: "https://proxy.internal/v1", npm: "@ai-sdk/openai" };
    const m = toRuntimeModel(CLOUD, {
      ...provider,
      models: { existing: { api: inherited } } as never,
    });
    expect(m.api).toEqual(inherited);
  });

  it("tolerates a provider with no baseURL", () => {
    const m = toRuntimeModel({ id: "x" }, { id: "bitrouter", models: {}, options: {} });
    expect(m.api.url).toBe("");
  });
});

describe("withAutoModel", () => {
  it("puts a synthesized auto route at the head of the catalog", () => {
    const out = withAutoModel([CLOUD]);
    expect(out.map((m) => m.id)).toEqual(["bitrouter/auto", "anthropic/claude-opus-4.6"]);
    expect(out[0]).toEqual(autoModel());
  });

  it("offers the auto route even when nothing was discovered", () => {
    expect(withAutoModel([]).map((m) => m.id)).toEqual(["bitrouter/auto"]);
  });

  it("prefers the served entry once BitRouter lists auto itself", () => {
    const served: DiscoveredModel = {
      id: "bitrouter/auto",
      name: "BitRouter Auto",
      max_input_tokens: 1000000,
      capabilities: ["tools", "reasoning"],
    };
    const out = withAutoModel([CLOUD, served]);
    expect(out[0]).toBe(served);
    expect(out).toHaveLength(2);
    // The served metadata wins over the placeholder's conservative floor.
    expect(toConfigModel(out[0]).limit?.context).toBe(1000000);
  });

  it("never lists the auto route twice", () => {
    const out = withAutoModel([{ id: "bitrouter/auto" }, CLOUD, { id: "bitrouter/auto" }]);
    expect(out.filter((m) => m.id === "bitrouter/auto")).toHaveLength(1);
  });
});
