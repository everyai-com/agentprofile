// Token format: ap_<profileId>.<secret>
//   - profileId routes the request to the right ProfileDO (via idFromName).
//   - secret is verified against a SHA-256 hash stored inside that DO.
// The token itself carries the routing key, so no central token->profile lookup
// table is needed in Phase 1 — the DO is the sole authority on its own secret.

const PREFIX = "ap_";

export interface ParsedToken {
  profileId: string;
  secret: string;
  raw: string;
}

export function parseToken(raw: string | null | undefined): ParsedToken | null {
  if (!raw) return null;
  let value = raw.trim();
  if (value.toLowerCase().startsWith("bearer ")) value = value.slice(7).trim();
  if (!value.startsWith(PREFIX)) return null;
  const body = value.slice(PREFIX.length);
  const dot = body.indexOf(".");
  if (dot <= 0 || dot === body.length - 1) return null;
  const profileId = body.slice(0, dot);
  const secret = body.slice(dot + 1);
  if (!/^[0-9a-f-]{36}$/.test(profileId)) return null;
  return { profileId, secret, raw: value };
}

export function tokenFromRequest(request: Request): ParsedToken | null {
  return parseToken(request.headers.get("authorization"));
}

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Constant-time-ish comparison to avoid trivial timing leaks on the hash.
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function newProfileId(): string {
  return crypto.randomUUID();
}

export function newSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return base64url(bytes);
}

export function makeToken(profileId: string, secret: string): string {
  return `${PREFIX}${profileId}.${secret}`;
}

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
