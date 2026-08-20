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
  /**
   * Shown as the sole placeholder model when the catalog cannot be fetched yet
   * (typically: cloud, before `/connect bitrouter`). Keeps the provider
   * selectable so the user can reach the login flow at all.
   */
  defaultModel: "kimi-k2.5",
} as const;

export type BitrouterConstants = typeof bitrouter;
