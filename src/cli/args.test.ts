import assert from "node:assert/strict";
import { parseCliArgs } from "./args";

assert.deepEqual(parseCliArgs(["docs", "list"]), { kind: "docs-list" });
assert.deepEqual(parseCliArgs(["docs", "read", "scheduler"]), { kind: "docs-read", id: "scheduler" });
assert.deepEqual(parseCliArgs(["docs", "query", "how", "do", "schedules", "work?"]), {
  kind: "docs-query",
  question: "how do schedules work?",
});
assert.deepEqual(parseCliArgs(["notes", "add", "keep", "one", "writer"]), {
  kind: "notes-add",
  body: "keep one writer",
});
assert.deepEqual(parseCliArgs(["notes", "list"]), { kind: "notes-list" });
assert.deepEqual(parseCliArgs(["notes", "remove", "note-1"]), { kind: "notes-remove", id: "note-1" });

const prompt = parseCliArgs([
  "schedule", "add", "--name", "hourly check", "--every", "1h",
  "--prompt", "inspect state", "--timeout", "90",
]);
assert.equal(prompt.kind, "schedule-add");
if (prompt.kind === "schedule-add") {
  assert.equal(prompt.name, "hourly check");
  assert.deepEqual(prompt.trigger, { kind: "every", everyMs: 3_600_000 });
  assert.deepEqual(prompt.payload, { kind: "prompt", prompt: "inspect state" });
  assert.equal(prompt.timeoutSeconds, 90);
}

const command = parseCliArgs([
  "schedule", "add", "--cron", "0 9 * * *", "--tz", "Europe/Helsinki",
  "--", "node", "task.mjs", "--exact-argument",
]);
assert.equal(command.kind, "schedule-add");
if (command.kind === "schedule-add") {
  assert.deepEqual(command.trigger, { kind: "cron", expression: "0 9 * * *", timeZone: "Europe/Helsinki" });
  assert.deepEqual(command.payload, { kind: "command", argv: ["node", "task.mjs", "--exact-argument"] });
}

assert.throws(() => parseCliArgs(["schedule", "add", "--every", "nope", "--prompt", "x"]), /duration/);
assert.throws(() => parseCliArgs(["schedule", "add", "--every", "1m"]), /payload/);
assert.throws(() => parseCliArgs(["schedule", "add", "--cron", "* * * * *", "--prompt", "x"]), /--tz/);
assert.throws(() => parseCliArgs(["frobnicate"]), /unknown command/);

process.stdout.write("ok — CLI arguments preserve exact command argv and selected command surface\n");
