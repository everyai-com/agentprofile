// Pluggable memory backends. `builtin` (DO SQLite + Workers AI embeddings) is the
// default and is implemented in ProfileDO. These adapters let a profile instead
// route memory to a service the user already uses — their data, our one endpoint,
// with agentprofile's per-client grants and audit still wrapping every call.
//
// The external adapters follow each provider's documented REST shape. They are
// exercised only when a user configures a provider + API key; the builtin path
// needs no configuration and is what the test suite and demos use.

export type ProviderName = "builtin" | "mem0" | "supermemory";

export interface MemoryConfig {
  provider: ProviderName;
  apiKey?: string;
  userId?: string; // logical owner id passed to the provider (defaults to the profileId)
}

export interface ExtFact {
  id: string;
  fact: string;
  scope?: string;
  learned?: string;
}

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = { provider: "builtin" };

export function isExternal(cfg: MemoryConfig): boolean {
  return cfg.provider === "mem0" || cfg.provider === "supermemory";
}

export function validateConfig(cfg: MemoryConfig): string | null {
  if (!["builtin", "mem0", "supermemory"].includes(cfg.provider)) return `unknown provider: ${cfg.provider}`;
  if (isExternal(cfg) && !cfg.apiKey) return `${cfg.provider} requires an apiKey`;
  return null;
}

// ---- write / search / delete against the configured external provider ----

export async function extRemember(cfg: MemoryConfig, fact: string, scope: string): Promise<string> {
  const userId = cfg.userId || "agentprofile";
  if (cfg.provider === "mem0") {
    const r = await fetch("https://api.mem0.ai/v1/memories/", {
      method: "POST",
      headers: authHeaders(cfg, "Token"),
      body: JSON.stringify({
        messages: [{ role: "user", content: fact }],
        user_id: userId,
        metadata: { scope },
      }),
    });
    await ensureOk(r, "mem0 add");
    return "Remembered via Mem0.";
  }
  if (cfg.provider === "supermemory") {
    const r = await fetch("https://api.supermemory.ai/v3/memories", {
      method: "POST",
      headers: authHeaders(cfg, "Bearer"),
      body: JSON.stringify({ content: fact, containerTag: userId, metadata: { scope } }),
    });
    await ensureOk(r, "supermemory add");
    return "Remembered via Supermemory.";
  }
  throw new Error("builtin provider is handled in-DO");
}

export async function extRecall(cfg: MemoryConfig, query: string, limit: number): Promise<ExtFact[]> {
  const userId = cfg.userId || "agentprofile";
  if (cfg.provider === "mem0") {
    const r = await fetch("https://api.mem0.ai/v1/memories/search/", {
      method: "POST",
      headers: authHeaders(cfg, "Token"),
      body: JSON.stringify({ query, user_id: userId, limit }),
    });
    const data = (await jsonOk(r, "mem0 search")) as
      | { results?: Array<{ id: string; memory: string; metadata?: { scope?: string } }> }
      | Array<{ id: string; memory: string; metadata?: { scope?: string } }>;
    const rows = Array.isArray(data) ? data : data.results ?? [];
    return rows.slice(0, limit).map((m) => ({
      id: m.id,
      fact: m.memory,
      scope: m.metadata?.scope,
      learned: "Mem0",
    }));
  }
  if (cfg.provider === "supermemory") {
    const r = await fetch("https://api.supermemory.ai/v3/search", {
      method: "POST",
      headers: authHeaders(cfg, "Bearer"),
      body: JSON.stringify({ q: query, limit, containerTag: userId }),
    });
    const data = (await jsonOk(r, "supermemory search")) as {
      results?: Array<{ id?: string; documentId?: string; content?: string; memory?: string; metadata?: { scope?: string } }>;
    };
    return (data.results ?? []).slice(0, limit).map((m) => ({
      id: m.id || m.documentId || crypto.randomUUID(),
      fact: m.content || m.memory || "",
      scope: m.metadata?.scope,
      learned: "Supermemory",
    }));
  }
  throw new Error("builtin provider is handled in-DO");
}

export async function extForget(cfg: MemoryConfig, id: string): Promise<boolean> {
  if (cfg.provider === "mem0") {
    const r = await fetch(`https://api.mem0.ai/v1/memories/${encodeURIComponent(id)}/`, {
      method: "DELETE",
      headers: authHeaders(cfg, "Token"),
    });
    return r.ok;
  }
  if (cfg.provider === "supermemory") {
    const r = await fetch(`https://api.supermemory.ai/v3/memories/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: authHeaders(cfg, "Bearer"),
    });
    return r.ok;
  }
  throw new Error("builtin provider is handled in-DO");
}

// ---- helpers --------------------------------------------------------------

function authHeaders(cfg: MemoryConfig, scheme: "Token" | "Bearer"): Record<string, string> {
  return { "content-type": "application/json", authorization: `${scheme} ${cfg.apiKey}` };
}
async function ensureOk(r: Response, what: string): Promise<void> {
  if (!r.ok) throw new Error(`${what} failed: HTTP ${r.status}`);
}
async function jsonOk(r: Response, what: string): Promise<unknown> {
  if (!r.ok) throw new Error(`${what} failed: HTTP ${r.status}`);
  return r.json();
}
