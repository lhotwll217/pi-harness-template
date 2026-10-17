import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GatewayRouteError } from "@pi-template/contracts";
import { createWorkspaceFiles } from "./files";

const root = mkdtempSync(join(tmpdir(), "pi-template-files-"));
const workspace = join(root, "workspace");
const outside = join(root, "outside");
let writes = 0;
const files = createWorkspaceFiles({ root: workspace, onWrite: () => { writes += 1; } });

const refusal = async (attempt: () => Promise<unknown>): Promise<[number, string]> => {
  try {
    await attempt();
  } catch (error) {
    assert.ok(error instanceof GatewayRouteError, String(error));
    return [error.status, error.code];
  }
  throw new Error("expected a refusal");
};

try {
  mkdirSync(join(workspace, "a"), { recursive: true });
  mkdirSync(join(workspace, "artifacts"));
  mkdirSync(join(workspace, "skills", "s"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(workspace, "AGENTS.md"), "steer\n");
  writeFileSync(join(workspace, "artifacts", "report.html"), "<p>\n");
  writeFileSync(join(workspace, "skills", "s", "SKILL.md"), "skill\n");
  writeFileSync(join(workspace, ".hidden"), "x\n");
  writeFileSync(join(workspace, "a", "b.md"), "# b\n");
  writeFileSync(join(workspace, "a", ".a.md.123.tmp"), "partial\n");
  writeFileSync(join(outside, "secret.txt"), "secret\n");
  symlinkSync("..", join(workspace, "link"));
  symlinkSync(outside, join(workspace, "a", "out"));
  symlinkSync(join(outside, "secret.txt"), join(workspace, "secret.txt"));

  const tree = await files.tree();
  assert.deepEqual(tree.entries.map(({ path, kind, size }) => ({ path, kind, size })), [
    { path: "a", kind: "directory", size: 0 },
    { path: "a/b.md", kind: "file", size: 4 },
  ]);
  assert.equal(tree.truncated, false);

  const read = await files.read("a/b.md");
  assert.equal(read.content, "# b\n");
  assert.equal(read.revision, `sha256:${createHash("sha256").update("# b\n").digest("hex")}`);

  const refusals = await Promise.all([
    "../outside/secret.txt", "/etc/hosts", "%2e%2e/x", "agents.md", "Skills/s/SKILL.md", "artifacts/report.html",
    ".hidden", "link/outside/secret.txt", "a/out/secret.txt", "secret.txt", "a", "missing.md", "a/b.md/x",
  ].map((path) => refusal(() => files.read(path === "%2e%2e/x" ? new URLSearchParams(`path=${path}`).get("path")! : path))));
  assert.deepEqual(refusals, [
    [400, "invalid_path"], [400, "invalid_path"], [400, "invalid_path"], [403, "reserved_path"], [403, "reserved_path"],
    [403, "reserved_path"], [400, "invalid_path"], [400, "symlink_rejected"], [400, "symlink_rejected"],
    [400, "symlink_rejected"], [400, "invalid_path"], [404, "not_found"], [400, "invalid_path"],
  ]);

  writeFileSync(join(workspace, "binary.bin"), Buffer.from([0xff, 0xfe, 0x00]));
  assert.deepEqual(await refusal(() => files.read("binary.bin")), [415, "not_text"]);
  writeFileSync(join(workspace, "big.txt"), "x".repeat(1_000_001));
  assert.deepEqual(await refusal(() => files.read("big.txt")), [413, "too_large"]);

  const created = await files.write("notes/today/hello.md", { content: "hello\n" });
  assert.equal(created.created, true);
  assert.equal(readFileSync(join(workspace, "notes", "today", "hello.md"), "utf8"), "hello\n");
  assert.equal(statSync(join(workspace, "notes", "today")).mode & 0o777, 0o700);
  assert.equal(statSync(join(workspace, "notes", "today", "hello.md")).mode & 0o777, 0o600);
  assert.equal(writes, 1);
  const updated = await files.write("notes/today/hello.md", { content: "hello again\n", baseRevision: created.revision });
  assert.equal(updated.created, false);
  assert.equal(writes, 2);
  try {
    await files.write("notes/today/hello.md", { content: "lost update\n", baseRevision: created.revision });
    assert.fail("a stale revision must be refused");
  } catch (error) {
    assert.ok(error instanceof GatewayRouteError);
    assert.deepEqual([error.status, error.code, error.details], [409, "file_changed", { current: { revision: updated.revision } }]);
  }
  assert.equal(readFileSync(join(workspace, "notes", "today", "hello.md"), "utf8"), "hello again\n");
  assert.equal(writes, 2, "a refused write is not reported");
  writeFileSync(join(workspace, "script.sh"), "echo 1\n", { mode: 0o755 });
  await files.write("script.sh", { content: "echo 2\n" });
  assert.equal(statSync(join(workspace, "script.sh")).mode & 0o777, 0o755, "an overwrite keeps the file's mode");
  assert.deepEqual(await refusal(() => files.write("a/out/new.txt", { content: "x" })), [400, "symlink_rejected"]);
  assert.deepEqual(await refusal(() => files.write("secret.txt", { content: "x" })), [400, "symlink_rejected"]);
  assert.deepEqual(await refusal(() => files.write("AGENTS.md", { content: "x" })), [403, "reserved_path"]);
  assert.deepEqual(await refusal(() => files.write("../escape.txt", { content: "x" })), [400, "invalid_path"]);
  assert.equal(readFileSync(join(outside, "secret.txt"), "utf8"), "secret\n");
  assert.deepEqual(readdirSync(outside), ["secret.txt"]);
  assert.deepEqual(readdirSync(join(workspace, "notes", "today")), ["hello.md"], "no temporary file is left behind");

  writes = 0;
  await Promise.all(Array.from({ length: 20 }, (_, index) => files.write("race.txt", { content: `${index}\n`.repeat(1000) })));
  assert.equal(writes, 20);
  assert.match(readFileSync(join(workspace, "race.txt"), "utf8"), /^(\d+)\n(?:\1\n){999}$/);

  process.stdout.write("ok — the workspace tree hides harness entries, links, and dot-names; file routes refuse escapes and stale revisions\n");
} finally {
  rmSync(root, { recursive: true, force: true });
}
