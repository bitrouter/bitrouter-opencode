/**
 * BitRouter Cloud device-authorization-grant (RFC 8628) login, shaped for
 * opencode's `auth` hook. Endpoints are discovered from the RFC 8414 metadata
 * document — never hardcoded — and the poll loop honors the server `interval`
 * and `slow_down`.
 *
 * opencode's OAuth contract splits the flow in two: `authorize()` returns a URL
 * plus instructions to show the user, and `callback()` blocks until the grant
 * lands. So the device request and the token poll are separate exports here,
 * rather than one `login()` call. Kept dependency-free and injectable
 * (`fetch` / `now` / `sleep`) so it is unit-testable without the network.
 */

import { bitrouter } from "./constants.js";

export interface OAuthConfig {
  /** Authorization-server base, no trailing slash — e.g. `https://api.bitrouter.ai`. */
  authServer: string;
  /** Public OAuth client id (device flow needs no secret). */
  clientId: string;
  /** Space-separated scope string, or "" to omit. */
  scope: string;
}

/** Credentials in opencode's `OAuth` auth shape (`expires` = ms epoch). */
export interface BitrouterCredentials {
  access: string;
  refresh: string;
  expires: number;
}

/** Injected dependencies (defaulted to the globals) so tests avoid the network/clock. */
export interface OAuthDeps {
  fetch?: typeof fetch;
  now?: () => number;
  /** Interval delay between polls; defaults to a real, abortable timer. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const DEFAULT_AUTH_SERVER = bitrouter.cloud.authServer;
// The Rust `bitrouter` CLI registers this public client; reuse it so device
// login works against the existing authorization server with no new server-side
// registration. Swap in a dedicated client via env once one is minted.
const DEFAULT_CLIENT_ID = "bitrouter-cli";
// The CLI scope set the authorization server mints into a namespace-scoped token
// (mirrors the Rust CLI defaults; control-plane scopes are deliberately excluded).
const DEFAULT_SCOPE =
  "inference:invoke usage:read keys:read keys:write billing:read policy:read policy:write byok:read byok:write namespace:read";

const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const MINIMUM_INTERVAL_MS = 1000;
// RFC 8628 §3.2: default to 5s when the server omits `interval`.
const DEFAULT_INTERVAL_SECONDS = 5;
// RFC 8628 §3.5: `slow_down` increases the interval by 5s.
const SLOW_DOWN_INCREMENT_MS = 5000;
// Refresh slightly early so an in-flight request never rides an expiring token.
export const EXPIRY_SKEW_MS = 60_000;
const DEFAULT_TOKEN_TTL_MS = 3_600_000;

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export function resolveOAuthConfig(
  env: Record<string, string | undefined>,
): OAuthConfig {
  return {
    authServer: stripTrailingSlash(env.BITROUTER_OAUTH_AS ?? DEFAULT_AUTH_SERVER),
    clientId: env.BITROUTER_OAUTH_CLIENT_ID ?? DEFAULT_CLIENT_ID,
    scope: env.BITROUTER_OAUTH_SCOPE ?? DEFAULT_SCOPE,
  };
}

export interface AuthEndpoints {
  deviceAuthorizationEndpoint: string;
  tokenEndpoint: string;
}

export interface DeviceAuthorization {
  endpoints: AuthEndpoints;
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  intervalSeconds?: number;
  expiresInSeconds?: number;
}

type FormBody = Record<string, unknown>;

/**
 * POST an `application/x-www-form-urlencoded` body and return the parsed JSON.
 * RFC 8628 servers return `authorization_pending` / `slow_down` / errors with a
 * non-2xx status, so the body is parsed regardless of the HTTP status.
 */
async function postForm(
  fetchImpl: typeof fetch,
  url: string,
  fields: Record<string, string>,
  signal?: AbortSignal,
): Promise<FormBody> {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(fields),
    signal,
  });
  try {
    return (await res.json()) as FormBody;
  } catch {
    return {};
  }
}

/** RFC 8414 metadata discovery — learn the real endpoint paths, never hardcode them. */
export async function discoverAuthEndpoints(
  config: OAuthConfig,
  fetchImpl: typeof fetch,
): Promise<AuthEndpoints> {
  const url = `${config.authServer}/.well-known/oauth-authorization-server`;
  const res = await fetchImpl(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`BitRouter OAuth discovery failed: HTTP ${res.status}`);
  }
  const meta = (await res.json()) as {
    device_authorization_endpoint?: unknown;
    token_endpoint?: unknown;
  };
  if (
    typeof meta.device_authorization_endpoint !== "string" ||
    typeof meta.token_endpoint !== "string"
  ) {
    throw new Error(
      "BitRouter OAuth discovery is missing device_authorization_endpoint or token_endpoint",
    );
  }
  return {
    deviceAuthorizationEndpoint: meta.device_authorization_endpoint,
    tokenEndpoint: meta.token_endpoint,
  };
}

/**
 * Discover endpoints and claim a device code. The returned `verificationUri` is
 * what opencode shows (and opens) for the user; carry the whole object into
 * `pollForToken`.
 */
