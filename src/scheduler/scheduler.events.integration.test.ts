import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DomainEventKind,
  ScheduleKind,
  ScheduledPayloadKind,
  ScheduleRunStatus,
  type DomainEvent,
} from "@pi-template/contracts";
import { InMemoryEventBus, State } from "../state";
import { Scheduler, type SchedulerTimer, type SchedulerTimerHandle } from "./scheduler";

class DormantTimer implements SchedulerTimer {
  set(_delayMs: number, _callback: () => void): SchedulerTimerHandle {
    return { cancel: () => undefined };
  }
}

const dir = mkdtempSync(join(tmpdir(), "pi-template-scheduler-events-"));
const bus = new InMemoryEventBus();
const events: DomainEvent[] = [];
const visibleSchedules: string[][] = [];
const visibleRunStatuses: ScheduleRunStatus[][] = [];
let releasePrompt = (): void => undefined;
const promptReleased = new Promise<void>((resolve) => { releasePrompt = resolve; });
const state = new State(join(dir, "state.db"), { bus });
const scheduler = new Scheduler(state, {
  timer: new DormantTimer(),
  promptRunner: async () => {
    await promptReleased;
    return { exitCode: 0, stdout: "observed", stderr: "" };
  },
});

bus.subscribe((event) => {
  events.push(event);
  if (event.kind === DomainEventKind.ScheduleChanged) {
    visibleSchedules.push(state.listSchedules().map((schedule) => schedule.id));
  }
  if (event.kind === DomainEventKind.ScheduleRunChanged) {
    visibleRunStatuses.push(state.listRuns(event.scheduleId).map((run) => run.status));
  }
});

const flushEvents = async (): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
};

try {
  const schedule = scheduler.add({
    name: "evented prompt",
    enabled: false,
    trigger: { kind: ScheduleKind.At, at: "2026-07-17T10:00:00.000Z" },
    payload: { kind: ScheduledPayloadKind.Prompt, prompt: "publish after commit" },
    cwd: dir,
    timeoutSeconds: 30,
  });
  await flushEvents();
  assert.ok(
    events.some((event) => event.kind === DomainEventKind.ScheduleChanged && event.scheduleId === schedule.id),
  );
  assert.deepEqual(visibleSchedules, [[schedule.id]], "schedule events observe the committed projection");

  const run = await scheduler.run(schedule.id);
  await flushEvents();
  assert.ok(
    events.some(
      (event) => event.kind === DomainEventKind.ScheduleRunChanged
        && event.runId === run.id
        && event.status === ScheduleRunStatus.Running,
    ),
  );
  assert.deepEqual(visibleRunStatuses, [[ScheduleRunStatus.Running]]);

  releasePrompt();
  await flushEvents();
  assert.ok(
    events.some(
      (event) => event.kind === DomainEventKind.ScheduleRunChanged
        && event.runId === run.id
        && event.status === ScheduleRunStatus.Completed,
    ),
  );
  assert.deepEqual(visibleRunStatuses.at(-1), [ScheduleRunStatus.Completed]);

  process.stdout.write("ok — scheduler events observe committed state\n");
} finally {
  releasePrompt();
  await scheduler.stop();
  state.close();
  rmSync(dir, { recursive: true, force: true });
}
