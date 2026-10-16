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

export interface ScheduleAddRequest {
  name?: string;
  trigger: ScheduleAddTrigger;
  payload: ScheduledPayload;
  timeoutSeconds: number;
}

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

export type ScheduleAddOptions = Partial<Record<"name" | "at" | "every" | "cron" | "tz" | "prompt" | "timeout", string>>;

/** Validate `pi-template schedule add` flags and the exact argv after `--`. */
export function parseScheduleAdd(options: ScheduleAddOptions, commandArgv: readonly string[]): ScheduleAddRequest {
  const values = new Map(Object.entries(options)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([name, value]) => [`--${name}`, value]));
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
        argv: [...commandArgv] as [string, ...string[]],
      };
  return {
    name: values.get("--name"),
    trigger,
    payload,
    timeoutSeconds: values.has("--timeout")
      ? positiveInteger(values.get("--timeout")!, "--timeout")
      : 600,
  };
}
