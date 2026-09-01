#!/usr/bin/env node
// agentprofile CLI — zero-dependency, so `npx agentprofile` is instant.
//
// Default (no command): create an anonymous instant profile, auto-wire every
// detected MCP client, and print the cross-tool test. No signup required.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, basename } from "node:path";
import { execSync } from "node:child_process";

const DEFAULT_SERVER =
  process.env.AGENTPROFILE_SERVER || "https://agentprofile.everyai-com.workers.dev";
const CRED_DIR = join(homedir(), ".agentprofile");
const CRED_FILE = join(CRED_DIR, "credentials.json");

const c = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  green: "\x1b[32m", cyan: "\x1b[36m", yellow: "\x1b[33m", red: "\x1b[31m", mag: "\x1b[35m",
};
const paint = (s, col) => (process.stdout.isTTY ? col + s + c.reset : s);
const ok = (s) => console.log(paint("✓ ", c.green) + s);
const info = (s) => console.log(paint("• ", c.cyan) + s);
const warn = (s) => console.log(paint("! ", c.yellow) + s);
const err = (s) => console.error(paint("✗ ", c.red) + s);

async function main() {
  const argv = process.argv.slice(2);
  const flags = parseFlags(argv);
  const cmd = flags._[0] || "init";
  const server = (flags.server || DEFAULT_SERVER).replace(/\/$/, "");

  switch (cmd) {
    case "init": return init(server, flags);
    case "doctor": return doctor(server);
    case "status": case "whoami": return status(server);
    case "skill": return skill(server, flags);
    case "help": case "--help": case "-h": return help();
    default:
      err(`Unknown command: ${cmd}`);
      help();
      process.exit(1);
  }
}

// ---- init: the money shot -------------------------------------------------

async function init(server, flags) {
  banner();
  info(`Creating an anonymous profile on ${paint(server, c.dim)} …`);
  let profile;
  try {
    profile = await postJson(`${server}/profiles`, {});
  } catch (e) {
    err(`Could not reach the server: ${e.message}`);
    warn(`Is it running? For local dev: ${paint("npm run dev", c.bold)} in apps/worker.`);
    process.exit(1);
  }
  saveCreds({ server, ...profile });
  ok(`Profile created. Token saved to ${paint(CRED_FILE, c.dim)}`);
  console.log(paint("  (this token is both your credential and your claim key — keep it safe)", c.dim));
  console.log();

  const clients = detectClients();
  if (clients.length === 0) {
    warn("No MCP clients detected (Claude Code, Cursor). Configure manually:");
    printManual(profile);
  } else {
    info(`Detected: ${clients.map((x) => paint(x.name, c.bold)).join(", ")}`);
    for (const client of clients) {
      try {
        client.write(profile);
        ok(`Configured ${paint(client.name, c.bold)} → ${client.where}`);
      } catch (e) {
        warn(`Could not auto-configure ${client.name}: ${e.message}`);
        printManual(profile, client.id);
      }
    }
  }

  console.log();
  console.log(paint("━".repeat(58), c.dim));
  console.log(paint(" Restart your agent tools", c.bold) + paint("  (they load MCP servers at startup)", c.dim));
  console.log(paint("━".repeat(58), c.dim));
  console.log();
  console.log(" Then try the cross-tool test:");
  console.log(paint('   1. In one tool:  "Remember that I prefer pnpm over npm."', c.cyan));
  console.log(paint('   2. In another:   "What package manager do I prefer?"', c.cyan));
  console.log();
  console.log(" It should recall it. That is your profile, everywhere.");
  console.log();
  console.log(paint(" Next:", c.bold) + " agentprofile doctor   ·   agentprofile skill add ./SKILL.md");
}

// ---- doctor ---------------------------------------------------------------

