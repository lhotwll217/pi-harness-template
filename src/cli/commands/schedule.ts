import { Command, InvalidArgumentError } from "commander";
import {
  ScheduleKind,
  ScheduleRunStatus,
  ScheduledPayloadKind,
  type ScheduleCreateInput,
  type ScheduleRun,
} from "@pi-template/contracts";
import type { GatewayClient } from "../../gateway/client";
import { parseScheduleAdd, type ScheduleAddOptions } from "../args";
import { emit, noun, verb, withGateway } from "./command";

const delay = async (milliseconds: number): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
};

async function completedRun(client: GatewayClient, runId: string): Promise<ScheduleRun> {
  const deadline = Date.now() + 660_000;
  for (;;) {
    const run = await client.getScheduleRun(runId);
    if (run.status !== ScheduleRunStatus.Running) return run;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for schedule run ${runId}`);
    await delay(25);
  }
}

/** A finished run prints as its schedule_runs row, the shape `db query` shows. */
const runRow = (run: ScheduleRun) => ({
  id: run.id,
  schedule_id: run.scheduleId,
  status: run.status,
  started_at: run.startedAt,
  finished_at: run.finishedAt,
  exit_code: run.exitCode,
  stdout_tail: run.stdoutTail,
  stderr_tail: run.stderrTail,
  error: run.error,
  transcript_id: run.transcriptId,
});

const once = (flag: string) => (value: string, previous: string | undefined): string => {
  if (previous !== undefined) throw new InvalidArgumentError(`${flag} may be provided only once`);
  return value;
};

// Commander drops the `--` that ends the options, so the command after it is split off first:
// it stays exactly as typed, `-h` included, and any other word is refused.
function commandAfterDoubleDash(add: Command): void {
  add.parseOptions = (argv) => {
    const end = argv.indexOf("--");
    const parsed = Command.prototype.parseOptions.call(add, end === -1 ? argv : argv.slice(0, end));
    const [stray] = parsed.operands;
    if (stray !== undefined) add.error(`unexpected argument '${stray}'; put the command to run after --`);
    return { operands: end === -1 ? [] : argv.slice(end + 1), unknown: parsed.unknown };
  };
}

export function addSchedule(program: Command): void {
  const schedule = noun(program, "schedule", "durable schedules that run a prompt or an exact command", {
    useWhen: "the owner wants something done later or on a timer.",
    notFor: "a schedule's run history: pi-template db (schedule_runs).",
    next: "pi-template schedule list to see ids, pi-template schedule run <id> to try one now.",
    examples: ['pi-template schedule add --every 1d --prompt "summarize the notes kept today"', "pi-template schedule list"],
  });

  verb(schedule, "list", "every schedule with its trigger and next run", {
    examples: ["pi-template schedule list"],
  }, async () => await withGateway(async (client) => {
    await emit(await client.listSchedules());
    return 0;
  }));

  const add = verb(schedule, "add [argv...]", "create a schedule that runs a prompt, or the exact command after --", {
    rules: [
      "Exactly one trigger: --at, --every, or --cron with --tz.",
      "Exactly one payload: --prompt for an isolated agent turn, or the command after --, run as given without a shell.",
    ],
    examples: [
      'pi-template schedule add --every 1h --name "hourly check" --prompt "inspect state"',
      'pi-template schedule add --cron "0 9 * * *" --tz Europe/Helsinki -- node task.mjs',
      'pi-template schedule add --at 2026-10-01T09:00:00Z --prompt "remind me to review"',
    ],
  }, async ({ args: [argv], options }) => {
    const request = parseScheduleAdd(options as ScheduleAddOptions, (argv as string[] | undefined) ?? []);
    return await withGateway(async (client) => {
      const trigger: ScheduleCreateInput["trigger"] = request.trigger.kind === ScheduleKind.Every
        ? { ...request.trigger, anchorMs: Date.now() }
        : request.trigger;
      const payloadLabel = request.payload.kind === ScheduledPayloadKind.Prompt
        ? request.payload.prompt.slice(0, 40)
        : request.payload.argv.join(" ").slice(0, 40);
      await emit(await client.createSchedule({
        name: request.name?.trim() || `${payloadLabel || "schedule"} ${Date.now()}`,
        enabled: true,
        trigger,
        payload: request.payload,
        cwd: process.cwd(),
        timeoutSeconds: request.timeoutSeconds,
      }));
      return 0;
    });
  })
    .usage("(--at <iso> | --every <duration> | --cron <expr> --tz <zone>) (--prompt <text> | -- <argv...>)")
    .option("--at <iso>", "run once at this ISO-8601 time", once("--at"))
    .option("--every <duration>", "run on an interval: 90s, 15m, 1h, 1d", once("--every"))
    .option("--cron <expr>", "run on a cron expression (needs --tz)", once("--cron"))
    .option("--tz <zone>", "IANA time zone for --cron, e.g. Europe/Helsinki", once("--tz"))
    .option("--name <name>", "display name", once("--name"))
    .option("--prompt <text>", "prompt for an isolated agent turn", once("--prompt"))
    .option("--timeout <seconds>", "seconds before the run is stopped (default 600)", once("--timeout"));
  commandAfterDoubleDash(add);

  verb(schedule, "remove <id>", "delete a schedule", {
    examples: ["pi-template schedule remove <id from schedule list>"],
  }, async ({ args: [id] }) => await withGateway(async (client) => {
    await client.deleteSchedule(id as string);
    await emit({ ok: true });
    return 0;
  }));

  verb(schedule, "run <id>", "run a schedule now and wait for it to finish", {
    examples: ["pi-template schedule run <id from schedule list>"],
  }, async ({ args: [id] }) => await withGateway(async (client) => {
    const accepted = await client.runSchedule(id as string);
    await emit(runRow(await completedRun(client, accepted.id)));
    return 0;
  }));
}
