import { ProfileDO } from "./profile-do";
import { OAuthDO } from "./oauth";
import { handleMcp } from "./mcp";
import { landingPage, dashboardPage, setupPromptText, consentPage } from "./pages";
import {
  tokenFromRequest,
  parseToken,
  newProfileId,
  newSecret,
  makeToken,
  sha256Hex,
} from "./auth";

export interface Env {
  PROFILE: DurableObjectNamespace<ProfileDO>;
  OAUTH: DurableObjectNamespace<OAuthDO>;
  BUNDLES?: R2Bucket;
  AI?: Ai;
  MODE: string;
  PUBLIC_BASE_URL: string;
}

export { ProfileDO, OAuthDO };

const JSON_HEADERS = { "content-type": "application/json" };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // Responsible-disclosure contact (RFC 9116).
      if (path === "/.well-known/security.txt") {
        return new Response(
          `Contact: mailto:security@agentprofile.dev\n` +
            `Policy: https://github.com/everyai-com/agentprofile/blob/main/SECURITY.md\n` +
            `Preferred-Languages: en\n`,
          { headers: { "content-type": "text/plain" } },
        );
      }

      const base = env.PUBLIC_BASE_URL || url.origin;
      const oauth = () => env.OAUTH.get(env.OAUTH.idFromName("singleton"));

      // ---- OAuth 2.0 for MCP clients ------------------------------------
      // Discovery (RFC 8414 + MCP protected-resource metadata).
      if (path === "/.well-known/oauth-authorization-server") {
        return Response.json({
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      }
      if (path === "/.well-known/oauth-protected-resource") {
        return Response.json({
          resource: `${base}/mcp`,
          authorization_servers: [base],
        });
      }
      // Dynamic client registration.
      if (path === "/register" && request.method === "POST") {
        const b = (await request.json().catch(() => ({}))) as {
          client_name?: string;
          redirect_uris?: string[];
        };
        const reg = await oauth().register(b.client_name || "MCP Client", b.redirect_uris || []);
        return Response.json(
          { client_id: reg.client_id, token_endpoint_auth_method: "none", redirect_uris: b.redirect_uris || [] },
          { status: 201 },
        );
      }
      // Authorization: show consent (GET) / handle decision (POST).
      if (path === "/authorize" && request.method === "GET") {
        const q = url.searchParams;
        const clientId = q.get("client_id") || "";
        const redirectUri = q.get("redirect_uri") || "";
        if (!redirectUri) return badRequest("redirect_uri required");
        const name = (await oauth().clientName(clientId)) || "An MCP client";
        return html(
          consentPage({
            clientName: name,
            clientId,
            redirectUri,
            state: q.get("state") || "",
            challenge: q.get("code_challenge") || "",
            method: q.get("code_challenge_method") || "",
            scopes: [],
          }),
        );
      }
      if (path === "/authorize" && request.method === "POST") {
        const form = await request.formData();
        const redirectUri = String(form.get("redirect_uri") || "");
        const state = String(form.get("state") || "");
        if (!redirectUri) return badRequest("redirect_uri required");
        const loc = new URL(redirectUri);
        if (String(form.get("decision")) !== "allow") {
          loc.searchParams.set("error", "access_denied");
          if (state) loc.searchParams.set("state", state);
          return Response.redirect(loc.toString(), 302);
        }
        const code = await oauth().issueCode({
          clientId: String(form.get("client_id") || ""),
          redirectUri,
          challenge: String(form.get("code_challenge") || "") || undefined,
          method: String(form.get("code_challenge_method") || "") || undefined,
        });
        loc.searchParams.set("code", code);
        if (state) loc.searchParams.set("state", state);
        return Response.redirect(loc.toString(), 302);
      }
      // Token exchange.
      if (path === "/token" && request.method === "POST") {
        const form = await request.formData();
        if (String(form.get("grant_type")) !== "authorization_code")
          return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
        const result = await oauth().exchange({
          code: String(form.get("code") || ""),
          verifier: String(form.get("code_verifier") || "") || undefined,
          redirectUri: String(form.get("redirect_uri") || "") || undefined,
        });
        if ("error" in result) return Response.json(result, { status: 400 });
        return Response.json({ access_token: result.access_token, token_type: "Bearer" });
      }

      // Landing page (HTML) and health (JSON).
      if (path === "/") return html(landingPage(base));
      if (path === "/health") {
        return Response.json({ service: "agentprofile", status: "ok", mode: env.MODE });
      }
      if (path === "/app") return html(dashboardPage(base));
      if (path === "/setup-prompt" || path === "/setup-prompt.txt") {
        return new Response(setupPromptText(base), { headers: { "content-type": "text/plain; charset=utf-8" } });
      }

      // Live sync WebSocket. Parse+route by token, hand the upgrade to the DO
      // with only the secret in the forwarded URL.
      if (path === "/live") {
        const token = parseToken(url.searchParams.get("token"));
        if (!token) return new Response("unauthorized", { status: 401 });
        const stub = env.PROFILE.get(env.PROFILE.idFromName(token.profileId));
        const doUrl = new URL(request.url);
        doUrl.pathname = "/live";
        doUrl.search = `?s=${encodeURIComponent(token.secret)}`;
        return stub.fetch(new Request(doUrl.toString(), request));
      }

      // Create an anonymous instant profile. No signup — the returned token is
      // the credential AND the claim key. `mcpUrl` is ready to paste into any
      // MCP client.
      if (path === "/profiles" && request.method === "POST") {
        const profileId = newProfileId();
        const secret = newSecret();
        const token = makeToken(profileId, secret);
        const stub = env.PROFILE.get(env.PROFILE.idFromName(profileId));
        await stub.provision(await sha256Hex(secret));
        return Response.json(
          {
            profileId,
            token,
            mcpUrl: `${env.PUBLIC_BASE_URL || url.origin}/mcp`,
            note: "Save this token — it is shown once. Use it as the Authorization: Bearer header.",
          },
          { headers: JSON_HEADERS },
        );
      }

      // Install/seed a skill (used by the CLI). Auth via bearer token.
      if (path === "/skills" && request.method === "POST") {
        const token = tokenFromRequest(request);
        if (!token) return unauthorized();
        const b = (await request.json()) as {
          slug?: string;
          version?: string;
          summary?: string;
          body?: string;
        };
        if (!b.slug || !b.body) return badRequest("slug and body are required");
        const stub = env.PROFILE.get(env.PROFILE.idFromName(token.profileId));
        const okd = await stub.installSkill(
          token.secret,
          b.slug,
          b.version || "0.1.0",
          b.summary || "",
          b.body,
        );
        return okd ? Response.json({ installed: b.slug }) : unauthorized();
      }

      // Access management (dashboard/CLI): list grants + audit, set scopes, revoke.
      if (path === "/grants") {
        const token = tokenFromRequest(request);
        if (!token) return unauthorized();
        const stub = env.PROFILE.get(env.PROFILE.idFromName(token.profileId));
        if (request.method === "GET") {
          const data = await stub.listAccess(token.secret);
          return data ? Response.json(data) : unauthorized();
        }
        if (request.method === "POST") {
          const b = (await request.json()) as {
            action?: string;
            client?: string;
            scopes?: string[];
            revoked?: boolean;
          };
          if (!b.client) return badRequest("client is required");
          let done = false;
          if (b.action === "scopes" && Array.isArray(b.scopes)) done = await stub.setScopes(token.secret, b.client, b.scopes);
          else if (b.action === "revoke") done = await stub.setRevoked(token.secret, b.client, b.revoked !== false);
          else return badRequest("action must be 'scopes' or 'revoke'");
          return done ? Response.json({ ok: true }) : unauthorized();
        }
      }

      // Zero-knowledge credentials (owner token). The server only ever receives
      // and returns ciphertext + wrapped keys — never plaintext or the master key.
      if (path === "/credentials") {
        const token = tokenFromRequest(request);
        if (!token) return unauthorized();
        const stub = env.PROFILE.get(env.PROFILE.idFromName(token.profileId));
        if (request.method === "GET") {
          const list = await stub.listCredentials(token.secret);
          return list ? Response.json({ credentials: list }) : unauthorized();
        }
        if (request.method === "POST") {
          const b = (await request.json()) as {
            name?: string;
            ciphertext?: string;
            wrapped_dek?: string;
            algo?: string;
          };
          if (!b.name || !b.ciphertext || !b.wrapped_dek) return badRequest("name, ciphertext, wrapped_dek required");
          const okd = await stub.putCredential(token.secret, b.name, b.ciphertext, b.wrapped_dek, b.algo || "A256GCM");
          return okd ? Response.json({ stored: b.name }) : unauthorized();
        }
      }
      if (path.startsWith("/credentials/")) {
        const token = tokenFromRequest(request);
        if (!token) return unauthorized();
        const name = decodeURIComponent(path.slice("/credentials/".length));
        const stub = env.PROFILE.get(env.PROFILE.idFromName(token.profileId));
        if (request.method === "GET") {
          const blob = await stub.getCredentialBlob(token.secret, name);
          return blob ? Response.json(blob) : new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: JSON_HEADERS });
        }
        if (request.method === "DELETE") {
          const done = await stub.deleteCredential(token.secret, name);
          return Response.json({ deleted: done ? name : null });
        }
      }

      // Memory provider config: choose builtin (default) or an external backend
      // (Mem0 / Supermemory) the user already uses. Secret-gated.
      if (path === "/memory-config") {
        const token = tokenFromRequest(request);
        if (!token) return unauthorized();
        const stub = env.PROFILE.get(env.PROFILE.idFromName(token.profileId));
        if (request.method === "GET") {
          const data = await stub.getMemoryProvider(token.secret);
          return data ? Response.json(data) : unauthorized();
        }
        if (request.method === "POST") {
          const cfg = (await request.json()) as {
            provider?: string;
            apiKey?: string;
            userId?: string;
          };
          const res = await stub.setMemoryConfig(token.secret, {
            provider: (cfg.provider as "builtin" | "mem0" | "supermemory") ?? "builtin",
            apiKey: cfg.apiKey,
            userId: cfg.userId,
          });
          return res.ok ? Response.json({ ok: true }) : badRequest(res.error || "invalid config");
        }
      }

      // MCP endpoint.
      if (path === "/mcp") {
        const token = tokenFromRequest(request) ?? parseToken(url.searchParams.get("token"));
        if (!token) {
          // Point OAuth-capable clients at our protected-resource metadata so
          // they can start the OAuth flow; bearer-token clients just send a token.
          return new Response(
            JSON.stringify({ error: "unauthorized", hint: "Use a Bearer token or OAuth." }),
            {
              status: 401,
              headers: {
                ...JSON_HEADERS,
                "WWW-Authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
              },
            },
          );
        }
        return handleMcp(request, env, token);
      }

      return new Response("Not found", { status: 404 });
    } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: 500, headers: JSON_HEADERS });
    }
  },
};

function html(body: string): Response {
  return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
}
function unauthorized(): Response {
  return Response.json(
    { error: "unauthorized", hint: "Provide Authorization: Bearer ap_<profileId>.<secret>" },
    { status: 401, headers: JSON_HEADERS },
  );
}
function badRequest(msg: string): Response {
  return Response.json({ error: msg }, { status: 400, headers: JSON_HEADERS });
}
