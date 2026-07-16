import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { spawn } from "node:child_process";
import {
  AgentToolId,
  ScheduleKind,
  ScheduleRunTrigger,
  ScheduledPayloadKind,
  type ScheduleCreateInput,
  type ScheduleDefinition,
  type ScheduleExecutionResult,
  type ScheduleRun,
  type ScheduleTriggerContext,
  type ScheduledPromptRunRequest,
} from "@pi-template/contracts";
import { OUTPUT_TAIL_BYTES, type State } from "../state";
import { computeNextRunAt, countMissedOccurrences } from "./schedule";

export const DEFAULT_SCHEDULER_CONCURRENCY = 1;
export const DEFAULT_MISSED_RUN_POLICY = "skip" as const;
export const DEFAULT_WAKE_INTERVAL_MS = 1_000;
export const COMMAND_TERMINATION_GRACE_MS = 1_000;

export interface SchedulerTimerHandle {
  cancel(): void;
}

/** Timer seam shared by scheduler wakeups, run timeouts, and command escalation. */
export interface SchedulerTimer {
  set(delayMs: number, callback: () => void): SchedulerTimerHandle;
}

export enum SchedulerShutdownPolicy {
  Drain = "drain",
  Cancel = "cancel",
}

export enum SchedulerLifecycle {
  Idle = "idle",
  Running = "running",
  Stopping = "stopping",
  Stopped = "stopped",
}

export interface SchedulerStatus {
  lifecycle: SchedulerLifecycle;
  activeRuns: number;
  queuedRuns: number;
  concurrency: number;
  missedRunPolicy: typeof DEFAULT_MISSED_RUN_POLICY;
}

export interface CommandExecutionRequest {
  argv: readonly [string, ...string[]];
  cwd: string;
  signal: AbortSignal;
}

export type CommandRunner = (request: CommandExecutionRequest) => Promise<ScheduleExecutionResult>;
export type PromptRunner = (request: ScheduledPromptRunRequest) => Promise<ScheduleExecutionResult>;

export interface SchedulerQueue<T> {
  readonly size: number;
  enqueue(item: T): void;
  dequeue(): T | undefined;
  drain(): T[];
}

export type SchedulerQueueFactory = <T>() => SchedulerQueue<T>;

export interface SchedulerOptions {
  now?: () => number;
  timer?: SchedulerTimer;
  wakeIntervalMs?: number;
  concurrency?: number;
  shutdownPolicy?: SchedulerShutdownPolicy;
  commandRunner?: CommandRunner;
  promptRunner?: PromptRunner;
  queueFactory?: SchedulerQueueFactory;
  onError?: (error: unknown) => void;
}

export interface SchedulerService {
  start(): void;
  stop(): Promise<void>;
  status(): SchedulerStatus;
  list(): ScheduleDefinition[];
  add(input: ScheduleCreateInput): ScheduleDefinition;
  update(id: string, input: ScheduleCreateInput, expectedRevision: number): ScheduleDefinition;
  remove(id: string): boolean;
  run(id: string): Promise<ScheduleRun>;
}

class SystemTimer implements SchedulerTimer {
  set(delayMs: number, callback: () => void): SchedulerTimerHandle {
    const handle = setTimeout(callback, delayMs);
    handle.unref?.();
    return { cancel: () => clearTimeout(handle) };
  }
}

class FifoSchedulerQueue<T> implements SchedulerQueue<T> {
  private readonly items: T[] = [];

  get size(): number {
    return this.items.length;
  }

  enqueue(item: T): void {
    this.items.push(item);
  }

  dequeue(): T | undefined {
    return this.items.shift();
  }

  drain(): T[] {
    return this.items.splice(0);
  }
}

const createFifoQueue: SchedulerQueueFactory = <T>() => new FifoSchedulerQueue<T>();

interface PendingExecution {
  schedule: ScheduleDefinition;
  run: ScheduleRun;
  triggerContext?: ScheduleTriggerContext;
}

function initialNextRunAt(input: ScheduleCreateInput, nowMs: number): string | null {
  if (!input.enabled) return null;
  if (input.trigger.kind === ScheduleKind.At) {
    return new Date(Date.parse(input.trigger.at)).toISOString();
  }
  return computeNextRunAt(input.trigger, nowMs);
}

