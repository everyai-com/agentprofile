# agentprofile

**Your agent's identity, everywhere.** One profile — skills, credentials, and
memory — synced to every agent tool through a single MCP URL. Open source,
zero-knowledge, and self-hostable on your own Cloudflare account.

> Every AI tool you use — Claude Code, Cursor, Codex — starts from zero: its own
> skills, its own pasted API keys, its own amnesia. agentprofile gives them one
> shared brain.

---

> **Live now:** hosted at **https://agentprofile.everyai-com.workers.dev** ·
> dashboard at [`/app`](https://agentprofile.everyai-com.workers.dev/app)

## 60-second demo

```bash
npx agentprofile
```

That creates an **anonymous profile** (no signup) on the hosted instance,
auto-detects your installed MCP clients, and writes their config. Restart your
tools, then:

1. In **Claude Code**: *"Remember that I prefer pnpm over npm."*
2. In **Cursor**: *"What package manager do I prefer?"*

It recalls it. That's your profile, everywhere.

## What's in this repo (Phase 1)

This is the **Phase 1** implementation from the [master plan](./docs/): a working
end-to-end skeleton that syncs **skills and memory** across tools over MCP.
Credentials (zero-knowledge), OAuth, semantic recall, and the skill registry land
in later phases — see [Roadmap](#roadmap).

| Path | What it is |
|------|-----------|
| [`apps/worker`](./apps/worker) | The Cloudflare Worker: a remote MCP server backed by one Durable Object per profile (SQLite for memory, R2 for skill bundles), plus a **landing page** (`/`) and a **live dashboard** (`/app`) with real-time WebSocket sync. |
| [`packages/cli`](./packages/cli) | The `agentprofile` CLI: instant-profile onboarding, client auto-config, `doctor`, `skill add`. |

### Web UI

- **`/`** — landing page with the one-command install and the pitch.
- **`/app`** — live dashboard. Paste your token (or hit "Create new") and watch skills
  and memory update **in real time**: when any agent calls `remember`, the fact appears
  instantly over a WebSocket. Add or delete memories and skills right from the page.
- **`/setup-prompt`** — the "set up with your agent" prompt: paste it into Claude Code or
  Cursor and your own agent installs and verifies agentprofile for you.

## How it works

```
agent tool ──Streamable HTTP──▶ Worker ──idFromName(profileId)──▶ ProfileDO
  (Claude Code / Cursor)          /mcp                            per-user SQLite
                                                                  • facts (memory)
                                                                  • skills
```

- **One Durable Object per user** is the source of truth. It validates the
  profile's secret on every call and owns that profile's memory and skills.
- **Bearer token = `ap_<profileId>.<secret>`.** The `profileId` routes to the DO;
  the DO verifies a SHA-256 hash of the secret. No central token table.
- **The MCP surface is 6 tools**: `get_context`, `list_skills`, `get_skill`,
  `remember`, `recall`, `forget`. Deliberately small — every description byte is
  paid on every client turn (pinned in tests).

## Run it locally

```bash
npm install
npm run dev            # starts the Worker on http://localhost:8787
```

In another terminal:

```bash
# point the CLI at your local server
AGENTPROFILE_SERVER=http://localhost:8787 npx agentprofile
```

Run the tests and typecheck:

```bash
npm --workspace apps/worker run test
npm --workspace apps/worker run typecheck
```

## Deploy your own (self-host)

agentprofile self-hosts on **your own Cloudflare account** — the free Workers tier
covers personal use.

```bash
cd apps/worker
npx wrangler r2 bucket create agentprofile-bundles
npx wrangler deploy
# then set PUBLIC_BASE_URL to your deployed URL and connect with:
AGENTPROFILE_SERVER=https://agentprofile.<you>.workers.dev npx agentprofile
```

## Roadmap

- **P1 (this repo):** MCP server + ProfileDO, 6 tools, memory + skills, instant-profile CLI. ✅
- **P2:** OAuth consent flow, per-client grants + audit, Vectorize semantic recall, WebSocket live push, dashboard, pluggable memory providers (Mem0 / Supermemory / Zep).
- **P3:** Zero-knowledge credentials (client-side E2E), JIT injection, approval flow.
- **P4:** One-click Deploy-to-Cloudflare, signed skill registry, format translators.
- **P5:** Teams, SSO, hosted cloud.

See the full plan in [`docs/`](./docs).

## Contributing

Contributions are welcome under the [DCO](https://developercertificate.org/) —
sign off commits with `git commit -s`. See [SECURITY.md](./SECURITY.md) for
responsible disclosure.

## License

[Apache-2.0](./LICENSE).
