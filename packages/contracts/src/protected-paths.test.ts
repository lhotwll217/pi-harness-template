// Unit: protected-path policy — tree containment, repo identity, case folding, empty policy.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isProtected, loadProtectedPaths, pathIdentities } from "./protected-paths";

const home = mkdtempSync(join(tmpdir(), "pi-template-protected-"));
try {
  // Missing file → block nothing.
  assert.deepEqual(loadProtectedPaths(home), { paths: [], repos: [] });
  assert.equal(isProtected(loadProtectedPaths(home), { cwd: "/anywhere" }), false);

  writeFileSync(
    join(home, "protected_paths.json"),
    JSON.stringify({ paths: ["/Users/me/Personal/"], repos: ["Secrets"] }),
  );
  const policy = loadProtectedPaths(home);
  // Trailing slash normalized away.
  assert.deepEqual(policy.paths, ["/Users/me/Personal"]);

  // Tree containment: the path itself and everything under it, never a sibling prefix.
  assert.equal(isProtected(policy, { cwd: "/Users/me/Personal" }), true);
  assert.equal(isProtected(policy, { cwd: "/Users/me/Personal/deep/dir" }), true);
  assert.equal(isProtected(policy, { cwd: "/Users/me/PersonalSite" }), false);

  // Case-insensitive: over-block, never leak.
  assert.equal(isProtected(policy, { cwd: "/users/ME/personal/x" }), true);
  assert.equal(isProtected(policy, { repo: "secrets" }), true);
  assert.equal(isProtected(policy, { repo: "other" }), false);

  // pathIdentities resolves through symlinked ancestors to the canonical location.
  const real = join(home, "real-target");
  mkdirSync(real, { recursive: true });
  const link = join(home, "link");
  symlinkSync(real, link);
  const identities = pathIdentities(join(link, "inner"));
  assert.ok(identities.includes(join(link, "inner")));
  assert.ok(identities.some((p) => p.includes("real-target")), `expected canonical identity in ${identities}`);
} finally {
  rmSync(home, { recursive: true, force: true });
}
console.log("protected-paths.test.ts ok");
