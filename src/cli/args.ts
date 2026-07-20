import { readFileSync } from "node:fs";
import {
  ScheduleKind,
  ScheduledPayloadKind,
  isOnboardingComplete,
  type OnboardingMarker,
  type ScheduledPayload,
} from "@pi-template/contracts";

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

type ScheduleAddTrigger =
  | { kind: ScheduleKind.At; at: string }
  | { kind: ScheduleKind.Every; everyMs: number }
  | { kind: ScheduleKind.Cron; expression: string; timeZone: string };

export type CliCommand =
  | { kind: "entry" }
  | { kind: "help" }
  | { kind: "daemon" }
  | { kind: "onboard"; argv: string[] }
  | { kind: "status" }
  | { kind: "doctor" }
  | { kind: "docs-list" }
  | { kind: "docs-read"; id: string }
  | { kind: "docs-query"; question: string }
  | { kind: "notes-add"; body: string }
  | { kind: "notes-list" }
  | { kind: "notes-remove"; id: string }
  | { kind: "schedule-add"; name?: string; trigger: ScheduleAddTrigger; payload: ScheduledPayload; timeoutSeconds: number }
  | { kind: "schedule-list" }
  | { kind: "schedule-remove"; id: string }
  | { kind: "schedule-run"; id: string };

export type BareInvocation = "interactive" | "onboard" | "setup-required" | "status";

export function resolveBareInvocation(options: { markerPath: string; isTTY: boolean }): BareInvocation {
  let marker: OnboardingMarker | undefined;
  try {
    marker = JSON.parse(readFileSync(options.markerPath, "utf8")) as OnboardingMarker;
  } catch {
    marker = undefined;
  }
  if (isOnboardingComplete(marker)) return options.isTTY ? "interactive" : "status";
  return options.isTTY ? "onboard" : "setup-required";
}

function required(value: string | undefined, description: string): string {
  if (!value?.trim()) throw new CliUsageError(`${description} is required`);
  return value;
}

function durationMs(value: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(value.trim());
  if (!match) throw new CliUsageError(`invalid duration: ${value}`);
  const unit = (match[2] ?? "ms") as "ms" | "s" | "m" | "h" | "d";
  const multiplier = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
  const result = Number(match[1]) * multiplier;
  if (!Number.isSafeInteger(result) || result < 1) throw new CliUsageError(`invalid duration: ${value}`);
  return result;
}

function positiveInteger(value: string, description: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new CliUsageError(`${description} must be a positive integer`);
  return parsed;
}

function parseScheduleAdd(argv: readonly string[]): Extract<CliCommand, { kind: "schedule-add" }> {
  const values = new Map<string, string>();
  let commandArgv: string[] = [];
  const known = new Set(["--name", "--at", "--every", "--cron", "--tz", "--prompt", "--timeout"]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") {
      commandArgv = argv.slice(index + 1);
      break;
    }
    if (!known.has(argument)) throw new CliUsageError(`unknown schedule add option: ${argument}`);
    const value = argv[++index];
    if (value === undefined || value === "--") throw new CliUsageError(`${argument} needs a value`);
    if (values.has(argument)) throw new CliUsageError(`${argument} may be provided only once`);
    values.set(argument, value);
  }

  const triggerFlags = ["--at", "--every", "--cron"].filter((flag) => values.has(flag));
  if (triggerFlags.length !== 1) throw new CliUsageError("schedule add needs exactly one of --at, --every, or --cron");
  let trigger: ScheduleAddTrigger;
  if (values.has("--at")) {
    trigger = { kind: ScheduleKind.At, at: values.get("--at")! };
  } else if (values.has("--every")) {
    trigger = { kind: ScheduleKind.Every, everyMs: durationMs(values.get("--every")!) };
  } else {
    trigger = {
      kind: ScheduleKind.Cron,
      expression: values.get("--cron")!,
      timeZone: required(values.get("--tz"), "--tz for a cron schedule"),
    };
  }

  const prompt = values.get("--prompt");
  if ((prompt === undefined) === (commandArgv.length === 0)) {
    throw new CliUsageError("schedule add needs one payload: --prompt <text> or -- <argv...>");
  }
  const payload: ScheduledPayload = prompt !== undefined
    ? { kind: ScheduledPayloadKind.Prompt, prompt: required(prompt, "--prompt") }
    : {
        kind: ScheduledPayloadKind.Command,
        argv: commandArgv as [string, ...string[]],
      };
  return {
    kind: "schedule-add",
    name: values.get("--name"),
    trigger,
    payload,
    timeoutSeconds: values.has("--timeout")
      ? positiveInteger(values.get("--timeout")!, "--timeout")
      : 600,
  };
}

export function parseCliArgs(argv: readonly string[]): CliCommand {
  if (argv.length === 0) return { kind: "entry" };
  if (argv.includes("--help") || argv.includes("-h")) return { kind: "help" };
  const [command, action, ...rest] = argv;
  if (command === "daemon" && action === undefined) return { kind: "daemon" };
  if (command === "onboard") return { kind: "onboard", argv: argv.slice(1) };
  if (command === "status" && action === undefined) return { kind: "status" };
  if (command === "doctor" && action === undefined) return { kind: "doctor" };

  if (command === "docs" && action === "list" && rest.length === 0) return { kind: "docs-list" };
  if (command === "docs" && action === "read") return { kind: "docs-read", id: required(rest[0], "document id") };
  if (command === "docs" && action === "query") {
    return { kind: "docs-query", question: required(rest.join(" "), "documentation question") };
  }

  if (command === "notes" && action === "list" && rest.length === 0) return { kind: "notes-list" };
  if (command === "notes" && action === "add") return { kind: "notes-add", body: required(rest.join(" "), "note body") };
  if (command === "notes" && action === "remove") return { kind: "notes-remove", id: required(rest[0], "note id") };

  if (command === "schedule" && action === "list" && rest.length === 0) return { kind: "schedule-list" };
  if (command === "schedule" && action === "add") return parseScheduleAdd(rest);
  if (command === "schedule" && action === "remove") return { kind: "schedule-remove", id: required(rest[0], "schedule id") };
  if (command === "schedule" && action === "run") return { kind: "schedule-run", id: required(rest[0], "schedule id") };

  throw new CliUsageError(`unknown command: ${argv.join(" ")}`);
}
