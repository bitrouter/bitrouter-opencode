import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Hooks, PluginInput } from "@opencode-ai/plugin";
import { AUTO_MODEL_REF, BitRouterPlugin, PROVIDER_ID } from "../src/index.js";

/**
 * Behavioral tests for the three hooks the plugin returns. The contract:
 *
 *  - `config` declares a working `bitrouter` provider without a hand-written
 *    opencode.json, and never overwrites what the user did write.
 *  - `auth.loader` turns whichever credential is stored into provider options,
 *    refreshing an expired OAuth grant rather than sending a dead token.
 *  - `provider.models` replaces the seed catalog with the live one, and keeps
 *    the current catalog rather than blanking it when discovery fails.
 *
 * The `auto` route leads every catalog these hooks produce, and `config` names
 * it as the default model, which is what makes a bare
 * `"plugin": ["@bitrouter/opencode"]` a complete installation.
 */

const CATALOG = {
  data: [
    { id: "kimi-k2.5", name: "Kimi K2.5", max_input_tokens: 256000 },
    {
      id: "claude-opus-4-8",
      name: "Claude Opus 4.8",
      capabilities: ["reasoning", "tools"],
    },
  ],
};

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const authSet = vi.fn().mockResolvedValue(undefined);
const appLog = vi.fn().mockResolvedValue(undefined);

function pluginInput(): PluginInput {
  return {
    client: { app: { log: appLog }, auth: { set: authSet } },
  } as unknown as PluginInput;
}

/** Route by URL so each test only declares the responses it cares about. */
function stubFetch(routes: Record<string, unknown>, fallback?: unknown) {
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    void init;
    for (const [needle, body] of Object.entries(routes)) {
      if (url.includes(needle)) {
        return body instanceof Error ? Promise.reject(body) : jsonResponse(body);
      }
    }
    if (fallback !== undefined) return jsonResponse(fallback);
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", impl);
  return impl;
}

// The plugin reads process.env at load time, so each test starts from a clean
// slate rather than inheriting whatever the developer has exported.
const BITROUTER_ENV = [
  "BITROUTER_TARGET",
  "BITROUTER_API_KEY",
  "BITROUTER_BASE_URL",
] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  authSet.mockClear();
  appLog.mockClear();
  savedEnv = Object.fromEntries(BITROUTER_ENV.map((k) => [k, process.env[k]]));
  for (const k of BITROUTER_ENV) delete process.env[k];
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** The provider block the `config` hook wrote, typed loosely for assertions. */
type ProviderBlock = {
  npm?: string;
  name?: string;
  options: { baseURL?: string; apiKey?: string };
  models: Record<string, { name?: string; limit?: { context?: number; output?: number } }>;
};

function providerBlock(config: unknown): ProviderBlock {
  const provider = (config as { provider?: Record<string, ProviderBlock> }).provider;
  const block = provider?.[PROVIDER_ID];
  if (!block) throw new Error("config hook did not declare the bitrouter provider");
  return block;
}

/** The RequestInit the stubbed fetch was last called with. */
function lastInit(impl: ReturnType<typeof stubFetch>): RequestInit {
  return (impl.mock.calls.at(-1)?.[1] ?? {}) as RequestInit;
}

async function load(env: Record<string, string> = {}): Promise<Hooks> {
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  return BitRouterPlugin(pluginInput());
}

