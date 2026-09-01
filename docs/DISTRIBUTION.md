# Distribution checklist

Everything here is **free**. For an MCP product, registry listings matter more
than npm — but do both. Items marked 🔑 need your credentials (I can't do them
for you); the rest are prepared in this repo.

## 1. npm — publish the CLI (free) 🔑

Makes `npx agentprofile` resolve for everyone. The name `agentprofile` is
available and `packages/cli` is publish-ready.

```bash
npm login                                   # free account; needs your password/2FA
npm publish -w packages/cli --access public
```

Optional (supply-chain trust): publish from GitHub Actions with provenance —
`npm publish --provenance` under an OIDC-enabled workflow.

## 2. MCP registries (free) — the real discovery channel

A standard [`server.json`](../server.json) is in the repo root (remote
Streamable-HTTP entry pointing at the hosted URL).

- **Official MCP registry** — publish `server.json` with the registry CLI
  (`mcp-publisher`), authenticating via GitHub for the `io.github.everyai-com/*`
  namespace. 🔑 (GitHub auth)
- **Smithery** (smithery.ai) — add server → paste the remote URL. 🔑
- **Glama** (glama.ai/mcp) — submit the repo/URL via their form. 🔑
- **mcp.so** and **PulseMCP** — submit the repo; they also crawl READMEs.
- **awesome-mcp-servers** (punkpeye) and **awesome-agent-skills** (VoltAgent) —
  open a PR adding agentprofile. (I can draft these PRs.)

## 3. Anthropic Connectors Directory (free, highest value) 🔑

In-product discovery inside Claude. Needs: Streamable HTTP ✅, OAuth ✅, a privacy
policy, a docs URL, an icon, and test credentials. Submit from your Claude.ai org
settings. Start early — it has the longest review lead time.

## 4. Custom domain (optional) 🔑

Point e.g. `agentprofile.dev` at the Worker (you own the domain + add it in
Cloudflare); then the hosted URL becomes `https://agentprofile.dev/mcp`.

---

**What's already done for you in this repo:** `server.json`, README "Connect"
section + client snippets + badges, OAuth discovery endpoints, and a publish-ready
CLI package. The remaining steps are the 🔑 ones that require your accounts.
