import type { AuthHook, Hooks, Plugin } from "@opencode-ai/plugin";
import type { Auth } from "@opencode-ai/sdk/v2";
import { bitrouter } from "./constants.js";
import { discoverModels, type DiscoveredModel } from "./discovery.js";
import { OPENAI_COMPATIBLE_NPM, toConfigModel, toRuntimeModel } from "./models.js";
import {
  EXPIRY_SKEW_MS,
  pollForToken,
  refreshCredentials,
  requestDeviceAuthorization,
  resolveOAuthConfig,
  type BitrouterCredentials,
} from "./oauth.js";
import { resolveSmartTarget } from "./target.js";

/** The provider id. Must match the key used in `opencode.json` and `/connect`. */
export const PROVIDER_ID = "bitrouter";

/** A placeholder catalog so the provider stays selectable before authentication. */
function placeholderModels(): DiscoveredModel[] {
  return [{ id: bitrouter.defaultModel, name: `${bitrouter.defaultModel} (BitRouter)` }];
}

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
  // token, so this usually falls back to the placeholder and the `provider`
  // hook fills in the real list later.
  let seed: DiscoveredModel[];
  try {
    seed = await discoverModels(target.baseUrl, configuredKey);
    if (seed.length === 0) {
      log("info", `no models at ${target.baseUrl}/models yet; using a placeholder`);
      seed = placeholderModels();
    }
  } catch (err) {
    log("info", `model discovery deferred (${String(err)}); using a placeholder`);
    seed = placeholderModels();
  }

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
        return Object.fromEntries(
          discovered.map((m) => [m.id, toRuntimeModel(m, provider)]),
        );
      },
    },
  };
};
