import { describe, it, expect, vi } from "vitest";
import {
  resolveOAuthConfig,
  requestDeviceAuthorization,
  pollForToken,
  refreshCredentials,
  type OAuthConfig,
  type OAuthDeps,
} from "../src/oauth.js";

const CONFIG: OAuthConfig = {
  authServer: "https://as.test",
  clientId: "bitrouter-cli",
  scope: "inference:invoke",
};

const META = {
  device_authorization_endpoint: "https://as.test/oauth/device",
  token_endpoint: "https://as.test/oauth/token",
};

const DEVICE = {
  device_code: "dev_abc",
  user_code: "WXYZ-1234",
  verification_uri: "https://cloud.bitrouter.ai/oauth/device",
  verification_uri_complete:
    "https://cloud.bitrouter.ai/oauth/device?user_code=WXYZ-1234",
  interval: 5,
  expires_in: 900,
};

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

/** A fetch double answering discovery + device-auth from fixtures, draining
 * `tokenQueue` sequentially for the token endpoint. */
function makeFetch(opts: {
  meta?: unknown;
  metaStatus?: number;
  device?: unknown;
  tokenQueue?: unknown[];
}) {
  const calls: string[] = [];
  const queue = [...(opts.tokenQueue ?? [])];
  const impl = vi.fn(async (url: string) => {
    calls.push(url);
    if (url.includes("/.well-known/")) {
      return jsonResponse(opts.meta ?? META, opts.metaStatus ?? 200);
    }
    if (url === META.device_authorization_endpoint) {
      return jsonResponse(opts.device ?? DEVICE);
    }
    if (url === META.token_endpoint) {
      return jsonResponse(queue.shift() ?? { error: "authorization_pending" });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

/** Deterministic clock + instant sleep, so poll loops run without real time. */
function deps(f: typeof fetch, extra: Partial<OAuthDeps> = {}): OAuthDeps {
  let t = 1_000_000;
  return {
    fetch: f,
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    ...extra,
  };
}

describe("resolveOAuthConfig", () => {
  it("defaults to BitRouter Cloud", () => {
    const c = resolveOAuthConfig({});
    expect(c.authServer).toBe("https://api.bitrouter.ai");
    expect(c.clientId).toBe("bitrouter-cli");
    expect(c.scope).toContain("inference:invoke");
  });

  it("honors env overrides and strips a trailing slash", () => {
    const c = resolveOAuthConfig({
      BITROUTER_OAUTH_AS: "https://as.example.com//",
      BITROUTER_OAUTH_CLIENT_ID: "custom",
      BITROUTER_OAUTH_SCOPE: "a b",
    });
    expect(c).toEqual({
      authServer: "https://as.example.com",
      clientId: "custom",
      scope: "a b",
    });
  });
});

describe("requestDeviceAuthorization", () => {
  it("discovers endpoints and claims a device code", async () => {
    const { impl, calls } = makeFetch({});
    const d = await requestDeviceAuthorization(CONFIG, deps(impl));
    expect(d.deviceCode).toBe("dev_abc");
    expect(d.userCode).toBe("WXYZ-1234");
    // the "complete" URI wins so the user can one-click
    expect(d.verificationUri).toBe(DEVICE.verification_uri_complete);
    expect(d.endpoints).toEqual({
      deviceAuthorizationEndpoint: META.device_authorization_endpoint,
      tokenEndpoint: META.token_endpoint,
    });
    expect(calls[0]).toBe("https://as.test/.well-known/oauth-authorization-server");
  });

  it("fails when discovery is unavailable", async () => {
    const { impl } = makeFetch({ metaStatus: 500 });
    await expect(requestDeviceAuthorization(CONFIG, deps(impl))).rejects.toThrow(
      /discovery failed: HTTP 500/,
    );
  });

  it("fails when the metadata omits the required endpoints", async () => {
    const { impl } = makeFetch({ meta: { token_endpoint: "https://as.test/t" } });
    await expect(requestDeviceAuthorization(CONFIG, deps(impl))).rejects.toThrow(
      /missing device_authorization_endpoint/,
    );
  });

  it("rejects a non-http(s) verification uri", async () => {
    const { impl } = makeFetch({
      device: { ...DEVICE, verification_uri_complete: "javascript:alert(1)" },
    });
    await expect(requestDeviceAuthorization(CONFIG, deps(impl))).rejects.toThrow(
      /untrusted verification_uri/,
    );
  });

  it("surfaces a server-reported error", async () => {
    const { impl } = makeFetch({ device: { error: "invalid_client" } });
    await expect(requestDeviceAuthorization(CONFIG, deps(impl))).rejects.toThrow(
      /invalid_client/,
    );
  });
});

describe("pollForToken", () => {
  it("polls past authorization_pending and returns credentials", async () => {
    const { impl } = makeFetch({
      tokenQueue: [
        { error: "authorization_pending" },
        { error: "authorization_pending" },
        { access_token: "at_1", refresh_token: "rt_1", expires_in: 3600 },
      ],
    });
    const d = deps(impl);
    const device = await requestDeviceAuthorization(CONFIG, d);
    const creds = await pollForToken(CONFIG, device, d);
    expect(creds.access).toBe("at_1");
    expect(creds.refresh).toBe("rt_1");
    // ms epoch, refreshed a minute early
    expect(creds.expires).toBeGreaterThan(1_000_000);
  });

  it("backs off on slow_down and still completes", async () => {
    const { impl } = makeFetch({
      tokenQueue: [{ error: "slow_down" }, { access_token: "at_2", expires_in: 60 }],
    });
    const d = deps(impl);
    const device = await requestDeviceAuthorization(CONFIG, d);
    const creds = await pollForToken(CONFIG, device, d);
    expect(creds.access).toBe("at_2");
    expect(creds.refresh).toBe("");
  });

  it("throws on a terminal error", async () => {
    const { impl } = makeFetch({ tokenQueue: [{ error: "access_denied" }] });
    const d = deps(impl);
    const device = await requestDeviceAuthorization(CONFIG, d);
    await expect(pollForToken(CONFIG, device, d)).rejects.toThrow(/access_denied/);
  });

  it("times out once the device code expires", async () => {
    const { impl } = makeFetch({
      device: { ...DEVICE, expires_in: 6 },
      tokenQueue: [{ error: "authorization_pending" }, { error: "authorization_pending" }],
    });
    const d = deps(impl);
    const device = await requestDeviceAuthorization(CONFIG, d);
    await expect(pollForToken(CONFIG, device, d)).rejects.toThrow(/timed out/);
  });

  it("honors an abort signal", async () => {
    const { impl } = makeFetch({ tokenQueue: [] });
    const d = deps(impl);
    const device = await requestDeviceAuthorization(CONFIG, d);
    const ac = new AbortController();
    ac.abort();
    await expect(pollForToken(CONFIG, device, d, ac.signal)).rejects.toThrow(
      /cancelled/,
    );
  });
});

describe("refreshCredentials", () => {
  it("exchanges the refresh token", async () => {
    const { impl } = makeFetch({
      tokenQueue: [{ access_token: "at_new", refresh_token: "rt_new", expires_in: 3600 }],
    });
    const creds = await refreshCredentials(
      CONFIG,
      { access: "old", refresh: "rt_1", expires: 0 },
      deps(impl),
    );
    expect(creds.access).toBe("at_new");
    expect(creds.refresh).toBe("rt_new");
  });

  it("keeps the existing refresh token when the server does not rotate it", async () => {
    const { impl } = makeFetch({ tokenQueue: [{ access_token: "at_new" }] });
    const creds = await refreshCredentials(
      CONFIG,
      { access: "old", refresh: "rt_keep", expires: 0 },
      deps(impl),
    );
    expect(creds.refresh).toBe("rt_keep");
  });

  it("refuses without a refresh token", async () => {
    const { impl } = makeFetch({});
    await expect(
      refreshCredentials(CONFIG, { access: "a", refresh: "", expires: 0 }, deps(impl)),
    ).rejects.toThrow(/no refresh token/);
  });

  it("surfaces a server-reported refresh failure", async () => {
    const { impl } = makeFetch({ tokenQueue: [{ error: "invalid_grant" }] });
    await expect(
      refreshCredentials(CONFIG, { access: "a", refresh: "r", expires: 0 }, deps(impl)),
    ).rejects.toThrow(/invalid_grant/);
  });
});
