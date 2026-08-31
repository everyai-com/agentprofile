// The MCP tool surface for a profile. Kept deliberately small (Phase 1: 6 tools) —
// every byte of these descriptions is paid on every client turn, so they are terse.
// Management operations (installing skills, grants, publishing) live in the CLI and
// dashboard, NOT here.

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const TOOLS: ToolDef[] = [
  {
    name: "get_context",
    description:
      "Bootstrap this agent for the current user in one call: returns the user's enabled skills (names + summaries) and their most relevant recent memories. Call this at the start of a session.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Optional focus for which memories to surface (e.g. the current task).",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "list_skills",
    description: "List the user's enabled skills with slug, version, and summary.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_skill",
    description:
      "Fetch the full content of one skill by slug, rendered for this client. format defaults to 'claude' (SKILL.md); other values: 'cursor', 'agents-md'.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
        format: { type: "string", enum: ["claude", "cursor", "agents-md"] },
      },
      required: ["slug"],
      additionalProperties: false,
    },
  },
  {
    name: "remember",
    description:
      "Save a durable fact about the user so every agent tool can recall it later. Use for stable preferences, facts, and decisions — not transient task state.",
    inputSchema: {
      type: "object",
      properties: {
        fact: { type: "string", description: "The fact to remember, as a self-contained sentence." },
        scope: {
          type: "string",
          description: "Optional bucket: e.g. 'dev', 'work', 'personal'. Defaults to 'general'.",
        },
      },
      required: ["fact"],
      additionalProperties: false,
    },
  },
  {
    name: "recall",
    description:
      "Search the user's memories and return the most relevant facts with their provenance (where and when each was learned).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        scope: { type: "string", description: "Optional: restrict to one scope." },
        limit: { type: "number", description: "Max results (default 8)." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "forget",
    description: "Delete one memory by its id (as returned by recall).",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
];
