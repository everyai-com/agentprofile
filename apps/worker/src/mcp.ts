// Minimal MCP server over Streamable HTTP (JSON-RPC 2.0 on POST /mcp).
// Phase 1 returns single JSON responses (no SSE streaming) — sufficient for the
// six simple tools, and maximally compatible. It implements the methods MCP
// clients require to connect and use tools: initialize, tools/list, tools/call,
// plus ping and the initialized notification.

import type { Env } from "./index";
import type { ParsedToken } from "./auth";
import { TOOLS } from "./tools";

const PROTOCOL_VERSION = "2025-06-18";

interface RpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export async function handleMcp(request: Request, env: Env, token: ParsedToken): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed. MCP uses POST.", { status: 405 });
  }

  let body: RpcRequest | RpcRequest[];
  try {
    body = await request.json();
  } catch {
    return rpcError(null, -32700, "Parse error");
  }

  const batch = Array.isArray(body) ? body : [body];
  const responses: unknown[] = [];
  let newSessionId: string | undefined;
  for (const msg of batch) {
    const res = await dispatch(msg, env, token, request);
    if (res && typeof res === "object" && "__sessionId" in res) {
      const wrapped = res as { __sessionId: string; payload: unknown };
      newSessionId = wrapped.__sessionId;
      responses.push(wrapped.payload);
    } else if (res !== undefined) {
      responses.push(res); // notifications yield undefined
    }
  }

  const headers: Record<string, string> = {};
  if (newSessionId) headers["Mcp-Session-Id"] = newSessionId;

  if (responses.length === 0) {
    return new Response(null, { status: 202, headers }); // all notifications
  }
  const payload = Array.isArray(body) ? responses : responses[0];
  return Response.json(payload, { headers });
}

async function dispatch(
  msg: RpcRequest,
  env: Env,
  token: ParsedToken,
  request: Request,
): Promise<unknown | undefined> {
  const id = msg.id ?? null;

  switch (msg.method) {
    case "initialize": {
      const clientName =
        (msg.params?.clientInfo as { name?: string } | undefined)?.name ||
        request.headers.get("x-mcp-client") ||
        "unknown-client";
      const stub = env.PROFILE.get(env.PROFILE.idFromName(token.profileId));
      const sessionId = await stub.createSession(token.secret, clientName);
      const payload = ok(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "agentprofile", version: "0.1.0" },
        instructions:
          `This is the user's agentprofile. Call get_context first to load their skills and memory. ` +
          `Use remember/recall to share facts across all their agent tools. (client: ${clientName})`,
      });
      // Signal the transport to attach Mcp-Session-Id; the client echoes it so
      // later tool calls are attributed to this client's grant.
      return sessionId ? { __sessionId: sessionId, payload } : payload;
    }

    case "notifications/initialized":
    case "notifications/cancelled":
      return undefined; // no response for notifications

    case "ping":
      return ok(id, {});

    case "tools/list":
      return ok(id, { tools: TOOLS });

    case "tools/call": {
      const params = msg.params ?? {};
      const name = String(params.name ?? "");
      const args = (params.arguments as Record<string, unknown>) ?? {};
      const clientLabel = request.headers.get("x-mcp-client") || "mcp-client";
      const sessionId = request.headers.get("mcp-session-id") || undefined;

      const stub = env.PROFILE.get(env.PROFILE.idFromName(token.profileId));
      const result = await stub.callTool(token.secret, name, args, clientLabel, sessionId);

      if (!result.ok) {
        if (result.status === 401) return rpcErrorObj(id, -32001, "Unauthorized");
        return ok(id, {
          content: [{ type: "text", text: `Error: ${result.error}` }],
          isError: true,
        });
      }
      return ok(id, { content: [{ type: "text", text: result.text }] });
    }

    default:
      return rpcErrorObj(id, -32601, `Method not found: ${msg.method}`);
  }
}

function ok(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}
function rpcErrorObj(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
function rpcError(id: unknown, code: number, message: string): Response {
  return Response.json(rpcErrorObj(id, code, message));
}
