// Integration: harness home layout and settings against a real temporary filesystem —
// workspace creation is idempotent, owner-authored files are never overwritten, and
// settings round-trip with defaults for anything missing or invalid, except a damaged
// permission mode, which falls back to read-only.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_TOOL_POSTURE,
  ensureHarnessWorkspace,
  harnessPaths,
  loadHarnessSettings,
  saveHarnessSettings,
  unreadablePermissionMode,
} from "./harness-home";

const home = mkdtempSync(join(tmpdir(), "pi-template-home-"));
try {
  const paths = ensureHarnessWorkspace(home);
  assert.equal(paths.home, home);
  assert.ok(readFileSync(paths.workspaceInstructions, "utf8").includes("Pi Template instructions"));
  assert.deepEqual(readdirSync(paths.workspace).sort(), ["AGENTS.md", "artifacts", "skills"]);

  // Never overwrite owner-authored workspace content.
  writeFileSync(paths.workspaceInstructions, "owner words\n");
  ensureHarnessWorkspace(home);
  assert.equal(readFileSync(paths.workspaceInstructions, "utf8"), "owner words\n");

  // Defaults when nothing is saved.
  const defaults = loadHarnessSettings(home);
  assert.equal(defaults.permissionMode, "allow");
  assert.deepEqual(defaults.toolPosture, [...DEFAULT_TOOL_POSTURE]);
  assert.deepEqual(defaults.skillPolicy, { mode: "all-workspace", allowlist: [] });

  // Round-trip a patch; invalid values fall back rather than persisting garbage.
  const saved = saveHarnessSettings(home, {
    permissionMode: "ask",
    skillPolicy: { mode: "allowlist", allowlist: ["docs", "docs", " release "] },
  });
  assert.equal(saved.permissionMode, "ask");
  assert.deepEqual(saved.skillPolicy, { mode: "allowlist", allowlist: ["docs", "release"] });
  assert.equal(loadHarnessSettings(home).permissionMode, "ask");

  writeFileSync(harnessPaths(home).settings, JSON.stringify({ permissionMode: "bogus", toolPosture: ["nope"] }));
  const repaired = loadHarnessSettings(home);
  assert.equal(repaired.permissionMode, "read-only");
  assert.deepEqual(repaired.toolPosture, [...DEFAULT_TOOL_POSTURE]);
  assert.equal(
    unreadablePermissionMode(home),
    `settings record an invalid permission mode "bogus" at ${harnessPaths(home).settings}`,
  );

  writeFileSync(harnessPaths(home).settings, '{"permissionMode": "allow",}');
  assert.equal(loadHarnessSettings(home).permissionMode, "read-only");
  assert.equal(unreadablePermissionMode(home), `settings are not valid JSON at ${harnessPaths(home).settings}`);

  writeFileSync(harnessPaths(home).settings, JSON.stringify({ toolPosture: ["read"] }));
  assert.equal(loadHarnessSettings(home).permissionMode, "allow");
  assert.equal(unreadablePermissionMode(home), undefined);

  assert.throws(() => saveHarnessSettings(home, { alwaysOn: "maybe" as never }));
} finally {
  rmSync(home, { recursive: true, force: true });
}
console.log("harness-home.integration.test.ts ok");
