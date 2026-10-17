import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  DomainEventKind,
  ScheduleKind,
  ScheduledPayloadKind,
  ScheduleRunStatus,
  ScheduleRunTrigger,
  type DomainEvent,
  type ScheduleCreateInput,
} from "@pi-template/contracts";
import { StateDatabase } from "./database";
import { InMemoryEventBus } from "./event-bus";
import { OUTPUT_TAIL_BYTES, RevisionConflictError, State } from "./state";

const dir = mkdtempSync(join(tmpdir(), "pi-template-state-"));
const dbPath = join(dir, "state.db");
const futurePath = join(dir, "future.db");
let now = "2026-07-16T10:00:00.000Z";
let id = 0;
const nextId = (): string => `id-${++id}`;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

const scheduleInput = (name: string): ScheduleCreateInput => ({
  name,
  enabled: true,
  trigger: { kind: ScheduleKind.Every, everyMs: 60_000, anchorMs: 0 },
  payload: { kind: ScheduledPayloadKind.Command, argv: ["printf", "ok"] },
  cwd: dir,
  timeoutSeconds: 30,
});

try {
  // Migrations are explicit, idempotent, and refuse a database from newer code.
  new StateDatabase(dbPath).close();
  const migrated = new DatabaseSync(dbPath, { readOnly: true });
  assert.deepEqual(
    (migrated.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: number }>).map(
      ({ version }) => version,
    ),
    [1, 2],
  );
  assert.deepEqual(
    (migrated.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all() as Array<{ name: string }>).map(({ name }) => name),
    ["notes", "schedule_runs", "schedules", "schema_migrations"],
  );
  migrated.close();
  new StateDatabase(dbPath).close();
  const reapplied = new DatabaseSync(dbPath, { readOnly: true });
  assert.equal(
    (reapplied.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get() as { count: number }).count,
    2,
    "reopening an up-to-date database does not reapply a migration",
  );
  reapplied.close();

  // v2: a schedule stored before query_database and save_note retired allows bash in their place.
  const retiredPath = join(dir, "retired.db");
  new StateDatabase(retiredPath).close();
  const v1 = new DatabaseSync(retiredPath);
  v1.exec("DELETE FROM schema_migrations WHERE version = 2");
  const insertSchedule = v1.prepare(`INSERT INTO schedules (id, name, enabled, trigger_kind, trigger_json, payload_kind,
    payload_json, cwd, timeout_seconds, revision, created_at, updated_at) VALUES (?, ?, 1, 'every', '{}', ?, ?, ?, 30, 1, ?, ?)`);
  const storedPayloads = {
    "both-retired": { kind: "prompt", prompt: "count", toolsAllow: ["query_database", "read", "save_note"] },
    "beside-bash": { kind: "prompt", prompt: "count", toolsAllow: ["bash", "query_database"] },
    "untouched": { kind: "prompt", prompt: "count", toolsAllow: ["read"] },
    "no-tools": { kind: "prompt", prompt: "count" },
    "command": { kind: "command", argv: ["query_database"] },
  };
  for (const [name, payload] of Object.entries(storedPayloads)) {
    insertSchedule.run(name, name, payload.kind, JSON.stringify(payload), dir, now, now);
  }
  v1.prepare(`INSERT INTO schedule_runs (id, schedule_id, trigger, payload_snapshot_json, cwd, timeout_seconds, status, created_at)
    VALUES ('run-before', 'both-retired', 'manual', ?, ?, 30, 'completed', ?)`).run(JSON.stringify(storedPayloads["both-retired"]), dir, now);
  v1.close();
  new StateDatabase(retiredPath).close();
  const v2 = new DatabaseSync(retiredPath, { readOnly: true });
  assert.deepEqual(
    Object.fromEntries((v2.prepare("SELECT id, payload_json FROM schedules ORDER BY id").all() as Array<{ id: string; payload_json: string }>)
      .map(({ id: scheduleId, payload_json }) => [scheduleId, JSON.parse(payload_json)])),
    {
      "both-retired": { kind: "prompt", prompt: "count", toolsAllow: ["bash", "read"] },
      "beside-bash": { kind: "prompt", prompt: "count", toolsAllow: ["bash"] },
      "untouched": { kind: "prompt", prompt: "count", toolsAllow: ["read"] },
      "no-tools": { kind: "prompt", prompt: "count" },
      "command": { kind: "command", argv: ["query_database"] },
    },
  );
  assert.deepEqual(
    JSON.parse((v2.prepare("SELECT payload_snapshot_json FROM schedule_runs").get() as { payload_snapshot_json: string }).payload_snapshot_json),
    storedPayloads["both-retired"],
    "a run keeps the tools it ran with",
  );
  v2.close();

  const future = new DatabaseSync(futurePath);
  future.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  future.exec("CREATE TABLE durable_truth (value TEXT NOT NULL)");
  future.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(3, now);
  future.prepare("INSERT INTO durable_truth (value) VALUES (?)").run("preserve me");
  future.close();
  assert.throws(() => new StateDatabase(futurePath), /newer schema version 3/);
  const preserved = new DatabaseSync(futurePath, { readOnly: true });
  assert.equal((preserved.prepare("SELECT value FROM durable_truth").get() as { value: string }).value, "preserve me");
  assert.equal((preserved.prepare("SELECT version FROM schema_migrations").get() as { version: number }).version, 3);
  preserved.close();

  const events: DomainEvent[] = [];
  const visibleNotesAtEvent: string[][] = [];
  const bus = new InMemoryEventBus();
  bus.subscribe(() => {
    throw new Error("one subscriber must not break the writer or its peers");
  });
  let state: State;
  bus.subscribe((event) => {
    events.push(event);
    if (event.kind === DomainEventKind.NoteChanged) {
      visibleNotesAtEvent.push(state.listNotes().map((note) => note.body));
    }
  });
  state = new State(dbPath, { bus, now: () => now, id: nextId });

  const note = state.createNote({ body: "Remember the durable seam" });
  assert.deepEqual(state.listNotes(), [note]);
  await tick();
  assert.deepEqual(visibleNotesAtEvent, [["Remember the durable seam"]], "events observe committed truth");
  assert.deepEqual(events.at(-1), { kind: DomainEventKind.NoteChanged, noteId: note.id });
  assert.equal(state.deleteNote(note.id), true);
  assert.equal(state.deleteNote(note.id), false, "deleting a missing note is an event-free no-op");
  await tick();
  assert.deepEqual(state.listNotes(), []);

  const schedule = state.createSchedule(scheduleInput("nightly"), "2026-07-16T11:00:00.000Z");
  assert.equal(schedule.revision, 1);
  assert.equal(schedule.nextRunAt, "2026-07-16T11:00:00.000Z");
  assert.deepEqual(state.listDueSchedules("2026-07-16T10:59:59.999Z"), []);
  assert.deepEqual(state.listDueSchedules("2026-07-16T11:00:00.000Z"), [schedule]);
  await tick();

  const eventCountBeforeFailure = events.length;
  assert.throws(
    () => state.createSchedule(scheduleInput("nightly")),
    /unique|constraint/i,
    "a failed transaction surfaces the SQLite constraint",
  );
  await tick();
  assert.equal(events.length, eventCountBeforeFailure, "a failed transaction publishes nothing");

  assert.throws(
    () => state.updateSchedule(schedule.id, { ...scheduleInput("nightly"), enabled: false }, 99),
    RevisionConflictError,
  );
  const updated = state.updateSchedule(
    schedule.id,
    { ...scheduleInput("nightly renamed"), enabled: false },
    schedule.revision,
    null,
  );
  assert.equal(updated.revision, 2);
  assert.equal(updated.name, "nightly renamed");
  assert.equal(updated.enabled, false);
  assert.equal(state.deleteSchedule(schedule.id), true);
  assert.equal(state.deleteSchedule(schedule.id), false);
  assert.deepEqual(state.listSchedules(), []);

  const runnable = state.createSchedule(scheduleInput("runnable"));
  const claimable = state.createSchedule(scheduleInput("claimable"), "2026-07-16T10:00:00.000Z");
  const claimed = state.claimScheduledRun(
    claimable,
    "2026-07-16T10:00:00.000Z",
    "2026-07-16T10:05:00.000Z",
    true,
    { scheduledFor: "2026-07-16T10:00:00.000Z", startedAfterMs: 0, missedOccurrences: 0 },
  );
  assert.equal(claimed?.status, ScheduleRunStatus.Running);
  assert.equal(state.scheduleById(claimable.id)?.revision, 2);
  assert.equal(state.scheduleById(claimable.id)?.nextRunAt, "2026-07-16T10:05:00.000Z");
  assert.equal(
    state.claimScheduledRun(
      claimable,
      "2026-07-16T10:00:00.000Z",
      null,
      false,
      { scheduledFor: "2026-07-16T10:00:00.000Z", startedAfterMs: 0, missedOccurrences: 0 },
    ),
    undefined,
    "a stale due occurrence cannot create a second run",
  );

  const completedRun = state.createRun(runnable, ScheduleRunTrigger.Manual);
  assert.equal(completedRun.status, ScheduleRunStatus.Running);
  const oversized = "prefix-" + "x".repeat(OUTPUT_TAIL_BYTES * 2);
  now = "2026-07-16T10:01:00.000Z";
  const completed = state.completeRun(completedRun.id, {
    exitCode: 0,
    stdout: oversized,
    stderr: "",
    transcriptId: "transcript-1",
  });
  assert.equal(completed.status, ScheduleRunStatus.Completed);
  assert.match(completed.stdoutTail ?? "", /truncated to last/);
  assert.ok(Buffer.byteLength(completed.stdoutTail ?? "") <= OUTPUT_TAIL_BYTES + 64);
  assert.equal(completed.stderrTail, "");

  const failedRun = state.createRun(runnable, ScheduleRunTrigger.Manual);
  const failed = state.failRun(failedRun.id, {
    error: "command failed",
    exitCode: 7,
    stdout: "partial output",
    stderr: "failure detail",
  });
  assert.equal(failed.status, ScheduleRunStatus.Failed);
  assert.equal(failed.error, "command failed");
  assert.equal(failed.exitCode, 7);

  const interruptedRun = state.createRun(runnable, ScheduleRunTrigger.Manual);
  assert.equal(state.markInterrupted(interruptedRun.id, "shutdown").status, ScheduleRunStatus.Interrupted);
  assert.throws(() => state.markInterrupted(interruptedRun.id, "again"), /not running/i);

  const abandonedRun = state.createRun(runnable, ScheduleRunTrigger.Scheduled, "2026-07-16T10:02:00.000Z");
  state.close();

  now = "2026-07-16T10:03:00.000Z";
  const recovered = new State(dbPath, { bus, now: () => now, id: nextId });
  const recoveredRun = recovered.listRuns().find((run) => run.id === abandonedRun.id);
  assert.equal(recoveredRun?.status, ScheduleRunStatus.Interrupted);
  assert.equal(recoveredRun?.finishedAt, now);
  assert.match(recoveredRun?.error ?? "", /startup|previous/i);
  await tick();
  assert.ok(
    events.some(
      (event) => event.kind === DomainEventKind.ScheduleRunChanged
        && event.runId === abandonedRun.id
        && event.status === ScheduleRunStatus.Interrupted,
    ),
    "startup recovery emits an invalidation after its durable update",
  );
  recovered.close();

  process.stdout.write("ok — state, events, schedules, runs, and migrations\n");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