export async function requestDeviceAuthorization(
  config: OAuthConfig,
  deps: OAuthDeps = {},
  signal?: AbortSignal,
): Promise<DeviceAuthorization> {
  const fetchImpl = deps.fetch ?? fetch;
  const endpoints = await discoverAuthEndpoints(config, fetchImpl);
  const fields: Record<string, string> = { client_id: config.clientId };
  if (config.scope) fields.scope = config.scope;
  const body = await postForm(
    fetchImpl,
    endpoints.deviceAuthorizationEndpoint,
    fields,
    signal,
  );
  const deviceCode = body.device_code;
  const userCode = body.user_code;
  // Prefer the "complete" URI (embeds the code) so the user can one-click.
  const verificationUri = body.verification_uri_complete ?? body.verification_uri;
  if (
    typeof deviceCode !== "string" ||
    typeof userCode !== "string" ||
    typeof verificationUri !== "string"
  ) {
    const err = typeof body.error === "string" ? `: ${body.error}` : "";
    throw new Error(`BitRouter device authorization failed${err}`);
  }
  // The URI is opened in a browser — reject anything that isn't http(s).
  let parsed: URL;
  try {
    parsed = new URL(verificationUri);
  } catch {
    throw new Error("BitRouter returned an untrusted verification_uri");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("BitRouter returned an untrusted verification_uri");
  }
  return {
    endpoints,
    deviceCode,
    userCode,
    verificationUri: parsed.href,
    intervalSeconds: typeof body.interval === "number" ? body.interval : undefined,
    expiresInSeconds:
      typeof body.expires_in === "number" ? body.expires_in : undefined,
  };
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Login cancelled"));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("Login cancelled"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function toCredentials(token: FormBody, nowMs: number): BitrouterCredentials {
  const access = token.access_token;
  if (typeof access !== "string") {
    throw new Error("BitRouter token response missing access_token");
  }
  const ttlMs =
    typeof token.expires_in === "number"
      ? token.expires_in * 1000
      : DEFAULT_TOKEN_TTL_MS;
  return {
    access,
    refresh: typeof token.refresh_token === "string" ? token.refresh_token : "",
    expires: nowMs + ttlMs - EXPIRY_SKEW_MS,
  };
}

/** Poll the token endpoint until the user approves, the code expires, or we abort. */
export async function pollForToken(
  config: OAuthConfig,
  device: DeviceAuthorization,
  deps: OAuthDeps = {},
  signal?: AbortSignal,
): Promise<BitrouterCredentials> {
  const fetchImpl = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? abortableSleep;
  const deadline =
    device.expiresInSeconds != null
      ? now() + device.expiresInSeconds * 1000
      : Number.POSITIVE_INFINITY;
  let intervalMs = Math.max(
    MINIMUM_INTERVAL_MS,
    Math.floor((device.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS) * 1000),
  );
  // Wait one interval before the first poll — the user has to visit the URL.
  await sleep(Math.min(intervalMs, Math.max(0, deadline - now())), signal);
  while (now() < deadline) {
    if (signal?.aborted) throw new Error("Login cancelled");
    const body = await postForm(
      fetchImpl,
      device.endpoints.tokenEndpoint,
      {
        client_id: config.clientId,
        device_code: device.deviceCode,
        grant_type: DEVICE_CODE_GRANT,
      },
      signal,
    );
    if (typeof body.access_token === "string") return toCredentials(body, now());
    const error = typeof body.error === "string" ? body.error : undefined;
    if (error === "authorization_pending") {
      // keep polling at the current interval
    } else if (error === "slow_down") {
      intervalMs =
        typeof body.interval === "number" && body.interval > 0
          ? Math.max(MINIMUM_INTERVAL_MS, Math.floor(body.interval * 1000))
          : intervalMs + SLOW_DOWN_INCREMENT_MS;
    } else if (error) {
      throw new Error(`BitRouter device login failed: ${error}`);
    } else {
      throw new Error("BitRouter device login: invalid token response");
    }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(intervalMs, remaining), signal);
  }
  throw new Error("BitRouter device login timed out");
}

/** Exchange the refresh token for a fresh access token. */
export async function refreshCredentials(
  config: OAuthConfig,
  creds: BitrouterCredentials,
  deps: OAuthDeps = {},
): Promise<BitrouterCredentials> {
  const fetchImpl = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  if (!creds.refresh) {
    throw new Error("BitRouter credentials have no refresh token");
  }
  const endpoints = await discoverAuthEndpoints(config, fetchImpl);
  const body = await postForm(fetchImpl, endpoints.tokenEndpoint, {
    client_id: config.clientId,
    grant_type: "refresh_token",
    refresh_token: creds.refresh,
  });
  if (typeof body.access_token !== "string") {
    const err = typeof body.error === "string" ? `: ${body.error}` : "";
    throw new Error(`BitRouter token refresh failed${err}`);
  }
  const next = toCredentials(body, now());
  // Preserve the current refresh token when the server doesn't rotate it.
  if (!next.refresh) next.refresh = creds.refresh;
  return next;
}
