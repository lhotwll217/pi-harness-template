// Integration: permission reconciliation against a real temporary harness home — mode
// defaults per surface class, protected-path deny rules, and preservation of
// owner-authored JSONC (rules and comments) across reconciles.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "jsonc-parser";
import { harnessPaths } from "./harness-home";
import { reconcilePermissionSettings, savePermissionMode, type PiPermissionPatternMap } from "./permissions";

const home = mkdtempSync(join(tmpdir(), "pi-template-perm-"));
try {
  const paths = harnessPaths(home);
  const protectedDir = join(home, "protected-tree");
  mkdirSync(protectedDir, { recursive: true });
  writeFileSync(paths.protectedPaths, JSON.stringify({ paths: [protectedDir], repos: [] }));

  // read-only (default): reads allow, changes and bounded state changes deny.
  const readOnly = savePermissionMode(home, "read-only");
  assert.equal((readOnly.permission.read as PiPermissionPatternMap)["*"], "allow");
  assert.equal((readOnly.permission.query_database as PiPermissionPatternMap)["*"], "allow");
  assert.equal((readOnly.permission.edit as PiPermissionPatternMap)["*"], "deny");
  assert.equal((readOnly.permission.save_note as PiPermissionPatternMap)["*"], "deny");
  assert.equal(readOnly.permission["*"], "deny");

  // Protected paths become generated deny rules for the tree and its contents.
  const pathRules = readOnly.permission.path as PiPermissionPatternMap;
  assert.deepEqual(pathRules[protectedDir], { action: "deny", reason: "Pi Template protected paths" });
  assert.deepEqual(pathRules[`${protectedDir}/*`], { action: "deny", reason: "Pi Template protected paths" });

  // ask: changes prompt, bounded harness state changes stay allowed.
  const ask = savePermissionMode(home, "ask");
  assert.equal((ask.permission.edit as PiPermissionPatternMap)["*"], "ask");
  assert.equal((ask.permission.save_note as PiPermissionPatternMap)["*"], "allow");
  assert.equal((ask.permission.bash as PiPermissionPatternMap)["*"], "ask");

  // Owner-authored JSONC rules and comments survive reconciliation.
  const config = readFileSync(paths.piPermissionConfig, "utf8");
  const withOwnerRule = config.replace(
    '"path": {',
    '"path": {\n    // owner note: keep this rule\n    "/tmp/owner-carve-out": "allow",',
  );
  mkdirSync(dirname(paths.piPermissionConfig), { recursive: true });
  writeFileSync(paths.piPermissionConfig, withOwnerRule);
  reconcilePermissionSettings(home);
  const after = readFileSync(paths.piPermissionConfig, "utf8");
  assert.ok(after.includes("owner note: keep this rule"), "owner comment must survive");
  const reparsed = parse(after) as { permission: Record<string, PiPermissionPatternMap> };
  assert.equal(reparsed.permission.path["/tmp/owner-carve-out"], "allow");
  assert.deepEqual(reparsed.permission.path[protectedDir], { action: "deny", reason: "Pi Template protected paths" });
} finally {
  rmSync(home, { recursive: true, force: true });
}
console.log("permissions.integration.test.ts ok");
