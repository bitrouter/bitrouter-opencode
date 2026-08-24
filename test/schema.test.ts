import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

/**
 * The wire contract, checked against the contract BitRouter publishes.
 *
 * `test/wire.test.ts` proves the mapper reads a captured body correctly. It
 * cannot prove the capture still resembles what the server sends — a fixture
 * is a snapshot, and a snapshot goes stale in silence. That is not a
 * hypothetical failure: this package once read `context_window`, a flat
 * `cost`, and a boolean `reasoning`, none of which BitRouter has ever sent, so
 * every model sat at its default window priced at zero. No test failed.
 * Somebody had to read the code.
 *
 * BitRouter Cloud generates an OpenAPI document from the Rust types that
 * serialize the response and serves it unauthenticated, so the contract is
 * *published* — `schema/models.schema.json` is a vendored copy, refreshed by
 * `npm run schema:refresh` and by a scheduled workflow that opens a pull
 * request when it moves.
 *
 * The load-bearing assertion is the first one. It is not "does the fixture
 * parse"; it is "has the set of fields BitRouter serves changed since somebody
 * last looked". A new field fails this suite once, and the fix is to decide —
 * in `ACKNOWLEDGED`, in one line — whether to map it or to ignore it on
 * purpose. That is the whole mechanism: drift cannot pass silently, and
 * acknowledging it is cheap.
 *
 * The local daemon has no equivalent. `GET /v1/models` in
 * `crates/bitrouter-sdk/src/server.rs` builds its body from an inline
 * `serde_json::json!` literal rather than a schema-derived type, so there is
 * nothing published to check `local-models.json` against.
 */

// `uint64`, `uint`, and `double` are Rust's numeric widths surviving into the
// document as format hints. They are not JSON Schema formats, ajv has no
// validator for them, and saying so keeps it from narrating that fact once per
// occurrence per compile.
const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });

