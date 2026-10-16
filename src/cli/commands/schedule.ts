import type { Command } from "commander";
import {
  DatabaseQueryAction,
  ScheduleKind,
  ScheduleRunStatus,
  ScheduledPayloadKind,
  type ScheduleCreateInput,
} from "@pi-template/contracts";
import type { GatewayClient } from "../../gateway/client";
import { parseScheduleAdd, type ScheduleAddOptions } from "../args";
import { emit, noun, verb, withGateway } from "./command";

const delay = async (milliseconds: number): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
};

async function completedRun(client: GatewayClient, runId: string): Promise<Record<string, unknown>> {
  const escaped = runId.replaceAll("'", "''");
  const deadline = Date.now() + 660_000;
  for (;;) {
    const result = await client.queryDatabase({
      action: DatabaseQueryAction.Query,
      sql: `SELECT id, schedule_id, status, started_at, finished_at, exit_code, stdout_tail, stderr_tail, error, transcript_id FROM schedule_runs WHERE id = '${escaped}'`,
    }) as { rows?: Record<string, unknown>[] };
    const row = result.rows?.[0];
    if (row && row.status !== ScheduleRunStatus.Running) return row;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for schedule run ${runId}`);
    await delay(25);
  }
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

  verb(schedule, "add [argv...]", "create a schedule that runs a prompt, or the exact command after --", {
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
    .option("--at <iso>", "run once at this ISO-8601 time")
    .option("--every <duration>", "run on an interval: 90s, 15m, 1h, 1d")
    .option("--cron <expr>", "run on a cron expression (needs --tz)")
    .option("--tz <zone>", "IANA time zone for --cron, e.g. Europe/Helsinki")
    .option("--name <name>", "display name")
    .option("--prompt <text>", "prompt for an isolated agent turn")
    .option("--timeout <seconds>", "seconds before the run is stopped (default 600)");

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
    await emit(await completedRun(client, accepted.id));
    return 0;
  }));
}