/** Canonical scheduler facade. State owns durable truth; this service owns time and work. */
export class Scheduler implements SchedulerService {
  private readonly now: () => number;
  private readonly timer: SchedulerTimer;
  private readonly wakeIntervalMs: number;
  private readonly concurrency: number;
  private readonly shutdownPolicy: SchedulerShutdownPolicy;
  private readonly commandRunner: CommandRunner;
  private readonly promptRunner?: PromptRunner;
  private readonly onError: (error: unknown) => void;
  private readonly ownedScheduleIds = new Set<string>();
  private readonly pending: SchedulerQueue<PendingExecution>;
  private readonly active = new Map<string, AbortController>();
  private readonly ownershipWaiters = new Set<() => void>();
  private wakeHandle?: SchedulerTimerHandle;
  private scanning = false;
  private stopPromise?: Promise<void>;
  private lifecycle = SchedulerLifecycle.Idle;

  constructor(private readonly state: State, options: SchedulerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.timer = options.timer ?? new SystemTimer();
    this.wakeIntervalMs = options.wakeIntervalMs ?? DEFAULT_WAKE_INTERVAL_MS;
    this.concurrency = options.concurrency ?? DEFAULT_SCHEDULER_CONCURRENCY;
    this.shutdownPolicy = options.shutdownPolicy ?? SchedulerShutdownPolicy.Drain;
    this.commandRunner = options.commandRunner ?? ((request) => runCommand(request, this.timer));
    this.promptRunner = options.promptRunner;
    this.pending = (options.queueFactory ?? createFifoQueue)<PendingExecution>();
    this.onError = options.onError ?? (() => undefined);
    validatePositiveInteger("wakeIntervalMs", this.wakeIntervalMs);
    validatePositiveInteger("concurrency", this.concurrency);
  }

  start(): void {
    if (this.lifecycle === SchedulerLifecycle.Running) return;
    if (this.lifecycle !== SchedulerLifecycle.Idle) throw new Error("scheduler cannot be restarted after stop");
    this.lifecycle = SchedulerLifecycle.Running;
    this.requestWake(0);
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.stopOwnedWork();
    return this.stopPromise;
  }

  status(): SchedulerStatus {
    return {
      lifecycle: this.lifecycle,
      activeRuns: this.active.size,
      queuedRuns: this.pending.size,
      concurrency: this.concurrency,
      missedRunPolicy: DEFAULT_MISSED_RUN_POLICY,
    };
  }

  list(): ScheduleDefinition[] {
    return this.state.listSchedules();
  }

  add(input: ScheduleCreateInput): ScheduleDefinition {
    const normalized = this.validate(input);
    const schedule = this.state.createSchedule(normalized, initialNextRunAt(normalized, this.now()));
    this.requestWake(0);
    return schedule;
  }

  update(id: string, input: ScheduleCreateInput, expectedRevision: number): ScheduleDefinition {
    const normalized = this.validate(input);
    const schedule = this.state.updateSchedule(
      id,
      normalized,
      expectedRevision,
      initialNextRunAt(normalized, this.now()),
    );
    this.requestWake(0);
    return schedule;
  }

  remove(id: string): boolean {
    const removed = this.state.deleteSchedule(id);
    if (removed) this.requestWake(0);
    return removed;
  }

  async run(id: string): Promise<ScheduleRun> {
    if (this.lifecycle === SchedulerLifecycle.Stopping || this.lifecycle === SchedulerLifecycle.Stopped) {
      throw new Error("scheduler has been stopped");
    }
    const schedule = this.state.scheduleById(id);
    if (!schedule) throw new Error(`no such schedule: ${id}`);
    if (this.ownedScheduleIds.has(id)) throw new Error(`schedule already running: ${id}`);

    this.ownedScheduleIds.add(id);
    let run: ScheduleRun;
    try {
      run = this.state.createRun(schedule, ScheduleRunTrigger.Manual);
    } catch (error) {
      this.ownedScheduleIds.delete(id);
      throw error;
    }
    this.pending.enqueue({ schedule, run });
    this.pump();
    return run;
  }

  private async stopOwnedWork(): Promise<void> {
    if (this.lifecycle === SchedulerLifecycle.Stopped) return;
    this.lifecycle = SchedulerLifecycle.Stopping;
    this.wakeHandle?.cancel();
    this.wakeHandle = undefined;

    if (this.shutdownPolicy === SchedulerShutdownPolicy.Cancel) {
      const queued = this.pending.drain();
      for (const pending of queued) {
        this.state.markInterrupted(pending.run.id, "scheduler stopped before execution");
        this.ownedScheduleIds.delete(pending.schedule.id);
      }
      for (const active of this.active.values()) {
        active.abort(new Error("scheduler stopped"));
      }
    } else {
      this.pump();
    }

    await this.waitForOwnershipResolution();
    this.lifecycle = SchedulerLifecycle.Stopped;
  }

