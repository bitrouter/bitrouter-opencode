import { bitrouter } from "./constants.js";

export type TargetMode = "local" | "cloud";
export interface Target {
  mode: TargetMode;
  baseUrl: string;
}

const LOCAL_DEFAULT = bitrouter.local.apiBaseUrl;
const CLOUD_DEFAULT = bitrouter.cloud.apiBaseUrl;

/** Resolve which BitRouter data plane the provider should target. */
export function resolveTarget(env: Record<string, string | undefined>): Target {
  const mode: TargetMode = env.BITROUTER_TARGET === "cloud" ? "cloud" : "local";
  if (mode === "cloud") {
    return { mode, baseUrl: env.BITROUTER_BASE_URL ?? CLOUD_DEFAULT };
  }
  return { mode, baseUrl: env.BITROUTER_BASE_URL ?? LOCAL_DEFAULT };
}

/** True when a local daemon answers `/models` with a non-empty catalog. */
export async function localDaemonServesModels(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const res = await fetchImpl(`${baseUrl}/models`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return false;
    const payload = (await res.json()) as { data?: unknown[] };
    return Array.isArray(payload.data) && payload.data.length > 0;
  } catch {
    return false;
  }
}

/**
 * Pick the data plane. An explicit `BITROUTER_TARGET` always wins. Otherwise
 * prefer a **reachable local daemon** (zero-login dev flow) and fall back to
 * **cloud** (device-OAuth onboarding) when none is serving models — so a fresh
 * install lands on cloud while a running daemon keeps its no-login experience.
 */
export async function resolveSmartTarget(
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch = fetch,
): Promise<Target> {
  if (env.BITROUTER_TARGET === "local" || env.BITROUTER_TARGET === "cloud") {
    return resolveTarget(env);
  }
  const local = resolveTarget({ ...env, BITROUTER_TARGET: "local" });
  if (await localDaemonServesModels(local.baseUrl, fetchImpl)) return local;
  return resolveTarget({ ...env, BITROUTER_TARGET: "cloud" });
}
