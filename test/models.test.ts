import { describe, it, expect } from "vitest";
import { toConfigModel, toRuntimeModel, OPENAI_COMPATIBLE_NPM } from "../src/models.js";

const RICH = {
  id: "claude-opus-4-8",
  name: "Claude Opus 4.8",
  reasoning: true,
  tool_call: true,
  input_modalities: ["text", "image"],
  output_modalities: ["text"],
  context_window: 200000,
  max_output_tokens: 64000,
  cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
};

const provider = {
  id: "bitrouter",
  models: {},
  options: { baseURL: "https://api.bitrouter.ai/v1" },
};

describe("toConfigModel", () => {
  it("maps an enriched entry", () => {
    expect(toConfigModel(RICH)).toEqual({
      id: "claude-opus-4-8",
      name: "Claude Opus 4.8",
      reasoning: true,
      tool_call: true,
      attachment: true,
      temperature: true,
      cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
      limit: { context: 200000, output: 64000 },
      modalities: { input: ["text", "image"], output: ["text"] },
      status: "active",
    });
  });

  it("falls back to safe defaults when metadata is absent", () => {
    const m = toConfigModel({ id: "mystery" });
    expect(m.name).toBe("mystery");
    expect(m.reasoning).toBe(false);
    expect(m.tool_call).toBe(true);
    expect(m.attachment).toBe(false);
    expect(m.limit).toEqual({ context: 128000, output: 4096 });
    expect(m.modalities).toEqual({ input: ["text"], output: ["text"] });
    expect(m.cost).toEqual({ input: 0, output: 0, cache_read: 0, cache_write: 0 });
  });

  it("drops modalities opencode does not model", () => {
    const m = toConfigModel({ id: "x", input_modalities: ["text", "hologram"] });
    expect(m.modalities).toEqual({ input: ["text"], output: ["text"] });
  });
});

describe("toRuntimeModel", () => {
  it("produces a fully-materialized opencode Model", () => {
    const m = toRuntimeModel(RICH, provider);
    expect(m.id).toBe("claude-opus-4-8");
    expect(m.providerID).toBe("bitrouter");
    expect(m.api).toEqual({
      id: "bitrouter",
      url: "https://api.bitrouter.ai/v1",
      npm: OPENAI_COMPATIBLE_NPM,
    });
    expect(m.capabilities.reasoning).toBe(true);
    expect(m.capabilities.input).toEqual({
      text: true,
      audio: false,
      image: true,
      video: false,
      pdf: false,
    });
    expect(m.cost).toEqual({
      input: 3,
      output: 15,
      cache: { read: 0.3, write: 3.75 },
    });
    expect(m.limit).toEqual({ context: 200000, output: 64000 });
  });

  it("inherits the api block from a model the provider already carries", () => {
    const inherited = { id: "custom", url: "https://proxy.internal/v1", npm: "@ai-sdk/openai" };
    const m = toRuntimeModel(RICH, {
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
