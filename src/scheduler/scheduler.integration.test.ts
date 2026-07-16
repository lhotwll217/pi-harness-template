import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DomainEventKind,
  ScheduleKind,
  ScheduledPayloadKind,
  ScheduleRunStatus,
  type ScheduleCreateInput,
  type ScheduledPromptRunRequest,
} from "@pi-template/contracts";
import { OUTPUT_TAIL_BYTES, RevisionConflictError, State, runQuery } from "../state";
import {
  Scheduler,
  SchedulerLifecycle,
  SchedulerShutdownPolicy,
  type SchedulerTimer,
  type SchedulerTimerHandle,
} from "./scheduler";

class ManualTimer implements SchedulerTimer {
  private readonly tasks = new Set<{ dueAt: number; callback: () => void; cancelled: boolean }>();

  set(delayMs: number, callback: () => void): SchedulerTimerHandle {
    const task = { dueAt: nowMs + delayMs, callback, cancelled: false };
    this.tasks.add(task);
    return { cancel: () => { task.cancelled = true; } };
  }

  async advanceBy(ms: number): Promise<void> {
    nowMs += ms;
    for (;;) {
      const due = [...this.tasks]
        .filter((task) => !task.cancelled && task.dueAt <= nowMs)
        .sort((left, right) => left.dueAt - right.dueAt)[0];
      if (!due) break;
      this.tasks.delete(due);
      due.callback();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

const dir = mkdtempSync(join(tmpdir(), "pi-template-scheduler-"));
let nowMs = Date.parse("2026-07-16T10:00:00.000Z");
let id = 0;
const state = new State(join(dir, "state.db"), {
  now: () => new Date(nowMs).toISOString(),
  id: () => `scheduler-id-${++id}`,
});
const timer = new ManualTimer();
const promptRequests: ScheduledPromptRunRequest[] = [];
const runningWasDurableBeforePrompt: boolean[] = [];
const gates = new Map<string, { promise: Promise<void>; release: () => void }>();
let activeSlowPrompts = 0;
let maximumActiveSlowPrompts = 0;

function createGate(key: string): { promise: Promise<void>; release: () => void } {
  let release = (): void => undefined;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  const gate = { promise, release };
  gates.set(key, gate);
  return gate;
}

async function flushWork(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitForFile(path: string): Promise<void> {
  while (!existsSync(path)) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function waitForRunStatus(scheduleId: string, status: ScheduleRunStatus): Promise<void> {
  if (state.listRuns(scheduleId)[0]?.status === status) return;
  await new Promise<void>((resolve) => {
    const unsubscribe = state.bus.subscribe((event) => {
      if (event.kind !== DomainEventKind.ScheduleRunChanged || event.scheduleId !== scheduleId) return;
      if (state.listRuns(scheduleId)[0]?.status !== status) return;
      unsubscribe();
      resolve();
    });
  });
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const scheduler = new Scheduler(state, {
  now: () => nowMs,
  timer,
  concurrency: 2,
  promptRunner: async (request) => {
    promptRequests.push(request);
    runningWasDurableBeforePrompt.push(
      state.listRuns(request.schedule.id).some(
        (run) => run.id === request.runId && run.status === ScheduleRunStatus.Running,
      ),
    );
    const gate = gates.get(request.payload.prompt);
    if (gate) {
      activeSlowPrompts += 1;
      maximumActiveSlowPrompts = Math.max(maximumActiveSlowPrompts, activeSlowPrompts);
      try {
        await gate.promise;
      } finally {
        activeSlowPrompts -= 1;
      }
    }
    return { exitCode: 0, stdout: "handled", stderr: "", transcriptId: `transcript-${request.runId}` };
  },
});

const input = (name: string): ScheduleCreateInput => ({
  name,
  enabled: true,
  trigger: { kind: ScheduleKind.Every, everyMs: 60_000, anchorMs: nowMs },
  payload: { kind: ScheduledPayloadKind.Command, argv: [process.execPath, "health.mjs"] },
  cwd: dir,
  timeoutSeconds: 30,
});

try {
  const schedule = scheduler.add(input("health check"));
  assert.equal(schedule.nextRunAt, "2026-07-16T10:01:00.000Z");
  assert.deepEqual(scheduler.list(), [schedule]);

  assert.throws(
    () => scheduler.update(schedule.id, input("stale update"), schedule.revision + 1),
    RevisionConflictError,
  );
  const updated = scheduler.update(schedule.id, input("renamed health check"), schedule.revision);
  assert.equal(updated.revision, 2);
  assert.equal(updated.createdAt, schedule.createdAt);
  assert.equal(scheduler.remove(schedule.id), true);
  assert.deepEqual(scheduler.list(), []);

  const duePrompt = scheduler.add({
    name: "isolated prompt",
    enabled: true,
    trigger: { kind: ScheduleKind.At, at: new Date(nowMs).toISOString() },
    payload: { kind: ScheduledPayloadKind.Prompt, prompt: "Inspect the harness" },
    cwd: dir,
    timeoutSeconds: 30,
  });
  scheduler.start();
  await timer.advanceBy(0);
  assert.equal(promptRequests.length, 1);
  assert.deepEqual(promptRequests[0].payload.toolsAllow, [], "headless prompts default to no capabilities");
  assert.notEqual(promptRequests[0].runId, duePrompt.id, "each occurrence receives a fresh run id");
  assert.deepEqual(promptRequests[0].schedule, duePrompt, "execution receives its immutable claimed snapshot");
  assert.deepEqual(runningWasDurableBeforePrompt, [true]);
  assert.equal(state.listRuns(duePrompt.id)[0].status, ScheduleRunStatus.Completed);
  assert.equal(state.scheduleById(duePrompt.id)?.enabled, false, "a one-time occurrence is claimed once");

  const recurringGate = createGate("slow recurring");
  const recurring = scheduler.add({
    name: "non-overlapping recurring prompt",
    enabled: true,
    trigger: { kind: ScheduleKind.Every, everyMs: 1_000, anchorMs: nowMs },
    payload: { kind: ScheduledPayloadKind.Prompt, prompt: "slow recurring" },
    cwd: dir,
    timeoutSeconds: 30,
  });
  await timer.advanceBy(1_000);
  assert.equal(state.listRuns(recurring.id).length, 1);
  await assert.rejects(() => scheduler.run(recurring.id), /already running/);
  await timer.advanceBy(1_000);
  assert.equal(state.listRuns(recurring.id).length, 1, "repeated wakes cannot overlap the same schedule");

  const claimedRecurring = state.scheduleById(recurring.id)!;
  scheduler.update(
    recurring.id,
    {
      name: claimedRecurring.name,
      enabled: false,
      trigger: claimedRecurring.trigger,
      payload: claimedRecurring.payload,
      cwd: claimedRecurring.cwd,
      timeoutSeconds: claimedRecurring.timeoutSeconds,
    },
    claimedRecurring.revision,
  );
  recurringGate.release();
  await flushWork();
  await timer.advanceBy(10_000);
  assert.equal(state.listRuns(recurring.id).length, 1, "disabling prevents future dispatch without changing the active run");

  const capGate = createGate("hold for global cap");
  maximumActiveSlowPrompts = 0;
  const cappedSchedules = ["first", "second", "third"].map((name) => scheduler.add({
    name: `capped ${name}`,
    enabled: true,
    trigger: { kind: ScheduleKind.At, at: new Date(nowMs).toISOString() },
    payload: { kind: ScheduledPayloadKind.Prompt, prompt: "hold for global cap" },
    cwd: dir,
    timeoutSeconds: 30,
  }));
  await timer.advanceBy(0);
  assert.deepEqual(
    scheduler.status(),
    { lifecycle: "running", activeRuns: 2, queuedRuns: 1, concurrency: 2, missedRunPolicy: "skip" },
  );
  assert.equal(maximumActiveSlowPrompts, 2, "configured global concurrency is never exceeded");
  assert.ok(cappedSchedules.every((item) => state.listRuns(item.id)[0].status === ScheduleRunStatus.Running));
  capGate.release();
  await flushWork();
  assert.equal(scheduler.status().activeRuns, 0);
  assert.ok(cappedSchedules.every((item) => state.listRuns(item.id)[0].status === ScheduleRunStatus.Completed));

  const overdue = scheduler.add({
    name: "overdue one-time prompt",
    enabled: true,
    trigger: { kind: ScheduleKind.At, at: new Date(nowMs - 60 * 60_000).toISOString() },
    payload: { kind: ScheduledPayloadKind.Prompt, prompt: "run overdue once" },
    cwd: dir,
    timeoutSeconds: 30,
  });
  await timer.advanceBy(0);
  await timer.advanceBy(5_000);
  assert.equal(state.listRuns(overdue.id).length, 1, "an overdue one-time schedule runs at most once");
  assert.equal(state.scheduleById(overdue.id)?.enabled, false);

  const backlogAnchor = nowMs;
  const backlog = scheduler.add({
    name: "skip recurring backlog",
    enabled: true,
    trigger: { kind: ScheduleKind.Every, everyMs: 1_000, anchorMs: backlogAnchor },
    payload: { kind: ScheduledPayloadKind.Prompt, prompt: "record missed context" },
    cwd: dir,
    timeoutSeconds: 30,
  });
  await timer.advanceBy(5_000);
  const backlogRequest = promptRequests.find((request) => request.schedule.id === backlog.id)!;
  assert.deepEqual(backlogRequest.triggerContext, {
    scheduledFor: new Date(backlogAnchor + 1_000).toISOString(),
    startedAfterMs: 4_000,
    missedOccurrences: 4,
  });
  const recordedContext = runQuery(
    `SELECT trigger_context_json AS context FROM schedule_runs WHERE schedule_id = '${backlog.id}'`,
    join(dir, "state.db"),
  ).rows[0]?.context;
  assert.deepEqual(JSON.parse(String(recordedContext)), backlogRequest.triggerContext);
  assert.equal(state.listRuns(backlog.id).length, 1, "recurring backlog collapses into one claimed run");
  assert.equal(state.scheduleById(backlog.id)?.nextRunAt, new Date(nowMs + 1_000).toISOString());
  const currentBacklog = state.scheduleById(backlog.id)!;
  scheduler.update(
    backlog.id,
    {
      name: currentBacklog.name,
      enabled: false,
      trigger: currentBacklog.trigger,
      payload: currentBacklog.payload,
      cwd: currentBacklog.cwd,
      timeoutSeconds: currentBacklog.timeoutSeconds,
    },
    currentBacklog.revision,
  );

  const manualSchedule = scheduler.add({
    name: "manual prompt",
    enabled: false,
    trigger: { kind: ScheduleKind.At, at: new Date(nowMs + 60_000).toISOString() },
    payload: { kind: ScheduledPayloadKind.Prompt, prompt: "manual durable run" },
    cwd: dir,
    timeoutSeconds: 30,
  });
  const manualRun = await scheduler.run(manualSchedule.id);
  assert.equal(manualRun.status, ScheduleRunStatus.Running);
  assert.equal(manualRun.trigger, "manual");
  await flushWork();
  assert.equal(state.listRuns(manualSchedule.id)[0].status, ScheduleRunStatus.Completed);

  const shellMarker = join(dir, "implicit-shell-marker");
  const exactArgv = scheduler.add({
    name: "exact argv command",
    enabled: false,
    trigger: { kind: ScheduleKind.At, at: new Date(nowMs + 60_000).toISOString() },
    payload: {
      kind: ScheduledPayloadKind.Command,
      argv: [
        process.execPath,
        "-e",
        "process.stdout.write('x'.repeat(40000)); process.stdout.write(JSON.stringify(process.argv.slice(1)))",
        "argument with spaces",
        `$(touch ${shellMarker})`,
      ],
    },
    cwd: dir,
    timeoutSeconds: 30,
  });
  await scheduler.run(exactArgv.id);
  await waitForRunStatus(exactArgv.id, ScheduleRunStatus.Completed);
  const exactRun = state.listRuns(exactArgv.id)[0];
  assert.equal(existsSync(shellMarker), false, "command arguments are never interpreted by an implicit shell");
  assert.ok(Buffer.byteLength(exactRun.stdoutTail ?? "") <= OUTPUT_TAIL_BYTES);
  assert.ok(
    (exactRun.stdoutTail ?? "").endsWith(JSON.stringify(["argument with spaces", `$(touch ${shellMarker})`])),
    "the command receives the literal argument vector",
  );

  const processFile = join(dir, "process-group.json");
  const childReadyFile = join(dir, "process-group-child-ready");
  const childTerminatedFile = join(dir, "process-group-child-terminated");
  const resistantChild = [
    "const {writeFileSync}=require('node:fs')",
    `process.on('SIGTERM',()=>{writeFileSync(${JSON.stringify(childTerminatedFile)},'terminated');process.exit(0)})`,
    `writeFileSync(${JSON.stringify(childReadyFile)},'ready')`,
    "setInterval(()=>{},1000)",
  ].join(";");
  const resistantParent = [
    "const {spawn}=require('node:child_process')",
    "const {writeFileSync}=require('node:fs')",
    "process.stdout.write('process group ready')",
    "process.on('SIGTERM',()=>{})",
    `const child=spawn(process.execPath,['-e',${JSON.stringify(resistantChild)}],{stdio:'ignore'})`,
    `writeFileSync(${JSON.stringify(processFile)},JSON.stringify({parent:process.pid,child:child.pid}))`,
    "setInterval(()=>{},1000)",
  ].join(";");
  const timedCommand = scheduler.add({
    name: "timed process group",
    enabled: false,
    trigger: { kind: ScheduleKind.At, at: new Date(nowMs + 60_000).toISOString() },
    payload: { kind: ScheduledPayloadKind.Command, argv: [process.execPath, "-e", resistantParent] },
    cwd: dir,
    timeoutSeconds: 1,
  });
  await scheduler.run(timedCommand.id);
  await Promise.all([waitForFile(processFile), waitForFile(childReadyFile)]);
  const pids = JSON.parse(readFileSync(processFile, "utf8")) as { parent: number; child: number };
  await timer.advanceBy(1_000);
  assert.equal(state.listRuns(timedCommand.id)[0].status, ScheduleRunStatus.Running);
  assert.equal(processExists(pids.parent), true);
  await flushWork();
  await timer.advanceBy(1_000);
  await waitForRunStatus(timedCommand.id, ScheduleRunStatus.Failed);
  assert.match(state.listRuns(timedCommand.id)[0].error ?? "", /timed out/i);
  assert.equal(state.listRuns(timedCommand.id)[0].stdoutTail, "process group ready");
  assert.equal(existsSync(childTerminatedFile), true, "timeout signals the command's child process group");
  assert.equal(processExists(pids.parent), false, "the process group leader exits before completion is recorded");

  const shutdownGate = createGate("drain on shutdown");
  const draining = scheduler.add({
    name: "shutdown drain",
    enabled: false,
    trigger: { kind: ScheduleKind.At, at: new Date(nowMs + 60_000).toISOString() },
    payload: { kind: ScheduledPayloadKind.Prompt, prompt: "drain on shutdown" },
    cwd: dir,
    timeoutSeconds: 30,
  });
  await scheduler.run(draining.id);
  await flushWork();
  let stopResolved = false;
  const stopping = scheduler.stop().then(() => { stopResolved = true; });
  await flushWork();
  assert.equal(scheduler.status().lifecycle, SchedulerLifecycle.Stopping);
  assert.equal(stopResolved, false, "drain shutdown waits for active ownership");
  shutdownGate.release();
  await stopping;
  assert.equal(state.listRuns(draining.id)[0].status, ScheduleRunStatus.Completed);
  assert.equal(scheduler.status().lifecycle, SchedulerLifecycle.Stopped);

  const cancelState = new State(join(dir, "cancel.db"), {
    now: () => new Date(nowMs).toISOString(),
    id: () => `cancel-id-${++id}`,
  });
  let cancelledSignal: AbortSignal | undefined;
  const cancelScheduler = new Scheduler(cancelState, {
    now: () => nowMs,
    timer: new ManualTimer(),
    shutdownPolicy: SchedulerShutdownPolicy.Cancel,
    promptRunner: async (request) => {
      cancelledSignal = request.signal;
      await new Promise<void>((resolve) => request.signal.addEventListener("abort", () => resolve(), { once: true }));
      throw request.signal.reason;
    },
  });
  const cancelled = cancelScheduler.add({
    name: "cancel on shutdown",
    enabled: false,
    trigger: { kind: ScheduleKind.At, at: new Date(nowMs + 60_000).toISOString() },
    payload: { kind: ScheduledPayloadKind.Prompt, prompt: "wait for cancellation" },
    cwd: dir,
    timeoutSeconds: 30,
  });
  await cancelScheduler.run(cancelled.id);
  await flushWork();
  await cancelScheduler.stop();
  assert.equal(cancelledSignal?.aborted, true, "cancel shutdown aborts injected prompt work");
  assert.equal(cancelState.listRuns(cancelled.id)[0].status, ScheduleRunStatus.Interrupted);
  cancelState.close();

  process.stdout.write("ok — scheduler facade and execution policy\n");
} finally {
  for (const gate of gates.values()) gate.release();
  await timer.advanceBy(60_000);
  await timer.advanceBy(1_000);
  await scheduler.stop();
  state.close();
  rmSync(dir, { recursive: true, force: true });
}