describe("config hook", () => {
  it("declares the provider with the discovered catalog", async () => {
    stubFetch({ "/models": CATALOG });
    const hooks = await load({ BITROUTER_TARGET: "local" });
    const config = {};
    await hooks.config!(config);

    const p = providerBlock(config);
    expect(p.npm).toBe("@ai-sdk/openai-compatible");
    expect(p.name).toBe("BitRouter");
    expect(p.options.baseURL).toBe("http://127.0.0.1:4356/v1");
    // loopback daemons run skip_auth, but opencode still wants a key present
    expect(p.options.apiKey).toBe("bitrouter-local");
    expect(Object.keys(p.models).sort()).toEqual(["auto", "claude-opus-4-8", "kimi-k2.5"]);
    expect(p.models["kimi-k2.5"].name).toBe("Kimi K2.5");
    expect(p.models["kimi-k2.5"].limit?.context).toBe(256000);
  });

  it("makes the auto route the default model and small model", async () => {
    stubFetch({ "/models": CATALOG });
    const hooks = await load({ BITROUTER_TARGET: "local" });
    const config: Record<string, unknown> = {};
    await hooks.config!(config);

    expect(config.model).toBe(AUTO_MODEL_REF);
    expect(config.model).toBe("bitrouter/auto");
    expect(config.small_model).toBe(AUTO_MODEL_REF);
  });

  it("leaves a model the user already chose alone", async () => {
    stubFetch({ "/models": CATALOG });
    const hooks = await load({ BITROUTER_TARGET: "local" });
    const config: Record<string, unknown> = {
      model: "anthropic/claude-opus-4-8",
      small_model: "anthropic/claude-haiku-4.5",
    };
    await hooks.config!(config as never);

    expect(config.model).toBe("anthropic/claude-opus-4-8");
    expect(config.small_model).toBe("anthropic/claude-haiku-4.5");
  });

  it("still offers the auto route when the catalog is unreachable", async () => {
    stubFetch({ "/models": new Error("ECONNREFUSED") });
    const hooks = await load({ BITROUTER_TARGET: "cloud" });
    const config = {};
    await hooks.config!(config);

    const p = providerBlock(config);
    expect(p.options.baseURL).toBe("https://api.bitrouter.ai/v1");
    // no filler key on cloud — the user authenticates for real
    expect(p.options.apiKey).toBeUndefined();
    // Unreachable is not unusable: the auto route keeps the provider
    // selectable, which is what makes `/connect` reachable at all.
    expect(Object.keys(p.models)).toEqual(["auto"]);
  });

  it("does not overwrite a provider block the user wrote", async () => {
    stubFetch({ "/models": CATALOG });
    const hooks = await load({ BITROUTER_TARGET: "local" });
    const config = {
      provider: {
        [PROVIDER_ID]: {
          name: "My BitRouter",
          options: { baseURL: "https://proxy.internal/v1" },
          models: { "my-model": { name: "Mine" } },
        },
      },
    };
    await hooks.config!(config as never);

    const p = providerBlock(config);
    expect(p.name).toBe("My BitRouter");
    expect(p.options.baseURL).toBe("https://proxy.internal/v1");
    // the user's model survives, and the discovered ones are added alongside
    expect(Object.keys(p.models).sort()).toEqual([
      "auto",
      "claude-opus-4-8",
      "kimi-k2.5",
      "my-model",
    ]);
    // npm was absent, so the plugin filled it in
    expect(p.npm).toBe("@ai-sdk/openai-compatible");
  });

  it("passes an explicit BITROUTER_API_KEY through to the provider options", async () => {
    stubFetch({ "/models": CATALOG });
    const hooks = await load({ BITROUTER_TARGET: "local", BITROUTER_API_KEY: "brvk_xyz" });
    const config = {};
    await hooks.config!(config);
    expect(providerBlock(config).options.apiKey).toBe("brvk_xyz");
  });
});

