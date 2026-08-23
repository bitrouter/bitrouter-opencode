import type { Model as ModelV2, Provider as ProviderV2 } from "@opencode-ai/sdk/v2";
import type { ProviderConfig } from "@opencode-ai/sdk";
import { AUTO_MODEL_ID } from "./constants.js";
import {
  hasCapability,
  type DiscoveredModel,
  type DiscoveredPricing,
} from "./discovery.js";

/** The AI SDK package opencode drives an OpenAI-compatible upstream with. */
export const OPENAI_COMPATIBLE_NPM = "@ai-sdk/openai-compatible";

/**
 * Capabilities assumed for the synthesized `auto` entry, used only while
 * BitRouter's own catalog does not list it. They are deliberately the floor
 * rather than the ceiling of what the route can reach: `auto` may land on any
 * model in the tier ladder, and the two wrong answers do not cost the same.
 * Under-claiming compacts a session earlier than it needed to; over-claiming
 * sends a request the chosen model rejects outright, mid-turn. A catalog that
 * lists `auto` replaces every one of these with the served value.
 */
const AUTO_CONTEXT = 128_000;
const AUTO_MAX_TOKENS = 16_384;

const DEFAULT_CONTEXT = 128_000;
const DEFAULT_MAX_TOKENS = 4096;

type Modality = "text" | "audio" | "image" | "video" | "pdf";
const MODALITIES: readonly Modality[] = ["text", "audio", "image", "video", "pdf"];

/**
 * Capability tokens that imply an input modality, for a plane that advertises
 * the capability but leaves `input_modalities` empty.
 */
const MODALITY_CAPABILITIES: ReadonlyArray<readonly [string, Modality]> = [
  ["image_input", "image"],
  ["audio_input", "audio"],
  ["video_input", "video"],
  ["file_input", "pdf"],
];

function normalizeModalities(raw: string[] | undefined, fallback: Modality[]): Modality[] {
  const kept = (raw ?? []).filter((m): m is Modality =>
    (MODALITIES as readonly string[]).includes(m),
  );
  return kept.length > 0 ? kept : fallback;
}

/** Input modalities, taking the declared list and the capability tokens together. */
function inputModalities(m: DiscoveredModel): Modality[] {
  const declared = normalizeModalities(m.input_modalities, ["text"]);
  const merged = new Set<Modality>(declared);
  for (const [token, modality] of MODALITY_CAPABILITIES) {
    if (hasCapability(m, token)) merged.add(modality);
  }
  return MODALITIES.filter((x) => merged.has(x));
}

function outputModalities(m: DiscoveredModel): Modality[] {
  return normalizeModalities(m.output_modalities, ["text"]);
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
 * Flatten BitRouter's nested per-million rates into the flat per-million shape
 * opencode carries. Both sides are already per-million, so this is a reshape
 * and not a conversion. An undeclared rate reads as 0 — "not priced here" —
 * which is what opencode shows for a model whose cost it does not know.
 */
export function toCost(pricing: DiscoveredPricing | undefined): {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
} {
  const input = pricing?.input_tokens ?? {};
  const output = pricing?.output_tokens ?? {};
  return {
    input: input.no_cache ?? 0,
    output: output.text ?? 0,
    cache_read: input.cache_read ?? 0,
    cache_write: input.cache_write ?? 0,
  };
}

/** Whether the model advertises extended reasoning. */
function isReasoning(m: DiscoveredModel): boolean {
  return hasCapability(m, "reasoning");
}

/**
 * Whether the model can call tools. Absent capability tokens mean the plane
 * did not say — the local daemon never does — and a coding agent is unusable
 * against a model it believes cannot call tools, so silence reads as yes.
 * Cloud, which does advertise the token, is taken at its word.
 */
function isToolCall(m: DiscoveredModel): boolean {
  if (!Array.isArray(m.capabilities) || m.capabilities.length === 0) return true;
  return m.capabilities.includes("tools");
}

/**
 * Map a `/v1/models` entry to the model shape opencode accepts inside a
 * `provider.<id>.models` config block. Used by the `config` hook, which seeds
 * the catalog at load time.
 */
export function toConfigModel(
  m: DiscoveredModel,
): NonNullable<ProviderConfig["models"]>[string] {
  const input = inputModalities(m);
  const output = outputModalities(m);
  return {
    id: m.id,
    name: m.name ?? m.id,
    reasoning: isReasoning(m),
    tool_call: isToolCall(m),
    attachment: input.includes("image") || input.includes("pdf"),
    temperature: true,
    cost: toCost(m.pricing),
    limit: {
      context: m.max_input_tokens ?? DEFAULT_CONTEXT,
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
  const input = inputModalities(m);
  const output = outputModalities(m);
  const inherited = Object.values(provider.models ?? {})[0]?.api;
  const baseURL = provider.options?.baseURL;
  const cost = toCost(m.pricing);
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
      reasoning: isReasoning(m),
      attachment: input.includes("image") || input.includes("pdf"),
      toolcall: isToolCall(m),
      input: modalityFlags(input),
      output: modalityFlags(output),
      interleaved: false,
    },
    cost: {
      input: cost.input,
      output: cost.output,
      cache: { read: cost.cache_read, write: cost.cache_write },
    },
    limit: {
      context: m.max_input_tokens ?? DEFAULT_CONTEXT,
      output: m.max_output_tokens ?? DEFAULT_MAX_TOKENS,
    },
    status: "active",
    options: {},
    headers: {},
    release_date: "",
  };
}

/**
 * The synthesized `auto` entry, used only while BitRouter's catalog does not
 * list one itself. Tool calling is on because the route exists to serve a
 * coding agent; the capacities are the conservative floor documented above.
 */
export function autoModel(): DiscoveredModel {
  return {
    id: AUTO_MODEL_ID,
    name: "BitRouter Auto",
    description: "Let BitRouter choose the model for each request.",
    max_input_tokens: AUTO_CONTEXT,
    max_output_tokens: AUTO_MAX_TOKENS,
    input_modalities: ["text", "image"],
    output_modalities: ["text"],
    capabilities: ["tools", "reasoning"],
  };
}

/**
 * Put the auto route at the head of the catalog, synthesizing it when the
 * gateway does not serve one yet.
 *
 * A served entry still wins if one ever appears, though none does today:
 * `bitrouter/` is resolved before any provider lookup, and BitRouter's registry
 * validator refuses catalog models under it, so the entry has to come from
 * here. The check costs nothing and keeps the placeholder from shadowing a
 * future one. Order matters because the head
 * of this list is what a surface offers first.
 */
export function withAutoModel(discovered: DiscoveredModel[]): DiscoveredModel[] {
  const served = discovered.find((m) => m.id === AUTO_MODEL_ID);
  const rest = discovered.filter((m) => m.id !== AUTO_MODEL_ID);
  return [served ?? autoModel(), ...rest];
}
