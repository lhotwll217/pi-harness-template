// Integration: permission reconciliation against a real temporary harness home — mode
// defaults per surface class, the generated agent CLI rules, protected-path deny rules, and
// preservation of owner-authored JSONC (rules and comments) across reconciles.
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

  const cliRules = {
    "pi-template db *": "allow",
    "pi-template docs *": "allow",
    "pi-template notes *": "allow",
    "pi-template schedule *": "allow",
    "pi-template status *": "allow",
    "pi-template doctor *": "allow",
  };
  // A home onboarded before the data tools retired: their surfaces go, the owner's bash rule stays last.
  mkdirSync(dirname(paths.piPermissionConfig), { recursive: true });
  writeFileSync(paths.piPermissionConfig, `{
  "permission": {
    // owner note: older home
    "query_database": { "*": "allow" },
    "save_note": { "*": "allow" },
    "bash": { "*": "allow", "pi-template db *": "deny" }
  }
}
`);
  const allow = savePermissionMode(home);
  assert.equal(allow.permission["*"], "allow");
  assert.equal(allow.permission.query_database, undefined);
  assert.equal(allow.permission.save_note, undefined);
  assert.deepEqual(Object.entries(allow.permission.bash as PiPermissionPatternMap), [
    ["*", "allow"],
    ...Object.entries(cliRules).filter(([rule]) => rule !== "pi-template db *"),
    ["pi-template db *", "deny"],
  ]);
  assert.equal((allow.permission.edit as PiPermissionPatternMap)["*"], "allow");
  assert.equal(allow.permission.path_write, undefined);
  const allowFile = parse(readFileSync(paths.piPermissionConfig, "utf8")) as { permission: Record<string, PiPermissionPatternMap> };
  assert.deepEqual(Object.entries(allowFile.permission.bash), Object.entries(allow.permission.bash as PiPermissionPatternMap));
  assert.equal("query_database" in allowFile.permission || "save_note" in allowFile.permission, false);
  assert.ok(readFileSync(paths.piPermissionConfig, "utf8").includes("owner note: older home"));
  writeFileSync(paths.piPermissionConfig, "{}\n");

  const readOnly = savePermissionMode(home, "read-only");
  assert.equal((readOnly.permission.read as PiPermissionPatternMap)["*"], "allow");
  assert.equal((readOnly.permission.edit as PiPermissionPatternMap)["*"], "deny");
  assert.equal(readOnly.permission["*"], "deny");
  assert.deepEqual(readOnly.permission.bash, { "*": "deny", ...cliRules });
  assert.deepEqual(readOnly.permission.path_write, { "*": "deny" });
  const readOnlyFile = parse(readFileSync(paths.piPermissionConfig, "utf8")) as { permission: Record<string, PiPermissionPatternMap> };
  assert.deepEqual(Object.entries(readOnlyFile.permission.bash), Object.entries({ "*": "deny", ...cliRules }));
  assert.deepEqual(readOnlyFile.permission.path_write, { "*": "deny" });

  // Protected paths become generated deny rules for the tree and its contents.
  const pathRules = readOnly.permission.path as PiPermissionPatternMap;
  assert.deepEqual(pathRules[protectedDir], { action: "deny", reason: "Pi Template protected paths" });
  assert.deepEqual(pathRules[`${protectedDir}/*`], { action: "deny", reason: "Pi Template protected paths" });

  // ask: changes and every write a command names prompt; bash runs only the CLI, as in read-only.
  const ask = savePermissionMode(home, "ask");
  assert.equal((ask.permission.edit as PiPermissionPatternMap)["*"], "ask");
  assert.deepEqual(ask.permission.bash, { "*": "deny", ...cliRules });
  assert.deepEqual(ask.permission.path_write, { "*": "ask" });
  assert.deepEqual((parse(readFileSync(paths.piPermissionConfig, "utf8")) as { permission: { path_write: object } }).permission.path_write, { "*": "ask" });

  // allow lifts the harness's write rule.
  const allowAgain = savePermissionMode(home, "allow");
  assert.deepEqual(allowAgain.permission.bash, { "*": "allow", ...cliRules });
  assert.equal(allowAgain.permission.path_write, undefined);
  assert.equal("path_write" in (parse(readFileSync(paths.piPermissionConfig, "utf8")) as { permission: object }).permission, false);
  savePermissionMode(home, "ask");

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
