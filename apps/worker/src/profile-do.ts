import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index";
import { sha256Hex, timingSafeEqual } from "./auth";
import { TOOLS } from "./tools";

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
    `);
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

  // ---- MCP dispatch -------------------------------------------------------
  // Verifies the secret, then runs one tool. `clientLabel` is the MCP client's
  // reported name, stored as provenance on writes.
  async callTool(
    secret: string,
    name: string,
    args: Record<string, unknown>,
    clientLabel: string,
  ): Promise<{ ok: true; text: string } | { ok: false; status: number; error: string }> {
    if (!(await this.verify(secret))) {
      return { ok: false, status: 401, error: "invalid token" };
    }
    try {
      switch (name) {
        case "get_context":
          return { ok: true, text: this.getContext(str(args.query)) };
        case "list_skills":
          return { ok: true, text: this.listSkills() };
        case "get_skill":
          return { ok: true, text: await this.getSkill(req(args.slug, "slug"), str(args.format) || "claude") };
        case "remember":
          return { ok: true, text: this.remember(req(args.fact, "fact"), str(args.scope) || "general", clientLabel) };
        case "recall":
          return { ok: true, text: this.recall(req(args.query, "query"), str(args.scope), num(args.limit) ?? 8) };
        case "forget":
          return { ok: true, text: this.forget(req(args.id, "id")) };
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

  private remember(fact: string, scope: string, clientLabel: string): string {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.sql.exec(
      `INSERT INTO facts (id, body, scope, source_client, created, updated) VALUES (?, ?, ?, ?, ?, ?)`,
      id,
      fact,
      scope,
      clientLabel,
      now,
      now,
    );
    this.broadcast({ type: "memory_added", id, fact, scope, client: clientLabel });
    return `Remembered (id ${id}, scope ${scope}).`;
  }

  private recall(query: string, scope: string | undefined, limit: number): string {
    const facts = this.searchFacts(query, scope, Math.max(1, Math.min(50, limit)));
    if (facts.length === 0) return "No matching memories.";
    return JSON.stringify(
      facts.map((f) => ({ id: f.id, fact: f.body, scope: f.scope, learned: provenance(f) })),
      null,
      2,
    );
  }

  private forget(id: string): string {
    const cursor = this.sql.exec(`DELETE FROM facts WHERE id = ?`, id);
    if (cursor.rowsWritten > 0) {
      this.broadcast({ type: "memory_removed", id });
      return `Forgot ${id}.`;
    }
    return `No memory with id ${id}.`;
  }

  // Phase 1 search: fuzzy keyword overlap. For each query term, match against
  // each fact word by substring OR shared prefix (>=4 chars), so "preference"
  // finds "prefers" and "packages" finds "package". This is a stand-in for the
  // Phase 2 Vectorize semantic recall — good enough to be useful, and honest
  // about its limits (it won't match true synonyms).
  private searchFacts(query: string, scope: string | undefined, limit: number): Fact[] {
    const rows = scope
      ? this.rows<Fact>(`SELECT * FROM facts WHERE scope = ?`, scope)
      : this.rows<Fact>(`SELECT * FROM facts`);
    const terms = tokenize(query);
    if (terms.length === 0) {
      return rows.sort((a, b) => b.updated - a.updated).slice(0, limit);
    }
    const scored = rows
      .map((f) => {
        const words = tokenize(f.body);
        let score = 0;
        for (const t of terms) {
          for (const w of words) {
            if (fuzzyMatch(t, w)) {
              score++;
              break;
            }
          }
        }
        return { f, score };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || b.f.updated - a.f.updated);
    return scored.slice(0, limit).map((s) => s.f);
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
