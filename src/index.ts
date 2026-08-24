import type { AuthHook, Hooks, Plugin } from "@opencode-ai/plugin";
import type { Auth } from "@opencode-ai/sdk/v2";
import { AUTO_MODEL_REF, PROVIDER_ID } from "./constants.js";
import { discoverModels, type DiscoveredModel } from "./discovery.js";
import {
  OPENAI_COMPATIBLE_NPM,
  toConfigModel,
  toRuntimeModel,
  withAutoModel,
} from "./models.js";
import {
  EXPIRY_SKEW_MS,
  pollForToken,
  refreshCredentials,
  requestDeviceAuthorization,
  resolveOAuthConfig,
  type BitrouterCredentials,
} from "./oauth.js";
import { resolveSmartTarget } from "./target.js";

export { AUTO_MODEL_ID, AUTO_MODEL_REF, PROVIDER_ID, bitrouter } from "./constants.js";
export { discoverModels, hasCapability, providerCount } from "./discovery.js";
export type { DiscoveredModel, DiscoveredPricing } from "./discovery.js";
export {
  OPENAI_COMPATIBLE_NPM,
  autoModel,
  toConfigModel,
  toCost,
  toRuntimeModel,
  withAutoModel,
} from "./models.js";

/** Pull a usable bearer token out of whatever opencode has stored for us. */
function tokenFrom(auth: Auth | undefined): string | undefined {
  if (!auth) return undefined;
  if (auth.type === "api") return auth.key;
  if (auth.type === "oauth") return auth.access;
  return undefined;
}

/**
 * BitRouter for opencode.
 *
 * Three hooks, each covering one stage of the provider's life:
 *
 * - `config`   — declares the `bitrouter` provider so a fresh install needs no
 *                hand-written `opencode.json`, seeded with whatever catalog is
 *                reachable at load time.
 * - `auth`     — offers a `brvk_` API key or a BitRouter Cloud device login, and
 *                turns whichever one is stored into provider options.
 * - `provider` — re-discovers the live catalog once a credential exists, so the
 *                model list reflects the account rather than the seed.
 */
