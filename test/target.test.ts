import { describe, it, expect, vi } from "vitest";
import { resolveTarget, resolveSmartTarget } from "../src/target.js";

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

describe("resolveTarget", () => {
  it("defaults to the local daemon", () => {
    expect(resolveTarget({})).toEqual({
      mode: "local",
      baseUrl: "http://127.0.0.1:4356/v1",
    });
  });

  it("honors BITROUTER_BASE_URL for local", () => {
    const t = resolveTarget({ BITROUTER_BASE_URL: "http://127.0.0.1:9999/v1" });
    expect(t).toEqual({ mode: "local", baseUrl: "http://127.0.0.1:9999/v1" });
  });

  it("selects cloud when BITROUTER_TARGET=cloud", () => {
    expect(resolveTarget({ BITROUTER_TARGET: "cloud" })).toEqual({
      mode: "cloud",
      baseUrl: "https://api.bitrouter.ai/v1",
    });
  });
});

describe("resolveSmartTarget", () => {
  it("prefers local when the daemon serves a non-empty catalog", async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse({ data: [{ id: "a" }] }));
    const t = await resolveSmartTarget({}, f as unknown as typeof fetch);
    expect(t.mode).toBe("local");
  });

  it("falls back to cloud when no daemon answers", async () => {
    const f = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const t = await resolveSmartTarget({}, f as unknown as typeof fetch);
    expect(t).toEqual({ mode: "cloud", baseUrl: "https://api.bitrouter.ai/v1" });
  });

  it("falls back to cloud when the daemon answers with an empty catalog", async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse({ data: [] }));
    const t = await resolveSmartTarget({}, f as unknown as typeof fetch);
    expect(t.mode).toBe("cloud");
  });

  it("does not probe when the target is explicit", async () => {
    const f = vi.fn();
    const t = await resolveSmartTarget(
      { BITROUTER_TARGET: "cloud" },
      f as unknown as typeof fetch,
    );
    expect(t.mode).toBe("cloud");
    expect(f).not.toHaveBeenCalled();
  });
});
