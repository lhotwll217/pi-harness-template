import assert from "node:assert/strict";
import { isChatId } from "./chats";
import { GatewayRouteError } from "./protocol";
import { parseWorkspacePath } from "./workspace-files";

const refusal = (raw: string): [number, string] | "accepted" => {
  try {
    parseWorkspacePath(raw);
    return "accepted";
  } catch (error) {
    assert.ok(error instanceof GatewayRouteError);
    return [error.status, error.code];
  }
};

assert.deepEqual(parseWorkspacePath("notes.md"), ["notes.md"]);
assert.deepEqual(parseWorkspacePath("a/b/c.md"), ["a", "b", "c.md"]);
assert.deepEqual(parseWorkspacePath("projects/skills/x.md"), ["projects", "skills", "x.md"], "a reserved name below the root is an owner file");
assert.deepEqual(parseWorkspacePath("AGENTS.md.bak"), ["AGENTS.md.bak"]);

const INVALID: [number, string] = [400, "invalid_path"];
const RESERVED: [number, string] = [403, "reserved_path"];
assert.deepEqual(
  ["", "/etc/hosts", "../daemon.json", "a/../../x", "./a", "a//b", "a/", ".hidden", "a/.git/config", "a\\b", "a\0b"].map(refusal),
  Array(11).fill(INVALID),
);
assert.deepEqual(
  ["AGENTS.md", "agents.md", "Skills/x/SKILL.md", "artifacts", "ARTIFACTS/report.html", "skills"].map(refusal),
  Array(6).fill(RESERVED),
);
assert.deepEqual(refusal("Agents.md".normalize("NFD")), RESERVED);
assert.deepEqual(refusal(new URLSearchParams("path=%2e%2e/x").get("path")!), INVALID, "a percent-encoded .. decodes once, then is refused");

assert.deepEqual(
  ["0f8a7e2c-4b1d-4c7e-9a55-3c2d1e0f9b8a", "c1", "a.b_c-d"].map(isChatId),
  [true, true, true],
);
assert.deepEqual(["", "-a", "a-", "../x", "a/b", "a b", ".a"].map(isChatId), [false, false, false, false, false, false, false]);

process.stdout.write("ok — workspace paths stay inside the workspace and off the harness's own entries; chat ids follow Pi's session id rule\n");
