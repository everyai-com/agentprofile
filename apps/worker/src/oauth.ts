// OAuth 2.0 authorization-code + PKCE for MCP clients that authenticate via
// OAuth (the modern remote-MCP standard). The issued access token is a normal
// agentprofile bearer token (ap_<profileId>.<secret>), so the existing /mcp path
// needs no changes. The bearer-token onboarding (npx / paste token) still works
// unchanged — OAuth is an additional way in, not a replacement.
//
// One OAuthDO singleton stores registered clients and short-lived auth codes.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index";
import { newProfileId, newSecret, makeToken, sha256Hex } from "./auth";

const CODE_TTL_MS = 5 * 60 * 1000; // auth codes expire in 5 minutes

export class OAuthDO extends DurableObject<Env> {
  private sql: SqlStorage;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS clients (
        client_id TEXT PRIMARY KEY, name TEXT, redirect_uris TEXT, created INTEGER
      );
      CREATE TABLE IF NOT EXISTS codes (
        code TEXT PRIMARY KEY, profile_id TEXT, secret TEXT, client_id TEXT,
        redirect_uri TEXT, challenge TEXT, method TEXT, expires INTEGER
      );
    `);
  }

  // Dynamic Client Registration (RFC 7591), minimal public-client form.
  async register(name: string, redirectUris: string[]): Promise<{ client_id: string }> {
    const client_id = "apc_" + crypto.randomUUID();
    this.sql.exec(
      `INSERT INTO clients (client_id, name, redirect_uris, created) VALUES (?, ?, ?, ?)`,
      client_id,
      name || "MCP Client",
      JSON.stringify(redirectUris || []),
      Date.now(),
    );
    return { client_id };
  }

  async clientName(clientId: string): Promise<string | null> {
    const r = this.sql.exec(`SELECT name FROM clients WHERE client_id = ?`, clientId).toArray() as { name: string }[];
    return r[0]?.name ?? null;
  }

  // On user consent: mint a fresh profile and a one-time auth code bound to it.
  async issueCode(input: {
    clientId: string;
    redirectUri: string;
    challenge?: string;
    method?: string;
  }): Promise<string> {
    const profileId = newProfileId();
    const secret = newSecret();
    const stub = this.env.PROFILE.get(this.env.PROFILE.idFromName(profileId));
    await stub.provision(await sha256Hex(secret));
    const code = "apcode_" + base64urlRandom(24);
    this.sql.exec(
      `INSERT INTO codes (code, profile_id, secret, client_id, redirect_uri, challenge, method, expires)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      code,
      profileId,
      secret,
      input.clientId,
      input.redirectUri,
      input.challenge ?? null,
      input.method ?? null,
      Date.now() + CODE_TTL_MS,
    );
    return code;
  }

  // Exchange an auth code for the profile bearer token (one-time, PKCE-checked).
  async exchange(input: {
    code: string;
    verifier?: string;
    redirectUri?: string;
  }): Promise<{ access_token: string } | { error: string }> {
    const rows = this.sql
      .exec(`SELECT * FROM codes WHERE code = ?`, input.code)
      .toArray() as Array<{
      code: string; profile_id: string; secret: string; client_id: string;
      redirect_uri: string; challenge: string | null; method: string | null; expires: number;
    }>;
    const row = rows[0];
    if (!row) return { error: "invalid_grant" };
    this.sql.exec(`DELETE FROM codes WHERE code = ?`, input.code); // one-time use
    if (Date.now() > row.expires) return { error: "invalid_grant" };
    if (input.redirectUri && input.redirectUri !== row.redirect_uri) return { error: "invalid_grant" };
    if (row.challenge) {
      if (!input.verifier) return { error: "invalid_request" };
      const computed = await s256(input.verifier);
      if (computed !== row.challenge) return { error: "invalid_grant" };
    }
    return { access_token: makeToken(row.profile_id, row.secret) };
  }
}

// base64url(SHA-256(verifier)) — PKCE S256.
async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(digest));
}
function base64urlRandom(bytes: number): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}
function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