describe("auth hook", () => {
  it("offers both a device login and an API key, for the bitrouter provider", async () => {
    stubFetch({ "/models": CATALOG });
    const hooks = await load({ BITROUTER_TARGET: "local" });
    expect(hooks.auth!.provider).toBe(PROVIDER_ID);
    expect(hooks.auth!.methods.map((m) => m.type)).toEqual(["oauth", "api"]);
  });

  it("loads a stored API key straight into provider options", async () => {
    stubFetch({ "/models": CATALOG });
    const hooks = await load({ BITROUTER_TARGET: "local" });
    const opts = await hooks.auth!.loader!(
      async () => ({ type: "api", key: "brvk_stored" }),
      {} as never,
    );
    expect(opts).toEqual({ apiKey: "brvk_stored" });
  });

  it("authorizes an OAuth grant with a request-time bearer token", async () => {
    const impl = stubFetch({ "/models": CATALOG }, { ok: true });
    const hooks = await load({ BITROUTER_TARGET: "local" });
    const notExpired = Date.now() + 3_600_000;
    const opts = (await hooks.auth!.loader!(
      async () => ({ type: "oauth", access: "at_live", refresh: "rt", expires: notExpired }),
      {} as never,
    )) as { apiKey: string; fetch: typeof fetch };

    expect(opts.apiKey).toBe("at_live");
    await opts.fetch("https://api.bitrouter.ai/v1/chat/completions", { method: "POST" });
    expect(new Headers(lastInit(impl).headers).get("Authorization")).toBe("Bearer at_live");
    // an unexpired grant must not burn the refresh token
    expect(authSet).not.toHaveBeenCalled();
  });

  it("refreshes and persists an expired OAuth grant before the request", async () => {
    const impl = stubFetch(
      {
        "/models": CATALOG,
        "/.well-known/": {
          device_authorization_endpoint: "https://api.bitrouter.ai/oauth/device",
          token_endpoint: "https://api.bitrouter.ai/oauth/token",
        },
        "/oauth/token": { access_token: "at_fresh", expires_in: 3600 },
      },
      { ok: true },
    );
    const hooks = await load({ BITROUTER_TARGET: "local" });
    const opts = (await hooks.auth!.loader!(
      async () => ({ type: "oauth", access: "at_stale", refresh: "rt", expires: 0 }),
      {} as never,
    )) as { fetch: typeof fetch };

    await opts.fetch("https://api.bitrouter.ai/v1/chat/completions");
    expect(new Headers(lastInit(impl).headers).get("Authorization")).toBe("Bearer at_fresh");
    expect(authSet).toHaveBeenCalledWith({
      path: { id: PROVIDER_ID },
      body: expect.objectContaining({ type: "oauth", access: "at_fresh", refresh: "rt" }),
    });
  });

  it("falls back to the stale token rather than failing the request when refresh breaks", async () => {
    const impl = stubFetch(
      {
        "/models": CATALOG,
        "/.well-known/": { device_authorization_endpoint: "d", token_endpoint: "t" },
      },
      { error: "invalid_grant" },
    );
    const hooks = await load({ BITROUTER_TARGET: "local" });
    const opts = (await hooks.auth!.loader!(
      async () => ({ type: "oauth", access: "at_stale", refresh: "rt", expires: 0 }),
      {} as never,
    )) as { fetch: typeof fetch };

    await opts.fetch("https://api.bitrouter.ai/v1/chat/completions");
    expect(new Headers(lastInit(impl).headers).get("Authorization")).toBe("Bearer at_stale");
  });
});

describe("provider hook", () => {
  const provider = {
    id: PROVIDER_ID,
    models: { seeded: { api: { id: "x", url: "u", npm: "n" } } },
    options: { baseURL: "http://127.0.0.1:4356/v1" },
  } as never;

  it("replaces the seed catalog with the live one", async () => {
    stubFetch({ "/models": CATALOG });
    const hooks = await load({ BITROUTER_TARGET: "local" });
    const models = await hooks.provider!.models!(provider, {
      auth: { type: "api", key: "brvk_1" },
    });
    expect(Object.keys(models).sort()).toEqual(["auto", "claude-opus-4-8", "kimi-k2.5"]);
    expect(models["kimi-k2.5"].limit.context).toBe(256000);
  });

  it("keeps the current catalog when discovery fails", async () => {
    stubFetch({ "/models": CATALOG });
    const hooks = await load({ BITROUTER_TARGET: "local" });
    stubFetch({ "/models": new Error("boom") });
    const models = await hooks.provider!.models!(provider, {});
    expect(Object.keys(models)).toEqual(["seeded"]);
  });

  it("keeps the current catalog when BitRouter returns nothing", async () => {
    stubFetch({ "/models": CATALOG });
    const hooks = await load({ BITROUTER_TARGET: "local" });
    stubFetch({ "/models": { data: [] } });
    const models = await hooks.provider!.models!(provider, {});
    expect(Object.keys(models)).toEqual(["seeded"]);
  });
});
