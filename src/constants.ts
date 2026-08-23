/**
 * BitRouter deployment constants.
 *
 * These used to be code-generated from `shared/bitrouter.json` in the
 * bitrouter-integrations monorepo. This package is standalone, so they are
 * hand-maintained here — keep them in sync with the gateway's cloud endpoints
 * when BitRouter Cloud moves.
 */
export const bitrouter = {
  cloud: {
    /** OpenAI-compatible inference surface for BitRouter Cloud. */
    apiBaseUrl: "https://api.bitrouter.ai/v1",
    /** OAuth authorization server (RFC 8414 metadata lives under this origin). */
    authServer: "https://api.bitrouter.ai",
  },
  /** Loopback daemon default, as served by `bitrouter start`. */
  local: {
    apiBaseUrl: "http://127.0.0.1:4356/v1",
  },
} as const;

/** The provider id. Must match the key used in `opencode.json` and `/connect`. */
export const PROVIDER_ID = "bitrouter";

/**
 * The model id that hands model choice back to BitRouter. Paired with
 * {@link PROVIDER_ID} this is the `bitrouter/auto` reference a user selects,
 * and it travels to the gateway as the request's `model` field.
 *
 * BitRouter serves the route; this package only advertises it. Until the
 * catalog lists `auto` itself, {@link autoModel} synthesizes the entry so the
 * route is selectable — and once the catalog does list it, the served entry
 * wins and carries the real metadata.
 */
export const AUTO_MODEL_ID = "auto";

/** The `provider/model` reference a harness surface shows for the auto route. */
export const AUTO_MODEL_REF = `${PROVIDER_ID}/${AUTO_MODEL_ID}`;