  private requestWake(delayMs: number): void {
    if (this.lifecycle !== SchedulerLifecycle.Running) return;
    this.wakeHandle?.cancel();
    this.wakeHandle = this.timer.set(delayMs, () => {
      this.wakeHandle = undefined;
      void this.scanDue()
        .catch(this.onError)
        .finally(() => this.requestWake(this.wakeIntervalMs));
    });
  }

  private async scanDue(): Promise<void> {
    if (this.lifecycle !== SchedulerLifecycle.Running || this.scanning) return;
    this.scanning = true;
    try {
      const nowMs = this.now();
      const due = this.state.listDueSchedules(new Date(nowMs).toISOString());
      for (const schedule of due) {
        if (this.lifecycle !== SchedulerLifecycle.Running || this.ownedScheduleIds.has(schedule.id)) continue;
        const scheduledFor = schedule.nextRunAt;
        if (!scheduledFor) continue;
        const scheduledMs = Date.parse(scheduledFor);
        const triggerContext: ScheduleTriggerContext = {
          scheduledFor,
          startedAfterMs: Math.max(0, nowMs - scheduledMs),
          missedOccurrences: countMissedOccurrences(schedule.trigger, scheduledMs, nowMs),
        };
        const nextRunAt = computeNextRunAt(schedule.trigger, nowMs);
        const remainsEnabled = schedule.trigger.kind !== ScheduleKind.At && schedule.enabled;
        const run = this.state.claimScheduledRun(
          schedule,
          scheduledFor,
          nextRunAt,
          remainsEnabled,
          triggerContext,
        );
        if (!run) continue;
        this.ownedScheduleIds.add(schedule.id);
        this.pending.enqueue({ schedule, run, triggerContext });
      }
      this.pump();
    } finally {
      this.scanning = false;
    }
  }

  private pump(): void {
    const mayDispatch = this.lifecycle !== SchedulerLifecycle.Stopped &&
      (this.lifecycle !== SchedulerLifecycle.Stopping || this.shutdownPolicy === SchedulerShutdownPolicy.Drain);
    if (!mayDispatch) return;

    while (this.active.size < this.concurrency && this.pending.size > 0) {
      const pending = this.pending.dequeue()!;
      const controller = new AbortController();
      void this.execute(pending, controller)
        .catch(this.onError)
        .finally(() => {
          this.active.delete(pending.run.id);
          this.ownedScheduleIds.delete(pending.schedule.id);
          this.pump();
          this.resolveOwnershipWaitersIfIdle();
          if (this.lifecycle === SchedulerLifecycle.Running) this.requestWake(0);
        });
      this.active.set(pending.run.id, controller);
    }
    this.resolveOwnershipWaitersIfIdle();
  }

