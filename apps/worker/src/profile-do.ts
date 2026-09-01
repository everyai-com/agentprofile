import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index";
import { sha256Hex, timingSafeEqual } from "./auth";
import { TOOLS } from "./tools";
import {
  type MemoryConfig,
  DEFAULT_MEMORY_CONFIG,
  isExternal,
  validateConfig,
  extRemember,
  extRecall,
  extForget,
} from "./memory-providers";

// One instance per user profile. Routed by profileId (idFromName). Owns the
// profile's SQLite: the init secret hash, memory facts, and installed skills.
export class ProfileDO extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // Synchronous schema init — safe to run on every construction.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );
      CREATE TABLE IF NOT EXISTS facts (
        id TEXT PRIMARY KEY,
        body TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'general',
        source_client TEXT,
        created INTEGER NOT NULL,
        updated INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_facts_scope ON facts(scope);
      -- config: memory provider selection etc. (key/value JSON)
      CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS skills (
        slug TEXT NOT NULL,
        version TEXT NOT NULL,
        summary TEXT,
        r2_key TEXT,
        body TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        installed INTEGER NOT NULL,
        PRIMARY KEY (slug)
      );
      -- Phase 2: per-client access control. One grant per connected tool.
      CREATE TABLE IF NOT EXISTS grants (
        client TEXT PRIMARY KEY,
        scopes TEXT NOT NULL,
        revoked INTEGER NOT NULL DEFAULT 0,
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL
      );
      -- MCP sessions map a session id (returned on initialize) to a client, so we
      -- can attribute and authorize each later tools/call to the right grant.
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        client TEXT NOT NULL,
        created INTEGER NOT NULL
      );
      -- Append-only audit of every authorized/denied tool call.
      CREATE TABLE IF NOT EXISTS audit (
        ts INTEGER NOT NULL,
        client TEXT NOT NULL,
        tool TEXT NOT NULL,
        allowed INTEGER NOT NULL,
        detail TEXT
      );
      -- Zero-knowledge credentials: the server stores ONLY ciphertext and the
      -- wrapped data key. It never receives, holds, or can derive the master key
      -- or the plaintext. Encryption/decryption happen client-side.
      CREATE TABLE IF NOT EXISTS secrets (
        name TEXT PRIMARY KEY,
        ciphertext TEXT NOT NULL,
        wrapped_dek TEXT NOT NULL,
        algo TEXT NOT NULL,
        created INTEGER NOT NULL,
        updated INTEGER NOT NULL
      );
    `);
    // Add the embedding column if an older profile predates semantic recall.
    const cols = this.rows<{ name: string }>(`PRAGMA table_info(facts)`);
    if (!cols.some((c) => c.name === "embedding")) {
      this.sql.exec(`ALTER TABLE facts ADD COLUMN embedding BLOB`);
    }
  }

  // ---- Embeddings (semantic recall) --------------------------------------
  private static readonly EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";

  // Returns a Float32Array embedding, or null if Workers AI is unavailable.
  private async embed(text: string): Promise<Float32Array | null> {
    if (!this.env.AI) return null;
    try {
      const res = (await this.env.AI.run(ProfileDO.EMBED_MODEL, { text: [text] })) as {
        data?: number[][];
      };
      const vec = res?.data?.[0];
      return vec && vec.length ? new Float32Array(vec) : null;
    } catch {
      return null;
    }
  }

  // ---- Live sync (WebSocket) ---------------------------------------------
  // The Worker forwards `GET /live?token=...` upgrade requests here. Any mutation
  // (remember/forget/installSkill) broadcasts to all connected viewers, so the
  // dashboard updates the instant an agent writes to the profile — the live demo.
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/live")) {
      const secret = url.searchParams.get("s") || "";
      if (!(await this.verify(secret))) return new Response("unauthorized", { status: 401 });
      if (request.headers.get("upgrade") !== "websocket")
        return new Response("expected websocket", { status: 426 });
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      this.ctx.acceptWebSocket(server);
      server.send(JSON.stringify({ type: "snapshot", ...this.snapshot() }));
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response("not found", { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // The only client message we honor is a ping/refresh request.
    if (typeof message === "string" && message.includes("refresh")) {
      ws.send(JSON.stringify({ type: "snapshot", ...this.snapshot() }));
    }
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try { ws.close(code, "closing"); } catch { /* already closed */ }
  }

  private broadcast(event: Record<string, unknown>): void {
    const msg = JSON.stringify(event);
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(msg); } catch { /* drop dead sockets */ }
    }
  }

  private snapshot() {
    const skills = this.rows<{ slug: string; version: string; summary: string | null; enabled: number }>(
      `SELECT slug, version, summary, enabled FROM skills ORDER BY slug`,
    );
    const facts = this.rows<Fact>(`SELECT * FROM facts ORDER BY updated DESC LIMIT 200`);
    return {
      skills: skills.map((s) => ({ slug: s.slug, version: s.version, summary: s.summary, enabled: !!s.enabled })),
      facts: facts.map((f) => ({ id: f.id, body: f.body, scope: f.scope, learned: provenance(f) })),
      ...this.accessSnapshot(),
    };
  }

  // ---- Provisioning -------------------------------------------------------

  // Called once, right after the DO is created, to store the secret hash.
  async provision(secretHash: string): Promise<void> {
    const existing = this.getMeta("secret_hash");
    if (existing) throw new Error("profile already provisioned");
    this.setMeta("secret_hash", secretHash);
    this.setMeta("created", String(Date.now()));
  }

  async isProvisioned(): Promise<boolean> {
    return this.getMeta("secret_hash") !== null;
  }

  private async verify(secret: string): Promise<boolean> {
    const stored = this.getMeta("secret_hash");
    if (!stored) return false;
    const got = await sha256Hex(secret);
    return timingSafeEqual(got, stored);
  }

  // ---- Grants, sessions, audit (Phase 2) ---------------------------------

  // The scope each tool requires. Secrets tools (Phase 3) will default-deny.
  private static readonly TOOL_SCOPE: Record<string, string> = {
    get_context: "memory:read",
    list_skills: "skills:read",
    get_skill: "skills:read",
    remember: "memory:write",
    recall: "memory:read",
    forget: "memory:write",
    list_credentials: "secrets:read",
    get_credential: "secrets:read",
  };
  private static readonly DEFAULT_SCOPES = ["skills:read", "memory:read", "memory:write"];

  // Create/refresh a grant for a client (called on MCP initialize) and open a
  // session. Returns the session id the client should echo as Mcp-Session-Id.
  async createSession(secret: string, client: string): Promise<string | null> {
    if (!(await this.verify(secret))) return null;
    this.ensureGrant(client);
    const id = crypto.randomUUID();
    this.sql.exec(`INSERT INTO sessions (id, client, created) VALUES (?, ?, ?)`, id, client, Date.now());
    return id;
  }

  private ensureGrant(client: string): void {
    const now = Date.now();
    const existing = this.rows<{ client: string }>(`SELECT client FROM grants WHERE client = ?`, client)[0];
    if (existing) {
      this.sql.exec(`UPDATE grants SET last_seen = ? WHERE client = ?`, now, client);
    } else {
      this.sql.exec(
        `INSERT INTO grants (client, scopes, revoked, first_seen, last_seen) VALUES (?, ?, 0, ?, ?)`,
        client,
        JSON.stringify(ProfileDO.DEFAULT_SCOPES),
        now,
        now,
      );
      this.broadcast({ type: "grant_changed", client });
    }
  }

  private resolveClient(sessionId: string | undefined, fallback: string): string {
    if (sessionId) {
      const r = this.rows<{ client: string }>(`SELECT client FROM sessions WHERE id = ?`, sessionId)[0];
      if (r) return r.client;
    }
    return fallback;
  }

  private grantAllows(client: string, scope: string): boolean {
    const g = this.rows<{ scopes: string; revoked: number }>(
      `SELECT scopes, revoked FROM grants WHERE client = ?`,
      client,
    )[0];
    if (!g) return true; // no grant record yet (e.g. legacy) → allow; grant is created on next initialize
    if (g.revoked) return false;
    try {
      return (JSON.parse(g.scopes) as string[]).includes(scope);
    } catch {
      return false;
    }
  }

  private writeAudit(client: string, tool: string, allowed: boolean, detail = ""): void {
    this.sql.exec(
      `INSERT INTO audit (ts, client, tool, allowed, detail) VALUES (?, ?, ?, ?, ?)`,
      Date.now(),
      client,
      tool,
      allowed ? 1 : 0,
      detail,
    );
    this.broadcast({ type: "audit", client, tool, allowed, ts: Date.now() });
  }

  // Dashboard/CLI management (all secret-gated).
  async listAccess(secret: string) {
    if (!(await this.verify(secret))) return null;
    return this.accessSnapshot();
  }
  async setScopes(secret: string, client: string, scopes: string[]): Promise<boolean> {
    if (!(await this.verify(secret))) return false;
    this.sql.exec(`UPDATE grants SET scopes = ? WHERE client = ?`, JSON.stringify(scopes), client);
    this.broadcast({ type: "grant_changed", client });
    return true;
  }
  async setRevoked(secret: string, client: string, revoked: boolean): Promise<boolean> {
    if (!(await this.verify(secret))) return false;
    this.sql.exec(`UPDATE grants SET revoked = ? WHERE client = ?`, revoked ? 1 : 0, client);
    if (revoked) this.sql.exec(`DELETE FROM sessions WHERE client = ?`, client);
    this.broadcast({ type: "grant_changed", client });
    return true;
  }

  private accessSnapshot() {
    const grants = this.rows<{ client: string; scopes: string; revoked: number; first_seen: number; last_seen: number }>(
      `SELECT * FROM grants ORDER BY last_seen DESC`,
    ).map((g) => ({
      client: g.client,
      scopes: safeParse(g.scopes),
      revoked: !!g.revoked,
      firstSeen: g.first_seen,
      lastSeen: g.last_seen,
    }));
    const audit = this.rows<{ ts: number; client: string; tool: string; allowed: number }>(
      `SELECT ts, client, tool, allowed FROM audit ORDER BY ts DESC LIMIT 40`,
    ).map((a) => ({ ts: a.ts, client: a.client, tool: a.tool, allowed: !!a.allowed }));
    return { grants, audit, allScopes: ["skills:read", "memory:read", "memory:write", "secrets:read"] };
  }

  // ---- MCP dispatch -------------------------------------------------------
  // Verifies the secret, resolves the calling client from its session, enforces
  // that client's grant scope for the tool, audits, then runs it.
  async callTool(
    secret: string,
    name: string,
    args: Record<string, unknown>,
    clientLabel: string,
    sessionId?: string,
  ): Promise<{ ok: true; text: string } | { ok: false; status: number; error: string }> {
    if (!(await this.verify(secret))) {
      return { ok: false, status: 401, error: "invalid token" };
    }
    const client = this.resolveClient(sessionId, clientLabel);
    const requiredScope = ProfileDO.TOOL_SCOPE[name];
    if (requiredScope && !this.grantAllows(client, requiredScope)) {
      this.writeAudit(client, name, false, `denied: needs ${requiredScope}`);
      return {
        ok: false,
        status: 403,
        error: `"${client}" is not granted ${requiredScope}. Adjust access in the dashboard.`,
      };
    }
    try {
      this.writeAudit(client, name, true);
      switch (name) {
        case "get_context":
          return { ok: true, text: this.getContext(str(args.query)) };
        case "list_skills":
          return { ok: true, text: this.listSkills() };
        case "get_skill":
          return { ok: true, text: await this.getSkill(req(args.slug, "slug"), str(args.format) || "claude") };
        case "remember":
          return { ok: true, text: await this.rememberRouted(req(args.fact, "fact"), str(args.scope) || "general", client) };
        case "recall":
          return { ok: true, text: await this.recallRouted(req(args.query, "query"), str(args.scope), num(args.limit) ?? 8) };
        case "forget":
          return { ok: true, text: await this.forgetRouted(req(args.id, "id")) };
        case "list_credentials":
          return { ok: true, text: this.listCredentialsText() };
        case "get_credential":
          return { ok: true, text: this.getCredentialText(req(args.name, "name")) };
        default:
          return { ok: false, status: 400, error: `unknown tool: ${name}` };
      }
    } catch (e) {
      return { ok: false, status: 400, error: (e as Error).message };
    }
  }

  // ---- Tool implementations ----------------------------------------------

  private getContext(query?: string): string {
    const skills = this.rows<{ slug: string; version: string; summary: string | null }>(
      `SELECT slug, version, summary FROM skills WHERE enabled = 1 ORDER BY slug`,
    );
    const memories = query
      ? this.searchFacts(query, undefined, 6)
      : this.rows<Fact>(`SELECT * FROM facts ORDER BY updated DESC LIMIT 6`);
    const lines: string[] = [];
    lines.push(`# Your agent profile`);
    lines.push("");
    lines.push(`## Skills (${skills.length})`);
    if (skills.length === 0) lines.push("_No skills installed yet._");
    for (const s of skills) lines.push(`- **${s.slug}** \`${s.version}\`${s.summary ? ` — ${s.summary}` : ""}`);
    lines.push("");
    lines.push(`## Memory (${memories.length} shown)`);
    if (memories.length === 0) lines.push("_No memories yet. Use `remember` to save facts._");
    for (const m of memories) lines.push(`- ${m.body} _(${m.scope}, ${provenance(m)})_`);
    return lines.join("\n");
  }

  private listSkills(): string {
    const skills = this.rows<{ slug: string; version: string; summary: string | null; enabled: number }>(
      `SELECT slug, version, summary, enabled FROM skills ORDER BY slug`,
    );
    if (skills.length === 0) return "No skills installed. Add one with `agentprofile skill add`.";
    return JSON.stringify(
      skills.map((s) => ({ slug: s.slug, version: s.version, summary: s.summary, enabled: !!s.enabled })),
      null,
      2,
    );
  }

  private async getSkill(slug: string, format: string): Promise<string> {
    const row = this.rows<{ body: string | null; r2_key: string | null; version: string }>(
      `SELECT body, r2_key, version FROM skills WHERE slug = ? AND enabled = 1`,
      slug,
    )[0];
    if (!row) throw new Error(`skill not found: ${slug}`);
    let body = row.body ?? "";
    if (!body && row.r2_key && this.env.BUNDLES) {
      const obj = await this.env.BUNDLES.get(row.r2_key);
      body = obj ? await obj.text() : "";
    }
    if (!body) throw new Error(`skill ${slug} has no content`);
    // Phase 1 translation is a light reframing; real translators land in P4.
    return renderSkill(slug, row.version, body, format);
  }

  // ---- Zero-knowledge credentials ----------------------------------------
  // Every value here is opaque ciphertext. The DO cannot decrypt anything.

  // MCP tool: metadata only — never returns secret material.
  private listCredentialsText(): string {
    const rows = this.rows<{ name: string; algo: string; created: number; updated: number }>(
      `SELECT name, algo, created, updated FROM secrets ORDER BY name`,
    );
    if (rows.length === 0) return "No credentials stored.";
    return JSON.stringify(
      rows.map((r) => ({ name: r.name, algo: r.algo, created: new Date(r.created).toISOString().slice(0, 10) })),
      null,
      2,
    );
  }

  // MCP tool: returns the encrypted blob for the caller to decrypt locally.
  private getCredentialText(name: string): string {
    const r = this.rows<{ ciphertext: string; wrapped_dek: string; algo: string }>(
      `SELECT ciphertext, wrapped_dek, algo FROM secrets WHERE name = ?`,
      name,
    )[0];
    if (!r) throw new Error(`no credential named "${name}"`);
    // The client unwraps the DEK with its master key and decrypts. The server
    // has handed over only ciphertext — it never saw the plaintext or the key.
    return JSON.stringify({ name, algo: r.algo, ciphertext: r.ciphertext, wrapped_dek: r.wrapped_dek }, null, 2);
  }

  // REST (owner token): store/list/delete encrypted credentials.
  async putCredential(
    secret: string,
    name: string,
    ciphertext: string,
    wrappedDek: string,
    algo: string,
  ): Promise<boolean> {
    if (!(await this.verify(secret))) return false;
    const now = Date.now();
    this.sql.exec(
      `INSERT INTO secrets (name, ciphertext, wrapped_dek, algo, created, updated)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET ciphertext = excluded.ciphertext,
         wrapped_dek = excluded.wrapped_dek, algo = excluded.algo, updated = excluded.updated`,
      name,
      ciphertext,
      wrappedDek,
      algo,
      now,
      now,
    );
    this.broadcast({ type: "credential_changed", name });
    return true;
  }
  async listCredentials(secret: string): Promise<{ name: string; algo: string; created: number }[] | null> {
    if (!(await this.verify(secret))) return null;
    return this.rows<{ name: string; algo: string; created: number }>(
      `SELECT name, algo, created FROM secrets ORDER BY name`,
    );
  }
  async getCredentialBlob(
    secret: string,
    name: string,
  ): Promise<{ ciphertext: string; wrapped_dek: string; algo: string } | null> {
    if (!(await this.verify(secret))) return null;
    return this.rows<{ ciphertext: string; wrapped_dek: string; algo: string }>(
      `SELECT ciphertext, wrapped_dek, algo FROM secrets WHERE name = ?`,
      name,
    )[0] ?? null;
  }
  async deleteCredential(secret: string, name: string): Promise<boolean> {
    if (!(await this.verify(secret))) return false;
    const c = this.sql.exec(`DELETE FROM secrets WHERE name = ?`, name);
    if (c.rowsWritten > 0) this.broadcast({ type: "credential_changed", name });
    return c.rowsWritten > 0;
  }

  // ---- Memory provider routing ------------------------------------------
  // The grants/audit/scope layer has already run in callTool. Here we route the
  // actual storage to the configured backend: builtin (below) or an external
  // provider (Mem0 / Supermemory) the user brought their own data to.
  private getMemoryConfig(): MemoryConfig {
    const raw = this.getMeta("memory_config");
    if (!raw) return DEFAULT_MEMORY_CONFIG;
    try { return JSON.parse(raw) as MemoryConfig; } catch { return DEFAULT_MEMORY_CONFIG; }
  }

  async getMemoryProvider(secret: string): Promise<{ provider: string } | null> {
    if (!(await this.verify(secret))) return null;
    return { provider: this.getMemoryConfig().provider };
  }

  async setMemoryConfig(secret: string, cfg: MemoryConfig): Promise<{ ok: boolean; error?: string }> {
    if (!(await this.verify(secret))) return { ok: false, error: "unauthorized" };
    const err = validateConfig(cfg);
    if (err) return { ok: false, error: err };
    this.setMeta("memory_config", JSON.stringify(cfg));
    this.broadcast({ type: "provider_changed", provider: cfg.provider });
    return { ok: true };
  }

  private async rememberRouted(fact: string, scope: string, client: string): Promise<string> {
    const cfg = this.getMemoryConfig();
    if (isExternal(cfg)) return extRemember(cfg, fact, scope);
    return this.remember(fact, scope, client);
  }
  private async recallRouted(query: string, scope: string | undefined, limit: number): Promise<string> {
    const cfg = this.getMemoryConfig();
    if (isExternal(cfg)) {
      const rows = await extRecall(cfg, query, Math.max(1, Math.min(50, limit)));
      const filtered = scope ? rows.filter((r) => r.scope === scope) : rows;
      return filtered.length
        ? JSON.stringify(filtered.map((r) => ({ id: r.id, fact: r.fact, scope: r.scope, learned: r.learned })), null, 2)
        : "No matching memories.";
    }
    return this.recall(query, scope, limit);
  }
  private async forgetRouted(id: string): Promise<string> {
    const cfg = this.getMemoryConfig();
    if (isExternal(cfg)) return (await extForget(cfg, id)) ? `Forgot ${id}.` : `Could not delete ${id}.`;
    return this.forget(id);
  }

  private async remember(fact: string, scope: string, clientLabel: string): Promise<string> {
    const id = crypto.randomUUID();
    const now = Date.now();
    const vec = await this.embed(fact);
    this.sql.exec(
      `INSERT INTO facts (id, body, scope, source_client, created, updated, embedding) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      fact,
      scope,
      clientLabel,
      now,
      now,
      vec ? bufFrom(vec) : null,
    );
    this.broadcast({ type: "memory_added", id, fact, scope, client: clientLabel });
    return `Remembered (id ${id}, scope ${scope}).`;
  }

  private async recall(query: string, scope: string | undefined, limit: number): Promise<string> {
    const n = Math.max(1, Math.min(50, limit));
    const facts = await this.searchFactsSemantic(query, scope, n);
    if (facts.length === 0) return "No matching memories.";
    return JSON.stringify(
      facts.map((f) => ({ id: f.id, fact: f.body, scope: f.scope, learned: provenance(f) })),
      null,
      2,
    );
  }

  // Semantic recall: embed the query, cosine-rank facts that have embeddings.
  // Facts without an embedding (or the whole query, if AI is down) fall back to
  // the keyword scorer, and the two result sets are merged by best rank.
  private async searchFactsSemantic(query: string, scope: string | undefined, limit: number): Promise<Fact[]> {
    const rows = scope
      ? this.rows<FactRow>(`SELECT * FROM facts WHERE scope = ?`, scope)
      : this.rows<FactRow>(`SELECT * FROM facts`);
    if (rows.length === 0) return [];

    const qvec = await this.embed(query);
    if (!qvec) return this.searchFacts(query, scope, limit); // AI unavailable → keyword

    const embedded: { f: FactRow; score: number }[] = [];
    const unembedded: FactRow[] = [];
    for (const f of rows) {
      if (f.embedding) embedded.push({ f, score: cosine(qvec, floatsFrom(f.embedding)) });
      else unembedded.push(f);
    }
    embedded.sort((a, b) => b.score - a.score);

    // Keep semantically-close matches; a cosine floor avoids returning noise.
    const semantic = embedded.filter((e) => e.score >= 0.55).map((e) => e.f);
    if (semantic.length >= limit) return semantic.slice(0, limit);

    // Top up with keyword matches over the not-yet-embedded facts.
    const seen = new Set(semantic.map((f) => f.id));
    const keyword = this.keywordRank(query, unembedded).filter((f) => !seen.has(f.id));
    return [...semantic, ...keyword].slice(0, limit);
  }

  private forget(id: string): string {
    const cursor = this.sql.exec(`DELETE FROM facts WHERE id = ?`, id);
    if (cursor.rowsWritten > 0) {
      this.broadcast({ type: "memory_removed", id });
      return `Forgot ${id}.`;
    }
    return `No memory with id ${id}.`;
  }

  // Keyword fallback (used when Workers AI is unavailable, and to top up
  // semantic results with not-yet-embedded facts). Fuzzy overlap: each query
  // term matches a fact word by substring OR shared prefix (>=4 chars), so
  // "preference" finds "prefers". Honest about its limit: no true synonyms.
  private searchFacts(query: string, scope: string | undefined, limit: number): Fact[] {
    const rows = scope
      ? this.rows<Fact>(`SELECT * FROM facts WHERE scope = ?`, scope)
      : this.rows<Fact>(`SELECT * FROM facts`);
    return this.keywordRank(query, rows).slice(0, limit);
  }

  private keywordRank(query: string, rows: Fact[]): Fact[] {
    const terms = tokenize(query);
    if (terms.length === 0) return [...rows].sort((a, b) => b.updated - a.updated);
    return rows
      .map((f) => {
        const words = tokenize(f.body);
        let score = 0;
        for (const t of terms) {
          for (const w of words) {
            if (fuzzyMatch(t, w)) { score++; break; }
          }
        }
        return { f, score };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || b.f.updated - a.f.updated)
      .map((s) => s.f);
  }

  // ---- helpers ------------------------------------------------------------

  private getMeta(key: string): string | null {
    const r = this.rows<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, key)[0];
    return r ? r.value : null;
  }
  private setMeta(key: string, value: string): void {
    this.sql.exec(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, value);
  }
  private rows<T>(query: string, ...bindings: (string | number | null)[]): T[] {
    return this.sql.exec(query, ...bindings).toArray() as T[];
  }

  // MCP tool catalog lives with the DO so a client can discover it after auth.
  async toolCatalog(secret: string) {
    if (!(await this.verify(secret))) return null;
    return TOOLS;
  }

  // Test/seed helper used by the CLI's `skill add` and demo seeding.
  async installSkill(secret: string, slug: string, version: string, summary: string, body: string): Promise<boolean> {
    if (!(await this.verify(secret))) return false;
    this.sql.exec(
      `INSERT INTO skills (slug, version, summary, body, enabled, installed)
       VALUES (?, ?, ?, ?, 1, ?)
       ON CONFLICT(slug) DO UPDATE SET version = excluded.version, summary = excluded.summary, body = excluded.body, enabled = 1`,
      slug,
      version,
      summary,
      body,
      Date.now(),
    );
    this.broadcast({ type: "skill_added", slug, version });
    return true;
  }
}

interface Fact {
  id: string;
  body: string;
  scope: string;
  source_client: string | null;
  created: number;
  updated: number;
  embedding?: ArrayBuffer | null;
}
type FactRow = Fact;

function bufFrom(vec: Float32Array): ArrayBuffer {
  const src = new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
  const out = new ArrayBuffer(src.byteLength);
  new Uint8Array(out).set(src);
  return out;
}
function floatsFrom(buf: ArrayBuffer): Float32Array {
  return new Float32Array(buf);
}
function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

const STOPWORDS = new Set([
  "the", "a", "an", "of", "to", "and", "or", "for", "in", "on", "my", "me", "i",
  "is", "are", "was", "about", "what", "did", "you", "tell", "do", "does", "with",
]);

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

// Match if either term contains the other, or they share a >=4-char prefix.
function fuzzyMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length >= 3 && b.includes(a)) return true;
  if (b.length >= 3 && a.includes(b)) return true;
  const n = Math.min(a.length, b.length, Math.max(4, Math.floor(Math.min(a.length, b.length) * 0.7)));
  if (n >= 4 && a.slice(0, n) === b.slice(0, n)) return true;
  return false;
}

function safeParse(s: string): string[] {
  try { return JSON.parse(s) as string[]; } catch { return []; }
}

function provenance(f: Fact): string {
  const where = f.source_client || "unknown tool";
  const when = new Date(f.created).toISOString().slice(0, 10);
  return `${where}, ${when}`;
}

function renderSkill(slug: string, version: string, body: string, format: string): string {
  if (format === "agents-md") {
    return `<!-- skill: ${slug}@${version} -->\n${body}`;
  }
  if (format === "cursor") {
    return `# ${slug} (v${version})\n\n${body}`;
  }
  // 'claude' — return SKILL.md as-is.
  return body;
}

// arg coercion
function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function req(v: unknown, name: string): string {
  if (typeof v !== "string" || v.length === 0) throw new Error(`missing required argument: ${name}`);
  return v;
}