async function doctor(server) {
  banner();
  const creds = loadCreds();
  let failures = 0;

  // 1. server reachable
  try {
    const h = await getJson(`${(creds?.server || server).replace(/\/$/, "")}/health`);
    ok(`Server reachable (${h.service}, mode=${h.mode})`);
  } catch (e) {
    err(`Server unreachable: ${e.message}`);
    failures++;
  }

  // 2. credentials present + valid
  if (!creds?.token) {
    err(`No saved credentials. Run ${paint("agentprofile init", c.bold)}.`);
    failures++;
  } else {
    ok(`Credentials found (profile ${creds.profileId?.slice(0, 8)}…)`);
    try {
      const init = await rpc(creds, "initialize", {
        protocolVersion: "2025-06-18",
        clientInfo: { name: "agentprofile-doctor" },
      });
      if (init.result) ok(`Token valid — MCP handshake OK (${init.result.serverInfo?.name})`);
      else throw new Error(init.error?.message || "no result");
    } catch (e) {
      err(`MCP handshake failed: ${e.message}`);
      failures++;
    }
  }

  // 3. client configs
  for (const client of allClients()) {
    const status = client.check(creds);
    if (status.configured) ok(`${client.name}: configured (${status.detail})`);
    else info(`${client.name}: ${status.detail}`);
  }

  console.log();
  if (failures === 0) ok(paint("All good.", c.bold));
  else {
    err(`${failures} problem(s) found.`);
    process.exit(1);
  }
}

// ---- status ---------------------------------------------------------------

async function status(server) {
  const creds = loadCreds();
  if (!creds?.token) {
    warn(`No profile yet. Run ${paint("agentprofile init", c.bold)}.`);
    return;
  }
  const res = await rpc(creds, "tools/call", { name: "get_context", arguments: {} });
  console.log(res.result?.content?.[0]?.text || JSON.stringify(res, null, 2));
}

// ---- skill add ------------------------------------------------------------

async function skill(server, flags) {
  const sub = flags._[1];
  if (sub !== "add") {
    err("Usage: agentprofile skill add <path-to-SKILL.md> [--slug x] [--summary y]");
    process.exit(1);
  }
  const creds = loadCreds();
  if (!creds?.token) { err("No profile. Run agentprofile init first."); process.exit(1); }
  const file = flags._[2];
  if (!file || !existsSync(file)) { err(`File not found: ${file}`); process.exit(1); }
  const body = readFileSync(file, "utf8");
  const slug = flags.slug || slugFromContent(body) || basename(file).replace(/\.[^.]+$/, "");
  const summary = flags.summary || firstLine(body);
  const res = await postJson(`${creds.server}/skills`, { slug, summary, body }, creds.token);
  ok(`Installed skill ${paint(res.installed, c.bold)} — now available in every connected tool.`);
}

// ---- client adapters ------------------------------------------------------

function allClients() {
  return [cursorClient(), claudeCodeClient()];
}
function detectClients() {
  return allClients().filter((cl) => cl.detected());
}

function cursorClient() {
  const file = join(homedir(), ".cursor", "mcp.json");
  return {
    id: "cursor",
    name: "Cursor",
    where: file,
    detected: () => existsSync(join(homedir(), ".cursor")),
    write: (p) => mergeJsonMcp(file, p),
    check: () => {
      if (!existsSync(file)) return { configured: false, detail: "not configured" };
      const j = readJson(file);
      return j?.mcpServers?.agentprofile
        ? { configured: true, detail: file }
        : { configured: false, detail: "config exists but agentprofile not added" };
    },
  };
}

