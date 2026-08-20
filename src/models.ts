import type { Model as ModelV2, Provider as ProviderV2 } from "@opencode-ai/sdk/v2";
import type { ProviderConfig } from "@opencode-ai/sdk";
import type { DiscoveredModel } from "./discovery.js";

/** The AI SDK package opencode drives an OpenAI-compatible upstream with. */
export const OPENAI_COMPATIBLE_NPM = "@ai-sdk/openai-compatible";

const DEFAULT_CONTEXT = 128_000;
const DEFAULT_MAX_TOKENS = 4096;

type Modality = "text" | "audio" | "image" | "video" | "pdf";
const MODALITIES: readonly Modality[] = ["text", "audio", "image", "video", "pdf"];

function normalizeModalities(raw: string[] | undefined, fallback: Modality[]): Modality[] {
  const kept = (raw ?? []).filter((m): m is Modality =>
    (MODALITIES as readonly string[]).includes(m),
  );
  return kept.length > 0 ? kept : fallback;
}

function modalityFlags(list: Modality[]): Record<Modality, boolean> {
  return {
    text: list.includes("text"),
    audio: list.includes("audio"),
    image: list.includes("image"),
    video: list.includes("video"),
    pdf: list.includes("pdf"),
  };
}

/**
 * Map a `/v1/models` entry to the model shape opencode accepts inside a
 * `provider.<id>.models` config block. Used by the `config` hook, which seeds
 * the catalog at load time.
 */
export function toConfigModel(
  m: DiscoveredModel,
): NonNullable<ProviderConfig["models"]>[string] {
  const c = m.cost ?? {};
  const input = normalizeModalities(m.input_modalities, ["text"]);
  const output = normalizeModalities(m.output_modalities, ["text"]);
  return {
    id: m.id,
    name: m.name ?? m.id,
    reasoning: m.reasoning ?? false,
    tool_call: m.tool_call ?? true,
    attachment: input.includes("image") || input.includes("pdf"),
    temperature: true,
    cost: {
      input: c.input ?? 0,
      output: c.output ?? 0,
      cache_read: c.cache_read ?? 0,
      cache_write: c.cache_write ?? 0,
    },
    limit: {
      context: m.context_window ?? DEFAULT_CONTEXT,
      output: m.max_output_tokens ?? DEFAULT_MAX_TOKENS,
    },
    modalities: { input, output },
    status: "active",
  };
}

/**
 * Map a `/v1/models` entry to opencode's fully-materialized `Model`. Used by the
 * `provider.models` hook, which refreshes the catalog after authentication.
 *
 * `api` describes how opencode reaches the model; it is inherited from a model
 * the provider already carries when there is one, so a user override in
 * `opencode.json` is not silently discarded.
 */
export function toRuntimeModel(
  m: DiscoveredModel,
  provider: Pick<ProviderV2, "id" | "models" | "options">,
): ModelV2 {
  const c = m.cost ?? {};
  const input = normalizeModalities(m.input_modalities, ["text"]);
  const output = normalizeModalities(m.output_modalities, ["text"]);
  const inherited = Object.values(provider.models ?? {})[0]?.api;
  const baseURL = provider.options?.baseURL;
  return {
    id: m.id,
    providerID: provider.id,
    api: inherited ?? {
      id: provider.id,
      url: typeof baseURL === "string" ? baseURL : "",
      npm: OPENAI_COMPATIBLE_NPM,
    },
    name: m.name ?? m.id,
    capabilities: {
      temperature: true,
      reasoning: m.reasoning ?? false,
      attachment: input.includes("image") || input.includes("pdf"),
      toolcall: m.tool_call ?? true,
      input: modalityFlags(input),
      output: modalityFlags(output),
      interleaved: false,
    },
    cost: {
      input: c.input ?? 0,
      output: c.output ?? 0,
      cache: { read: c.cache_read ?? 0, write: c.cache_write ?? 0 },
    },
    limit: {
      context: m.context_window ?? DEFAULT_CONTEXT,
      output: m.max_output_tokens ?? DEFAULT_MAX_TOKENS,
    },
    status: "active",
    options: {},
    headers: {},
    release_date: "",
  };
}
