/**
 * One entry from BitRouter's `GET /v1/models` response. BitRouter enriches the
 * plain OpenAI shape with routing/pricing metadata; everything past `id` is
 * optional because a bare OpenAI-compatible upstream will not send it.
 */
export interface DiscoveredModel {
  id: string;
  object?: string;
  providers?: string[];
  name?: string;
  reasoning?: boolean;
  tool_call?: boolean;
  input_modalities?: string[];
  output_modalities?: string[];
  context_window?: number;
  max_output_tokens?: number;
  cost?: {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
  };
}

/**
 * Fetch BitRouter's model catalog. Throws on a non-OK response so the caller
 * can decide between "fall back to a placeholder" and "surface the error".
 */
export async function discoverModels(
  baseUrl: string,
  apiKey: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<DiscoveredModel[]> {
  const headers: Record<string, string> = {};
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  const res = await fetchImpl(`${baseUrl}/models`, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const payload = (await res.json()) as { data?: DiscoveredModel[] };
  return payload.data ?? [];
}
