import { Cron } from "croner";
import { ScheduleKind, type ScheduleTrigger } from "@pi-template/contracts";

type CronTrigger = Extract<ScheduleTrigger, { kind: ScheduleKind.Cron }>;

/** Return the next occurrence strictly after `nowMs`. */
export function computeNextRunAt(trigger: ScheduleTrigger, nowMs: number): string | null {
  if (!Number.isFinite(nowMs)) throw new Error("invalid scheduler clock value");

  if (trigger.kind === ScheduleKind.At) {
    const atMs = Date.parse(trigger.at);
    if (!Number.isFinite(atMs)) throw new Error("invalid at schedule: expected an ISO timestamp");
    return atMs > nowMs ? new Date(atMs).toISOString() : null;
  }

  if (trigger.kind === ScheduleKind.Every) {
    validateEvery(trigger.everyMs, trigger.anchorMs);
    if (nowMs < trigger.anchorMs) return new Date(trigger.anchorMs).toISOString();
    const steps = Math.floor((nowMs - trigger.anchorMs) / trigger.everyMs) + 1;
    return new Date(trigger.anchorMs + steps * trigger.everyMs).toISOString();
  }

  return withCron(trigger, (cron) => {
    const next = cron.nextRun(new Date(nowMs));
    return next?.toISOString() ?? null;
  });
}

/** Count recurring occurrences after the stored due occurrence through `nowMs`. */
export function countMissedOccurrences(
  trigger: ScheduleTrigger,
  scheduledMs: number,
  nowMs: number,
): number {
  if (!Number.isFinite(scheduledMs) || !Number.isFinite(nowMs)) {
    throw new Error("invalid occurrence time");
  }
  if (nowMs <= scheduledMs || trigger.kind === ScheduleKind.At) return 0;

  if (trigger.kind === ScheduleKind.Every) {
    validateEvery(trigger.everyMs, trigger.anchorMs);
    return Math.floor((nowMs - scheduledMs) / trigger.everyMs);
  }

  return withCron(trigger, (cron) => {
    let cursor = new Date(scheduledMs);
    let missed = 0;
    for (;;) {
      const next = cron.nextRun(cursor);
      if (!next || next.getTime() > nowMs) return missed;
      missed += 1;
      cursor = next;
    }
  });
}

function withCron<T>(trigger: CronTrigger, operation: (cron: Cron) => T): T {
  try {
    return operation(new Cron(trigger.expression, { timezone: trigger.timeZone, catch: false }));
  } catch (error) {
    throw new Error(`invalid cron schedule: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function validateEvery(everyMs: number, anchorMs: number): void {
  if (!Number.isSafeInteger(everyMs) || everyMs < 1_000) {
    throw new Error("invalid every schedule: everyMs must be an integer of at least 1000");
  }
  if (!Number.isSafeInteger(anchorMs) || anchorMs < 0) {
    throw new Error("invalid every schedule: anchorMs must be a non-negative integer");
  }
}
