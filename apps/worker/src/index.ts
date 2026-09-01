import { ProfileDO } from "./profile-do";
import { handleMcp } from "./mcp";
import { landingPage, dashboardPage, setupPromptText } from "./pages";
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
  BUNDLES?: R2Bucket;
  AI?: Ai;
  MODE: string;
  PUBLIC_BASE_URL: string;
}

export { ProfileDO };

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

      // MCP endpoint.
      if (path === "/mcp") {
        const token = tokenFromRequest(request) ?? parseToken(url.searchParams.get("token"));
        if (!token) return unauthorized();
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