function claudeCodeClient() {
  const hasBinary = commandExists("claude");
  const projectFile = join(process.cwd(), ".mcp.json");
  return {
    id: "claude-code",
    name: "Claude Code",
    where: hasBinary ? "claude mcp (user scope)" : projectFile,
    detected: () => hasBinary || existsSync(join(homedir(), ".claude")),
    write: (p) => {
      if (hasBinary) {
        // Preferred: let the official CLI own the format. Remove first so
        // re-running init is idempotent (add fails if the name already exists).
        try {
          execSync("claude mcp remove --scope user agentprofile", { stdio: "ignore" });
        } catch { /* not present yet — fine */ }
        execSync(
          `claude mcp add --transport http --scope user agentprofile ${shellQuote(p.mcpUrl)} ` +
            `--header ${shellQuote("Authorization: Bearer " + p.token)}`,
          { stdio: "ignore" },
        );
      } else {
        mergeJsonMcp(projectFile, p);
      }
    },
    check: () => {
      if (hasBinary) {
        try {
          const out = execSync("claude mcp list", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
          return out.includes("agentprofile")
            ? { configured: true, detail: "claude mcp (user scope)" }
            : { configured: false, detail: "claude binary present, agentprofile not added" };
        } catch {
          return { configured: false, detail: "claude binary present" };
        }
      }
      if (existsSync(projectFile) && readJson(projectFile)?.mcpServers?.agentprofile)
        return { configured: true, detail: projectFile };
      return { configured: false, detail: "not configured" };
    },
  };
}

// Merge our server into a `{ mcpServers: { ... } }` file (Cursor / .mcp.json shape).
function mergeJsonMcp(file, profile) {
  mkdirSync(dirname(file), { recursive: true });
  const json = existsSync(file) ? readJson(file) || {} : {};
  json.mcpServers = json.mcpServers || {};
  json.mcpServers.agentprofile = {
    url: profile.mcpUrl,
    headers: { Authorization: `Bearer ${profile.token}` },
  };
  writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
}

// ---- helpers --------------------------------------------------------------

function printManual(profile, only) {
  console.log(paint("  Manual config:", c.bold));
  if (!only || only === "cursor") {
    console.log(paint("  Cursor (~/.cursor/mcp.json):", c.dim));
    console.log(
      "    " +
        JSON.stringify({ mcpServers: { agentprofile: { url: profile.mcpUrl, headers: { Authorization: `Bearer ${profile.token}` } } } }),
    );
  }
  if (!only || only === "claude-code") {
    console.log(paint("  Claude Code:", c.dim));
    console.log(`    claude mcp add --transport http --scope user agentprofile ${profile.mcpUrl} --header "Authorization: Bearer ${profile.token}"`);
  }
}

function saveCreds(obj) {
  mkdirSync(CRED_DIR, { recursive: true });
  writeFileSync(CRED_FILE, JSON.stringify(obj, null, 2) + "\n", { mode: 0o600 });
}
function loadCreds() {
  try { return JSON.parse(readFileSync(CRED_FILE, "utf8")); } catch { return null; }
}
function readJson(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

async function rpc(creds, method, params) {
  const res = await fetch(`${creds.server.replace(/\/$/, "")}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${creds.token}`, "x-mcp-client": "agentprofile-cli" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (res.status === 401) throw new Error("unauthorized (token rejected)");
  return res.json();
}
async function postJson(url, body, token) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function commandExists(cmd) {
  try {
    execSync(process.platform === "win32" ? `where ${cmd}` : `command -v ${cmd}`, { stdio: "ignore" });
    return true;
  } catch { return false; }
}
function shellQuote(s) { return `'${String(s).replace(/'/g, "'\\''")}'`; }
function slugFromContent(body) {
  const m = body.match(/^name:\s*([a-z0-9-]+)/im);
  return m ? m[1] : null;
}
function firstLine(body) {
  const m = body.match(/^description:\s*(.+)$/im) || body.match(/^#\s*(.+)$/m);
  return m ? m[1].trim().slice(0, 140) : "";
}

function parseFlags(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) { out[key] = next; i++; }
      else out[key] = true;
    } else out._.push(a);
  }
  return out;
}

function banner() {
  console.log();
  console.log(paint(" agentprofile", c.bold + c.mag) + paint("  your agent's identity, everywhere", c.dim));
  console.log();
}
function help() {
  banner();
  console.log(`Usage: agentprofile [command] [options]

Commands:
  init            Create a profile and wire up all detected agent tools (default)
  doctor          Diagnose server, token, and client configuration
  status          Print your profile (skills + memory) via get_context
  skill add FILE  Install a SKILL.md into your profile

Options:
  --server URL    Override the server (default ${DEFAULT_SERVER})
  --slug, --summary   For 'skill add'

Examples:
  npx agentprofile
  npx agentprofile doctor
  npx agentprofile skill add ./SKILL.md --slug code-review
`);
}

main().catch((e) => { err(e.stack || e.message); process.exit(1); });
