import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSandboxAdapter } from "./anthropic-sandbox";

const dir = mkdtempSync(join(tmpdir(), "pi-template-sandbox-probe-"));
const allowedRoot = join(dir, "allowed");
const allowedFile = join(allowedRoot, "readable.txt");
const canaryFile = join(dir, "outside-canary.txt");

try {
  mkdirSync(allowedRoot, { recursive: true });
  writeFileSync(allowedFile, "allowed\n");
  writeFileSync(canaryFile, "must not be readable\n");
  const result = await createSandboxAdapter().verify({
    filesystem: {
      allowedReadRoots: [allowedRoot],
      allowedWriteRoots: [],
      deniedReadRoots: [canaryFile],
    },
    process: { allowSubprocesses: true },
    network: { mode: "deny", allowedDomains: [] },
  }, { allowedFile, canaryFile });

  if (result.unavailable) {
    process.stdout.write(`SKIP — real sandbox verification probe unavailable: ${result.reason}\n`);
  } else {
    assert.equal(result.ok, true, result.reason);
    assert.deepEqual(result.checks, {
      allowedRootReadPermitted: true,
      canaryReadDenied: true,
      networkDenied: true,
    });
    process.stdout.write("ok — real sandbox probe denied canary and network while permitting allowed-root read\n");
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
