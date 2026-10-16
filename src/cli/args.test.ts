import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ONBOARDING_VERSION } from "@pi-template/contracts";
import { parseScheduleAdd, resolveBareInvocation } from "./args";

const entryRoot = mkdtempSync(join(tmpdir(), "pi-template-entry-routing-"));
const markerPath = join(entryRoot, "onboarded.json");

try {
  assert.equal(resolveBareInvocation({ markerPath, isTTY: true }), "onboard");
  assert.equal(resolveBareInvocation({ markerPath, isTTY: false }), "setup-required");
  writeFileSync(markerPath, JSON.stringify({ version: ONBOARDING_VERSION, completedAt: "2026-07-17T12:00:00.000Z" }));
  assert.equal(resolveBareInvocation({ markerPath, isTTY: true }), "interactive");
  assert.equal(resolveBareInvocation({ markerPath, isTTY: false }), "status");
} finally {
  rmSync(entryRoot, { recursive: true, force: true });
}

const prompt = parseScheduleAdd({ name: "hourly check", every: "1h", prompt: "inspect state", timeout: "90" }, []);
assert.deepEqual(prompt, {
  name: "hourly check",
  trigger: { kind: "every", everyMs: 3_600_000 },
  payload: { kind: "prompt", prompt: "inspect state" },
  timeoutSeconds: 90,
});

const command = parseScheduleAdd(
  { cron: "0 9 * * *", tz: "Europe/Helsinki" },
  ["node", "task.mjs", "--exact-argument"],
);
assert.deepEqual(command.trigger, { kind: "cron", expression: "0 9 * * *", timeZone: "Europe/Helsinki" });
assert.deepEqual(command.payload, { kind: "command", argv: ["node", "task.mjs", "--exact-argument"] });
assert.equal(command.timeoutSeconds, 600);

assert.throws(() => parseScheduleAdd({ every: "nope", prompt: "x" }, []), /duration/);
assert.throws(() => parseScheduleAdd({ every: "1m" }, []), /payload/);
assert.throws(() => parseScheduleAdd({ cron: "* * * * *", prompt: "x" }, []), /--tz/);
assert.throws(() => parseScheduleAdd({ at: "2026-10-01T09:00:00Z", every: "1m", prompt: "x" }, []), /exactly one/);

process.stdout.write("ok — schedule add preserves exact command argv; bare invocation routes by marker and terminal\n");
