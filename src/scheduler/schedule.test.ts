import assert from "node:assert/strict";
import { ScheduleKind, type ScheduleTrigger } from "@pi-template/contracts";
import { computeNextRunAt, countMissedOccurrences } from "./schedule";

const now = Date.parse("2026-07-16T10:00:00.000Z");

const at: ScheduleTrigger = { kind: ScheduleKind.At, at: "2026-07-16T10:05:00.000Z" };
assert.equal(computeNextRunAt(at, now), "2026-07-16T10:05:00.000Z");
assert.equal(computeNextRunAt(at, now + 300_000), null, "one-time triggers do not repeat");

const every: ScheduleTrigger = {
  kind: ScheduleKind.Every,
  everyMs: 60_000,
  anchorMs: now - 30_000,
};
assert.equal(computeNextRunAt(every, now), "2026-07-16T10:00:30.000Z");
assert.equal(
  computeNextRunAt(every, now + 10 * 60_000),
  "2026-07-16T10:10:30.000Z",
  "interval triggers retain their stable anchor while skipping old occurrences",
);
assert.equal(
  countMissedOccurrences(every, Date.parse("2026-07-16T10:00:30.000Z"), Date.parse("2026-07-16T10:03:45.000Z")),
  3,
);

const dailyHelsinki: ScheduleTrigger = {
  kind: ScheduleKind.Cron,
  expression: "0 9 * * *",
  timeZone: "Europe/Helsinki",
};
assert.equal(
  computeNextRunAt(dailyHelsinki, Date.parse("2026-03-28T07:00:00.000Z")),
  "2026-03-29T06:00:00.000Z",
  "the next local 09:00 follows Helsinki's spring-forward UTC offset",
);
assert.equal(
  computeNextRunAt(dailyHelsinki, Date.parse("2026-10-24T06:00:00.000Z")),
  "2026-10-25T07:00:00.000Z",
  "the next local 09:00 follows Helsinki's fall-back UTC offset",
);
assert.equal(
  countMissedOccurrences(
    { kind: ScheduleKind.Cron, expression: "0 * * * * *", timeZone: "UTC" },
    Date.parse("2026-07-16T10:00:00.000Z"),
    Date.parse("2026-07-16T10:03:30.000Z"),
  ),
  3,
  "cron downtime is counted without replaying its backlog",
);

assert.throws(
  () => computeNextRunAt({ kind: ScheduleKind.Cron, expression: "bad", timeZone: "UTC" }, now),
  /invalid cron/i,
);

process.stdout.write("ok — scheduler calendar math\n");
