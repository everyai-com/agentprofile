// Lightweight smoke + invariant tests. Run with: node --test
// No test framework dependency — uses node:test + node:assert.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseToken, makeToken, newProfileId, newSecret } from "../src/auth.ts";
import { TOOLS } from "../src/tools.ts";
import { validateConfig, isExternal, DEFAULT_MEMORY_CONFIG } from "../src/memory-providers.ts";

test("token round-trips and parses", () => {
  const id = newProfileId();
  const secret = newSecret();
  const parsed = parseToken(makeToken(id, secret));
  assert.ok(parsed);
  assert.equal(parsed.profileId, id);
  assert.equal(parsed.secret, secret);
});

test("token parser rejects malformed input", () => {
  assert.equal(parseToken("garbage"), null);
  assert.equal(parseToken("ap_not-a-uuid.secret"), null);
  assert.equal(parseToken("ap_" + newProfileId()), null); // missing secret
  assert.equal(parseToken(null), null);
});

test("token parser strips Bearer prefix", () => {
  const t = makeToken(newProfileId(), newSecret());
  assert.deepEqual(parseToken("Bearer " + t), parseToken(t));
});

test("tool surface stays small", () => {
  // Big tool lists exhaust agent context windows and fail Connectors review.
  assert.ok(TOOLS.length <= 9, `expected <=9 tools, got ${TOOLS.length}`);
});

test("tool descriptions stay within byte budget", () => {
  // Every description byte is paid on every client turn. Pin the total so a
  // careless edit that bloats descriptions fails CI (lesson from Executor).
  const bytes = new TextEncoder().encode(
    TOOLS.map((t) => t.name + t.description + JSON.stringify(t.inputSchema)).join(""),
  ).length;
  assert.ok(bytes < 3000, `tool catalog serialized to ${bytes} bytes (budget 3000)`);
});

test("required tools are present", () => {
  const names = TOOLS.map((t) => t.name).sort();
  assert.deepEqual(
    names,
    ["forget", "get_context", "get_skill", "get_credential", "list_credentials", "list_skills", "recall", "remember"].sort(),
  );
});

test("memory provider config validation", () => {
  assert.equal(DEFAULT_MEMORY_CONFIG.provider, "builtin");
  assert.equal(validateConfig({ provider: "builtin" }), null);
  assert.equal(isExternal({ provider: "builtin" }), false);
  assert.equal(isExternal({ provider: "mem0" }), true);
  // external providers require an apiKey
  assert.match(validateConfig({ provider: "mem0" }), /apiKey/);
  assert.equal(validateConfig({ provider: "mem0", apiKey: "k" }), null);
  assert.match(validateConfig({ provider: "bogus" }), /unknown provider/);
});