function load(path: string): any {
  return JSON.parse(readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8"));
}

const schema = load("../schema/models.schema.json");
const modelResponse = schema.$defs.ModelResponse;

/**
 * Every property of BitRouter Cloud's `ModelResponse`, and what this package
 * does with it. Adding a key here is a decision, which is the point: the test
 * below fails until one has been made.
 *
 * `use` is what the fixture-coverage assertion reads, so it has to describe
 * this package honestly rather than aspirationally:
 *
 * - `model` — reaches the model entry this plugin hands opencode.
 * - `read`  — parsed and exported, but not carried into the model.
 * - `none`  — neither, and for a stated reason.
 */
const ACKNOWLEDGED: Record<string, { use: "model" | "read" | "none"; why: string }> = {
  id: { use: "model", why: "the model id — the only field both data planes share" },
  name: { use: "model", why: "display name, falling back to the id" },
  max_input_tokens: {
    use: "model",
    why: "`contextWindow`. There is no `context_window` field, and reading one is the bug this suite exists to prevent",
  },
  max_output_tokens: { use: "model", why: "`maxTokens`" },
  input_modalities: { use: "model", why: "`input`, vision included" },
  capabilities: {
    use: "model",
    why: "open list of tokens: `reasoning` and `tools` become the booleans opencode wants, and `image_input`/`file_input` merge into `input` — which is also what sets `attachment`",
  },
  pricing: {
    use: "model",
    why: "`cost`, reshaped by `toCost`. Both sides are already per-million, so it is a reshape and not a conversion — but see the note on `context_tiers` in the assertions below: `toCost` reads the base bracket only",
  },
  providers: {
    use: "read",
    why: "`providerCount` reads `{ total_online }` here and `string[]` from the local daemon; exported, but an opencode model entry has nowhere to put it",
  },

  output_modalities: { use: "model", why: "`modalities.output`, defaulting to text" },

  // Present on the wire, deliberately not carried. An opencode model entry
  // has no field that would hold them, and inventing one would be this plugin
  // asserting something the harness cannot act on.
  description: {
    use: "none",
    why: "no corresponding field; only the synthesized auto entry carries one, written here",
  },
  hosted: { use: "none", why: "provisioning fact, not a capability of the model" },
  open_weights: { use: "none", why: "licensing fact, not a capability of the model" },
  latency: { use: "none", why: "a rolling measurement, not part of a model's description" },
  throughput: { use: "none", why: "a rolling measurement, not part of a model's description" },
};

describe("BitRouter Cloud's published /v1/models contract", () => {
  it("serves exactly the fields this package has looked at", () => {
    const served = Object.keys(modelResponse.properties).sort();
    const acknowledged = Object.keys(ACKNOWLEDGED).sort();

    // Spelled as two directed differences rather than one equality, because
    // the two failures mean opposite things and want different fixes.
    const appeared = served.filter((f) => !(f in ACKNOWLEDGED));
    const vanished = acknowledged.filter((f) => !(f in modelResponse.properties));

    expect(
      appeared,
      "BitRouter now serves fields this package has never considered. Decide whether to map each one, then record the decision in ACKNOWLEDGED.",
    ).toEqual([]);
    expect(
      vanished,
      "BitRouter has stopped serving fields this package expects. Anything mapped is now silently falling back to a default — the failure mode this suite exists to catch.",
    ).toEqual([]);
  });

  it("still requires the id every other mapping hangs off", () => {
    expect(modelResponse.required).toContain("id");
    expect(modelResponse.properties.id.type).toBe("string");
  });

  it("still carries the context window as a nullable integer named max_input_tokens", () => {
    // The specific shape matters: `type: [integer, "null"]` is why the mapper
    // treats a null as "undisclosed" and falls back, rather than as zero.
    expect(modelResponse.properties.max_input_tokens.type).toEqual(["integer", "null"]);
    expect(modelResponse.properties.max_output_tokens.type).toEqual(["integer", "null"]);
  });

  it("still nests pricing per million tokens rather than flattening it", () => {
    expect(Object.keys(schema.$defs.InputTokenPricing.properties).sort()).toEqual([
      "cache_read",
      "cache_write",
      "no_cache",
    ]);
    expect(Object.keys(schema.$defs.OutputTokenPricing.properties).sort()).toEqual([
      "audio",
      "image",
      "reasoning",
      "text",
    ]);
  });

  it("prices some models in context brackets, which toCost flattens away", () => {
    // A known and deliberate gap, asserted so it stays known. `context_tiers`
    // raises the rate for the whole request once input crosses a threshold —
    // a step function, not marginal brackets. `toCost` reports the base
    // bracket, so opencode understates the cost of a long prompt to a tiered
    // model. An opencode model entry carries one flat rate per direction and
    // has nowhere to put a ladder; closing this properly needs an
    // opencode-side change, not a mapper one.
    expect(Object.keys(schema.$defs.ModelPricing.properties).sort()).toEqual([
      "context_tiers",
      "input_tokens",
      "output_tokens",
    ]);
    expect(schema.$defs.ContextTier.required).toContain("above_input_tokens");
  });

  it("still counts providers as an object, which is what tells the planes apart", () => {
    // The local daemon sends `providers: string[]`. Cloud sends an object.
    // `providerCount()` branches on exactly this.
    expect(Object.keys(schema.$defs.ProvidersSummary.properties)).toEqual(["total_online"]);
  });

  it("declares no fixed vocabulary for capability tokens", () => {
    // Worth asserting rather than assuming: `capabilities` is an open list of
    // strings, so `hasCapability` matching an unknown token is a miss and not
    // an error, and a new token upstream cannot break this package. If an
    // `enum` ever appears here, that reasoning stops holding.
    expect(modelResponse.properties.capabilities.items).toEqual({ type: "string" });
    expect(modelResponse.properties.capabilities.items.enum).toBeUndefined();
  });
});

describe("the committed cloud fixture", () => {
  it("is a body BitRouter Cloud could actually serve", () => {
    // Catches the fixture being trimmed or hand-edited into a shape the
    // server would never send — which would make every assertion in
    // wire.test.ts a test of a fiction. It is also what fails when a field
    // becomes `required` upstream and the capture predates it.
    const validate = ajv.compile(schema);
    const ok = validate(load("./fixtures/cloud-models.json"));
    expect(ok, ajv.errorsText(validate.errors ?? [], { separator: "\n" })).toBe(true);
  });

  it("carries every field this package actually consumes", () => {
    // Conformance alone would accept a capture in which every optional field
    // is absent — valid, and useless as a regression test, since the mapping
    // would never run.
    const rows = load("./fixtures/cloud-models.json").data as Record<string, unknown>[];
    const present = new Set(rows.flatMap((r) => Object.keys(r)));
    const consumed = Object.entries(ACKNOWLEDGED)
      .filter(([, entry]) => entry.use !== "none")
      .map(([field]) => field);
    expect(consumed.filter((f) => !present.has(f))).toEqual([]);
  });

  it("includes a tiered-pricing model, so the shape stays covered", () => {
    // Without one, the `context_tiers` branch of the schema is never
    // exercised by conformance and could change unnoticed.
    const rows = load("./fixtures/cloud-models.json").data as any[];
    expect(rows.some((r) => r.pricing?.context_tiers?.length > 0)).toBe(true);
  });
});
