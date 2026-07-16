// The MVP acceptance loop (docs/porting.md#mvp-acceptance, docs/testing.md#mvp-gate):
// fresh harness home → daemon → self-description before onboarding → non-interactive
// onboarding → a scheduled prompt executes in a fresh isolated session (stubbed model
// layer) → the run lands as durable truth in SQLite → the harness is interrogated about
// itself and its state through the Gateway. Deterministic and model-free; the paid-model
// counterpart is the opt-in live smoke.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DatabaseQueryAction,
  ScheduleKind,
  ScheduledPayloadKind,
  ScheduleRunStatus,
  type ScheduledPromptRunRequest,
} from "@pi-template/contracts";
import { runOnboarding } from "../src/agent";
import { startDaemon } from "../src/daemon";
import { connectGateway } from "../src/gateway";
import { passingOnboardingDependencies, testOnboardingAnswers } from "./helpers/onboarding";

const previousHome = process.env.PI_TEMPLATE_HOME;
const home = mkdtempSync(join(tmpdir(), "pi-template-acceptance-"));
process.env.PI_TEMPLATE_HOME = home;

// The stubbed model layer at the scheduler's prompt-runner seam: records each isolated
// run request so session-freshness and snapshot immutability are assertable.
const promptRuns: ScheduledPromptRunRequest[] = [];
const stubbedPromptRunner = async (request: ScheduledPromptRunRequest) => {
  promptRuns.push(request);
  return { exitCode: 0, stdout: `answered: ${request.payload.prompt}`, stderr: "", transcriptId: `transcript-${request.runId}` };
};

let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
try {
  daemon = await startDaemon({ port: 0, scheduler: { promptRunner: stubbedPromptRunner } });
  const client = await connectGateway({ home });
  assert.ok(client, "fresh daemon is discoverable");

  // Self-description works before any trust is established: a newcomer can ask the
  // harness how to build a harness before onboarding.
  const guidance = await client.queryDocs("how do I build a harness like this");
  assert.ok(guidance.matches.length > 0, "the harness answers about itself pre-onboarding");
  assert.ok(guidance.readingPlan.length > 0 && guidance.readingPlan.length <= 5);
  assert.equal((await client.queryDocs("how do I add a scheduled prompt")).matches[0]?.id, "scheduler");

  // Model and durable-state work stays closed until onboarding completes.
  await assert.rejects(() => client.listSchedules(), (error: { status?: number }) => error.status === 428);

  const onboarding = await runOnboarding(testOnboardingAnswers(home), passingOnboardingDependencies(home));
  assert.equal(onboarding.complete, true);
  assert.equal((await client.ready()).setupRequired, false);

  // Schedule a prompt and run it twice: fresh isolated identity per occurrence.
  const schedule = await client.createSchedule({
    name: "acceptance prompt",
    enabled: true,
    trigger: { kind: ScheduleKind.At, at: new Date(Date.now() + 3_600_000).toISOString() },
    payload: { kind: ScheduledPayloadKind.Prompt, prompt: "summarize this harness" },
    cwd: home,
    timeoutSeconds: 30,
  });
  const firstRun = await client.runSchedule(schedule.id);
  const secondRun = await client.runSchedule(schedule.id);
  assert.equal(promptRuns.length, 2);
  assert.notEqual(promptRuns[0]!.runId, promptRuns[1]!.runId, "each occurrence gets a fresh run identity");
  assert.equal(promptRuns[0]!.schedule.id, schedule.id, "immutable snapshot carries the schedule");

  // The runs are durable truth in SQLite, visible through the read-only query surface.
  const tables = await client.queryDatabase({ action: DatabaseQueryAction.ListTables }) as Array<{ name: string }>;
  for (const required of ["notes", "schedules", "schedule_runs"]) {
    assert.ok(tables.some(({ name }) => name === required), `${required} table is documented and live`);
  }
  const runs = await client.queryDatabase({
    action: DatabaseQueryAction.Query,
    sql: "SELECT id, status, transcript_id FROM schedule_runs ORDER BY id",
  }) as { rows: Array<{ id: string; status: string; transcript_id: string }> };
  assert.equal(runs.rows.length, 2);
  for (const run of [firstRun, secondRun]) {
    const row = runs.rows.find(({ id }) => id === run.id);
    assert.ok(row, "manual run is a durable run record");
    assert.equal(row.status, ScheduleRunStatus.Completed);
    assert.equal(row.transcript_id, `transcript-${run.id}`);
  }

  // The worked example closes the loop: write through the Gateway, read through the tool surface.
  await client.createNote({ body: "acceptance ran the full loop" });
  const notes = await client.queryDatabase({
    action: DatabaseQueryAction.Query,
    sql: "SELECT body FROM notes",
  }) as { rows: Array<{ body: string }> };
  assert.equal(notes.rows[0]?.body, "acceptance ran the full loop");

  client.close();
  console.log("ok — acceptance: fresh home to interrogated harness, end to end");
} finally {
  await daemon?.close();
  process.env.PI_TEMPLATE_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
}