export const BitRouterPlugin: Plugin = async ({ client }): Promise<Hooks> => {
  const env = process.env;
  const target = await resolveSmartTarget(env);
  const oauthConfig = resolveOAuthConfig(env);

  // On a loopback daemon `skip_auth: true` is the default, but opencode still
  // wants *some* key before it will surface a provider — so give it a filler.
  // An empty env var counts as unset: `export BITROUTER_API_KEY=` must not
  // register the empty string as a credential.
  const configuredKey =
    (env.BITROUTER_API_KEY || undefined) ??
    (target.mode === "local" ? "bitrouter-local" : undefined);

  const log = (level: "info" | "warn" | "error", message: string): void => {
    void client.app
      .log({ body: { service: "bitrouter", level, message } })
      .catch(() => {});
  };

  // Seed catalog: best effort at load time. Cloud before `/connect` has no
  // token, so this often discovers nothing and the `provider` hook fills in
  // the real list later. `withAutoModel` still puts the auto route at the head
  // either way, which is what keeps the provider selectable — and therefore
  // `/connect` reachable — before any credential exists.
  let discovered: DiscoveredModel[] = [];
  try {
    discovered = await discoverModels(target.baseUrl, configuredKey);
    if (discovered.length === 0) {
      log("info", `no models at ${target.baseUrl}/models yet; offering ${AUTO_MODEL_REF} alone`);
    }
  } catch (err) {
    log("info", `model discovery deferred (${String(err)}); offering ${AUTO_MODEL_REF} alone`);
  }
  const seed = withAutoModel(discovered);

  // Serialize refreshes so concurrent requests don't each burn the refresh token.
  let refreshing: Promise<BitrouterCredentials> | undefined;

  /** Return a non-expired access token, refreshing and persisting if needed. */
  async function freshAccess(creds: BitrouterCredentials): Promise<string> {
    if (creds.expires > Date.now() + EXPIRY_SKEW_MS) return creds.access;
    if (!creds.refresh) return creds.access;
    refreshing ??= refreshCredentials(oauthConfig, creds)
      .then(async (next) => {
        await client.auth.set({
          path: { id: PROVIDER_ID },
          body: { type: "oauth", ...next },
        });
        return next;
      })
      .finally(() => {
        refreshing = undefined;
      });
    try {
      return (await refreshing).access;
    } catch (err) {
      log("warn", `token refresh failed: ${String(err)}`);
      return creds.access;
    }
  }

  const loader: NonNullable<AuthHook["loader"]> = async (getAuth) => {
    const auth = await getAuth();
    if (auth.type === "api") return { apiKey: auth.key };
    if (auth.type !== "oauth") return {};
    // A stored OAuth grant expires mid-session, so the token is resolved per
    // request rather than pinned at load time.
    const authorizedFetch: typeof fetch = async (input, init) => {
      const current = await getAuth();
      const token =
        current.type === "oauth" ? await freshAccess(current) : tokenFrom(current);
      const headers = new Headers(init?.headers);
      if (token) headers.set("Authorization", `Bearer ${token}`);
      return fetch(input, { ...init, headers });
    };
    return { apiKey: auth.access, fetch: authorizedFetch };
  };

  return {
    config: async (config) => {
      config.provider ??= {};
      const existing = config.provider[PROVIDER_ID];
      const seeded = Object.fromEntries(seed.map((m) => [m.id, toConfigModel(m)]));
      config.provider[PROVIDER_ID] = {
        npm: OPENAI_COMPATIBLE_NPM,
        name: "BitRouter",
        // A user's own `opencode.json` block is authoritative — this hook only
        // fills in what they did not write.
        ...existing,
        options: {
          baseURL: target.baseUrl,
          ...(configuredKey ? { apiKey: configuredKey } : {}),
          ...(existing?.options ?? {}),
        },
        models: { ...seeded, ...(existing?.models ?? {}) },
      };

      // Make BitRouter the default the moment the plugin is installed, so a
      // fresh `opencode.json` carrying nothing but `"plugin": ["@bitrouter/opencode"]`
      // lands on the auto route with no second configuration step.
      //
      // `??=` is the whole of the courtesy: a `model` the user wrote in their
      // own config, or another plugin set first, is already on `config` by the
      // time this hook runs and is left exactly as it stands. Title generation
      // and the other small-model errands go the same way — routing them
      // through `auto` is what the auto route is for, and BitRouter's own
      // policy ladder is a better judge of "cheap enough for this" than a
      // hardcoded second model id would be.
      config.model ??= AUTO_MODEL_REF;
      config.small_model ??= AUTO_MODEL_REF;
    },

    auth: {
      provider: PROVIDER_ID,
      loader,
      methods: [
        {
          type: "oauth",
          label: "BitRouter Cloud (device login)",
          authorize: async () => {
            const device = await requestDeviceAuthorization(oauthConfig);
            return {
              url: device.verificationUri,
              instructions: `Enter code ${device.userCode} to connect BitRouter Cloud. New accounts get free credits.`,
              method: "auto",
              callback: async () => {
                try {
                  const creds = await pollForToken(oauthConfig, device);
                  return { type: "success", ...creds };
                } catch (err) {
                  log("error", `device login failed: ${String(err)}`);
                  return { type: "failed" };
                }
              },
            };
          },
        },
        {
          type: "api",
          label: "API key (brvk_… from `bitrouter key sign`)",
        },
      ],
    },

    provider: {
      id: PROVIDER_ID,
      models: async (provider, ctx) => {
        const token = tokenFrom(ctx.auth) ?? configuredKey;
        let discovered: DiscoveredModel[];
        try {
          discovered = await discoverModels(target.baseUrl, token);
        } catch (err) {
          log("warn", `model refresh failed at ${target.baseUrl}/models: ${String(err)}`);
          return provider.models ?? {};
        }
        if (discovered.length === 0) {
          log("warn", "BitRouter returned an empty model catalog");
          return provider.models ?? {};
        }
        // The auto route leads the refreshed catalog too — a gateway that does
        // not list it yet must not have it disappear from under a session that
        // is already using it.
        return Object.fromEntries(
          withAutoModel(discovered).map((m) => [m.id, toRuntimeModel(m, provider)]),
        );
      },
    },
  };
};