  private async execute(pending: PendingExecution, controller: AbortController): Promise<void> {
    const { schedule, run, triggerContext } = pending;
    let timedOut = false;
    const timeout = this.timer.set(schedule.timeoutSeconds * 1_000, () => {
      timedOut = true;
      controller.abort(new Error("schedule timed out"));
    });

    try {
      if (!existsSync(schedule.cwd)) throw new Error(`schedule cwd no longer exists: ${schedule.cwd}`);
      const result = schedule.payload.kind === ScheduledPayloadKind.Command
        ? await this.commandRunner({ argv: schedule.payload.argv, cwd: schedule.cwd, signal: controller.signal })
        : await this.runPrompt(schedule, run.id, controller.signal, triggerContext);
      if (timedOut || controller.signal.aborted) {
        const error = controller.signal.reason instanceof Error
          ? controller.signal.reason.message
          : String(controller.signal.reason ?? (timedOut ? "schedule timed out" : "schedule aborted"));
        if (
          this.lifecycle === SchedulerLifecycle.Stopping &&
          this.shutdownPolicy === SchedulerShutdownPolicy.Cancel
        ) {
          this.state.markInterrupted(run.id, error);
        } else {
          this.state.failRun(run.id, {
            error,
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
            transcriptId: result.transcriptId,
          });
        }
        return;
      }
      if (result.exitCode === 0) {
        this.state.completeRun(run.id, result);
      } else {
        this.state.failRun(run.id, {
          error: `execution exited ${result.exitCode}`,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          transcriptId: result.transcriptId,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        controller.signal.aborted &&
        this.lifecycle === SchedulerLifecycle.Stopping &&
        this.shutdownPolicy === SchedulerShutdownPolicy.Cancel
      ) {
        this.state.markInterrupted(run.id, message);
      } else {
        this.state.failRun(run.id, message);
      }
    } finally {
      timeout.cancel();
    }
  }

  private runPrompt(
    schedule: ScheduleDefinition,
    runId: string,
    signal: AbortSignal,
    triggerContext?: ScheduleTriggerContext,
  ): Promise<ScheduleExecutionResult> {
    if (schedule.payload.kind !== ScheduledPayloadKind.Prompt) {
      throw new Error("scheduled payload is not a prompt");
    }
    if (!this.promptRunner) throw new Error("scheduled prompt runner is not configured");
    return this.promptRunner({
      payload: schedule.payload,
      cwd: schedule.cwd,
      schedule,
      runId,
      signal,
      triggerContext,
    });
  }

  private waitForOwnershipResolution(): Promise<void> {
    if (this.active.size === 0 && this.pending.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.ownershipWaiters.add(resolve));
  }

  private resolveOwnershipWaitersIfIdle(): void {
    if (this.active.size > 0 || this.pending.size > 0) return;
    for (const resolve of this.ownershipWaiters) resolve();
    this.ownershipWaiters.clear();
  }

  private validate(input: ScheduleCreateInput): ScheduleCreateInput {
    const name = input.name.trim();
    if (!name) throw new Error("schedule name is required");
    if (!isAbsolute(input.cwd)) throw new Error("schedule cwd must be an absolute path");
    validatePositiveInteger("timeoutSeconds", input.timeoutSeconds);

    if (input.trigger.kind === ScheduleKind.At && !Number.isFinite(Date.parse(input.trigger.at))) {
      throw new Error("invalid at schedule");
    }
    computeNextRunAt(input.trigger, this.now());

    if (input.payload.kind === ScheduledPayloadKind.Command) {
      if (
        input.payload.argv.length === 0 ||
        input.payload.argv.some((part) => typeof part !== "string") ||
        !input.payload.argv[0]
      ) {
        throw new Error("command argv must contain string arguments and an executable");
      }
    } else if (input.payload.kind === ScheduledPayloadKind.Prompt) {
      if (!input.payload.prompt.trim()) throw new Error("scheduled prompt is required");
      const knownTools = new Set<string>(Object.values(AgentToolId));
      if (input.payload.toolsAllow?.some((tool) => !knownTools.has(tool))) {
        throw new Error("scheduled prompt contains an unknown tool id");
      }
      return {
        ...input,
        name,
        payload: { ...input.payload, toolsAllow: input.payload.toolsAllow ?? [] },
      };
    } else {
      throw new Error("invalid scheduled payload kind");
    }

    return { ...input, name };
  }
}

function validatePositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
}

function boundedAppend(previous: string, chunk: unknown): string {
  const combined = Buffer.concat([Buffer.from(previous), Buffer.from(String(chunk))]);
  if (combined.length <= OUTPUT_TAIL_BYTES) return combined.toString();
  return combined.subarray(combined.length - OUTPUT_TAIL_BYTES).toString();
}

async function runCommand(
  { argv, cwd, signal }: CommandExecutionRequest,
  timer: SchedulerTimer,
): Promise<ScheduleExecutionResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      detached: true,
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let escalation: SchedulerTimerHandle | undefined;
    child.stdout.on("data", (chunk) => { stdout = boundedAppend(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = boundedAppend(stderr, chunk); });
    child.once("error", reject);
    child.once("close", (code, killedBy) => {
      escalation?.cancel();
      resolve({ exitCode: code ?? (killedBy ? 1 : 0), stdout, stderr });
    });

    const terminate = (signalName: NodeJS.Signals): void => {
      if (!child.pid) return;
      try {
        if (process.platform === "win32") child.kill(signalName);
        else process.kill(-child.pid, signalName);
      } catch {
        try {
          child.kill(signalName);
        } catch {
          // The process already exited between observation and termination.
        }
      }
    };
    const abort = (): void => {
      terminate("SIGTERM");
      escalation = timer.set(COMMAND_TERMINATION_GRACE_MS, () => terminate("SIGKILL"));
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    child.once("close", () => signal.removeEventListener("abort", abort));
  });
}
