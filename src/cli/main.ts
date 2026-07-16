import {
  DatabaseQueryAction,
  ScheduleKind,
  ScheduleRunStatus,
  type ScheduleCreateInput,
} from "@pi-template/contracts";
import { connectGateway, type GatewayClient } from "../gateway/client";
import { CliUsageError, parseCliArgs } from "./args";

const USAGE = `Pi Harness Template

  pi-template daemon
  pi-template onboard [--non-interactive <answer flags>]
  pi-template status
  pi-template docs list
  pi-template docs read <id>
  pi-template docs query <question>
  pi-template notes add <body>
  pi-template notes list
  pi-template notes remove <id>
  pi-template schedule add (--at <iso> | --every <duration> | --cron <expr> --tz <zone>)
                           [--name <name>] (--prompt <text> | -- <argv...>) [--timeout <seconds>]
  pi-template schedule list
  pi-template schedule remove <id>
  pi-template schedule run <id>
  pi-template doctor

Non-interactive onboarding requires --provider, --api-key or --auth-file, --model,
--permission, --service, and --acknowledge-resources. Sandbox roots default to cwd.`;

const output = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
};

async function requireGateway(): Promise<GatewayClient> {
  const client = await connectGateway();
  if (!client) {
    throw new Error("daemon is not running; start `pi-template daemon`");
  }
  return client;
}

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

async function run(): Promise<void> {
  const command = parseCliArgs(process.argv.slice(2));
  if (command.kind === "help") {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (command.kind === "daemon") {
    const { daemonMain } = await import("../daemon");
    await daemonMain();
    return;
  }
  if (command.kind === "onboard") {
    const { onboard } = await import("./onboard");
    output(await onboard(command.argv));
    return;
  }

  const client = await requireGateway();
  try {
    switch (command.kind) {
      case "status":
        output({ health: await client.health(), ready: await client.ready() });
        return;
      case "doctor": {
        const report = await client.doctor() as { ok?: boolean };
        output(report);
        if (report.ok !== true) process.exitCode = 1;
        return;
      }
      case "docs-list":
        output(await client.listDocs());
        return;
      case "docs-read":
        output(await client.readDocs(command.id));
        return;
      case "docs-query":
        output(await client.queryDocs(command.question));
        return;
      case "notes-add":
        output(await client.createNote({ body: command.body }));
        return;
      case "notes-list":
        output(await client.listNotes());
        return;
      case "notes-remove":
        await client.deleteNote(command.id);
        output({ ok: true });
        return;
      case "schedule-list":
        output(await client.listSchedules());
        return;
      case "schedule-remove":
        await client.deleteSchedule(command.id);
        output({ ok: true });
        return;
      case "schedule-add": {
        const trigger: ScheduleCreateInput["trigger"] = command.trigger.kind === ScheduleKind.Every
          ? { ...command.trigger, anchorMs: Date.now() }
          : command.trigger;
        const payloadLabel = command.payload.kind === "prompt"
          ? command.payload.prompt.slice(0, 40)
          : command.payload.argv.join(" ").slice(0, 40);
        output(await client.createSchedule({
          name: command.name?.trim() || `${payloadLabel || "schedule"} ${Date.now()}`,
          enabled: true,
          trigger,
          payload: command.payload,
          cwd: process.cwd(),
          timeoutSeconds: command.timeoutSeconds,
        }));
        return;
      }
      case "schedule-run": {
        const accepted = await client.runSchedule(command.id);
        output(await completedRun(client, accepted.id));
        return;
      }
    }
  } finally {
    client.close();
  }
}

try {
  await run();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`pi-template: ${message}\n`);
  if (error instanceof CliUsageError) {
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = 2;
  } else {
    process.exitCode = 1;
  }
}
