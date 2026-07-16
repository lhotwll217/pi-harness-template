import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentToolId,
  ScheduleKind,
  ScheduledPayloadKind,
  type ScheduledPromptRunRequest,
} from "@pi-template/contracts";
import { createScheduledPromptRunner, type PromptSessionFactory } from "./prompt-runner";

const dir = mkdtempSync(join(tmpdir(), "pi-template-prompt-runner-"));
const created: Array<{
  id: string;
  tools: readonly AgentToolId[];
  headless: boolean;
  transcriptDir: string;
  provenance: Parameters<PromptSessionFactory>[0]["provenance"];
}> = [];
let serial = 0;
let abortCurrent: (() => void) | undefined;

const sessions: PromptSessionFactory = async (input) => {
  const id = `fresh-${++serial}`;
  created.push({
    id,
    tools: input.toolsAllow,
    headless: input.headless,
    transcriptDir: input.transcriptDir,
    provenance: input.provenance,
  });
  let aborted = false;
  abortCurrent = () => { aborted = true; };
  return {
    id,
    async prompt(text) {
      if (text.includes("wait for abort")) {
        while (!aborted) await new Promise<void>((resolve) => setImmediate(resolve));
      }
    },
    async abort() { aborted = true; },
    assistantText: () => `answer from ${id}`,
    assistantError: () => null,
    async dispose() {},
  };
};

const request = (prompt: string, toolsAllow: readonly AgentToolId[], signal = new AbortController().signal): ScheduledPromptRunRequest => ({
  payload: { kind: ScheduledPayloadKind.Prompt, prompt, toolsAllow },
  cwd: dir,
  schedule: {
    id: "schedule-1",
    name: "isolated prompt",
    enabled: true,
    trigger: { kind: ScheduleKind.Every, everyMs: 60_000, anchorMs: 0 },
    payload: { kind: ScheduledPayloadKind.Prompt, prompt, toolsAllow },
    cwd: dir,
    timeoutSeconds: 30,
    revision: 1,
    createdAt: "2026-07-16T12:00:00.000Z",
    updatedAt: "2026-07-16T12:00:00.000Z",
    nextRunAt: null,
  },
  runId: `run-${serial + 1}`,
  signal,
});

try {
  const run = createScheduledPromptRunner({ home: dir, sessions, readiness: () => true });
  const first = await run(request("first", [AgentToolId.QueryDatabase]));
  const second = await run(request("second", [AgentToolId.SaveNote]));
  assert.equal(first.transcriptId, "fresh-1");
  assert.equal(second.transcriptId, "fresh-2");
  assert.deepEqual(created.map(({ tools }) => tools), [
    [AgentToolId.QueryDatabase],
    [AgentToolId.SaveNote],
  ]);
  assert.ok(created.every(({ headless }) => headless));
  assert.ok(created.every(({ transcriptDir }) => transcriptDir === join(dir, "transcripts")));
  assert.deepEqual(created[0]?.provenance, {
    origin: "scheduler",
    caller: "scheduler",
    scheduleId: "schedule-1",
    runId: "run-1",
    scheduleName: "isolated prompt",
    trigger: "every",
    taskDirectory: dir,
    effectiveCapabilities: [AgentToolId.QueryDatabase],
    trustPolicyVersion: 1,
    approvalPolicy: "deny-when-live-approval-is-unavailable",
  });

  const controller = new AbortController();
  abortCurrent = undefined;
  const pending = run(request("wait for abort", [AgentToolId.QueryDatabase], controller.signal));
  while (!abortCurrent) await new Promise<void>((resolve) => setImmediate(resolve));
  const timeout = new Error("schedule timed out");
  controller.abort(timeout);
  await assert.rejects(pending, (error) => error === timeout);

  const alreadyAborted = new AbortController();
  alreadyAborted.abort(new Error("cancelled before start"));
  await assert.rejects(run(request("never starts", [], alreadyAborted.signal)), /cancelled before start/);

  process.stdout.write("ok — scheduled prompts use fresh narrowed headless sessions and propagate aborts\n");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
