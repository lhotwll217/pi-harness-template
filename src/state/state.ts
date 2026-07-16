import { randomUUID } from "node:crypto";
import {
  DomainEventKind,
  ScheduleRunStatus,
  type DomainEvent,
  type Note,
  type NoteCreateInput,
  type ScheduleCreateInput,
  type ScheduleDefinition,
  type ScheduleExecutionResult,
  type ScheduleRun,
  type ScheduleRunTrigger,
  type ScheduleTriggerContext,
} from "@pi-template/contracts";
import { StateDatabase, type RunTerminalOutcome } from "./database";
import { InMemoryEventBus } from "./event-bus";

export const OUTPUT_TAIL_BYTES = 32 * 1024;

export interface StateOptions {
  bus?: InMemoryEventBus;
  now?: () => string;
  id?: () => string;
}

export interface RunFailure {
  error: string;
  exitCode?: number | null;
  stdout?: string | null;
  stderr?: string | null;
  transcriptId?: string | null;
}

export class RevisionConflictError extends Error {
  constructor(id: string, expectedRevision: number) {
    super(`schedule ${id} has changed since revision ${expectedRevision}`);
    this.name = "RevisionConflictError";
  }
}

function boundedTail(value: string | null | undefined): string | null {
  if (value == null) return null;
  const bytes = Buffer.from(value);
  if (bytes.length <= OUTPUT_TAIL_BYTES) return value;
  return `[truncated to last ${OUTPUT_TAIL_BYTES} bytes]\n${bytes.subarray(bytes.length - OUTPUT_TAIL_BYTES).toString()}`;
}

/** The daemon's sole durable-state seam. All writes commit before events publish. */
export class State {
  readonly bus: InMemoryEventBus;
  private readonly db: StateDatabase;
  private readonly now: () => string;
  private readonly id: () => string;

  constructor(dbPath?: string, options: StateOptions = {}) {
    this.bus = options.bus ?? new InMemoryEventBus();
    this.now = options.now ?? (() => new Date().toISOString());
    this.id = options.id ?? randomUUID;
    this.db = new StateDatabase(dbPath, { now: this.now });

    const interrupted = this.db.interruptRunningRuns("interrupted during startup recovery from a previous process");
    for (const run of interrupted) this.publishRun(run);
  }

  createNote(input: NoteCreateInput): Note {
    const timestamp = this.now();
    const note = this.db.createNote({
      id: this.id(),
      body: input.body,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    this.publish({ kind: DomainEventKind.NoteChanged, noteId: note.id });
    return note;
  }

  listNotes(): Note[] {
    return this.db.listNotes();
  }

  deleteNote(id: string): boolean {
    const deleted = this.db.deleteNote(id);
    if (deleted) this.publish({ kind: DomainEventKind.NoteChanged, noteId: id });
    return deleted;
  }

  createSchedule(input: ScheduleCreateInput, nextRunAt: string | null = null): ScheduleDefinition {
    const timestamp = this.now();
    const schedule = this.db.createSchedule({
      id: this.id(),
      ...input,
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      nextRunAt,
    });
    this.publish({ kind: DomainEventKind.ScheduleChanged, scheduleId: schedule.id });
    return schedule;
  }

  updateSchedule(
    id: string,
    input: ScheduleCreateInput,
    expectedRevision: number,
    nextRunAt?: string | null,
  ): ScheduleDefinition {
    const existing = this.db.scheduleById(id);
    if (!existing || existing.revision !== expectedRevision) {
      throw new RevisionConflictError(id, expectedRevision);
    }
    const schedule: ScheduleDefinition = {
      id,
      ...input,
      revision: expectedRevision + 1,
      createdAt: existing.createdAt,
      updatedAt: this.now(),
      nextRunAt: nextRunAt === undefined ? existing.nextRunAt : nextRunAt,
    };
    const updated = this.db.updateSchedule(schedule, expectedRevision);
    if (!updated) throw new RevisionConflictError(id, expectedRevision);
    this.publish({ kind: DomainEventKind.ScheduleChanged, scheduleId: id });
    return updated;
  }

  listSchedules(): ScheduleDefinition[] {
    return this.db.listSchedules();
  }

  scheduleById(id: string): ScheduleDefinition | undefined {
    return this.db.scheduleById(id);
  }

  listDueSchedules(nowIso: string): ScheduleDefinition[] {
    return this.db.listDueSchedules(nowIso);
  }

  deleteSchedule(id: string): boolean {
    const deleted = this.db.deleteSchedule(id);
    if (deleted) this.publish({ kind: DomainEventKind.ScheduleChanged, scheduleId: id });
    return deleted;
  }

  /** Atomically advances a due schedule and creates its running record. */
  claimScheduledRun(
    schedule: ScheduleDefinition,
    scheduledFor: string,
    nextRunAt: string | null,
    enabled: boolean,
    triggerContext: ScheduleTriggerContext,
  ): ScheduleRun | undefined {
    const run = this.db.claimScheduledRun({
      id: this.id(),
      schedule,
      scheduledFor,
      nextRunAt,
      enabled,
      triggerContext,
    });
    if (!run) return undefined;
    this.publish({ kind: DomainEventKind.ScheduleChanged, scheduleId: schedule.id });
    this.publishRun(run);
    return run;
  }

  createRun(
    schedule: ScheduleDefinition,
    trigger: ScheduleRunTrigger,
    scheduledFor: string | null = null,
    triggerContext?: ScheduleTriggerContext,
  ): ScheduleRun {
    const run = this.db.createRun({ id: this.id(), schedule, trigger, scheduledFor, triggerContext });
    this.publishRun(run);
    return run;
  }

  completeRun(id: string, result: ScheduleExecutionResult): ScheduleRun {
    return this.finishRun(id, {
      status: ScheduleRunStatus.Completed,
      exitCode: result.exitCode,
      stdoutTail: boundedTail(result.stdout),
      stderrTail: boundedTail(result.stderr),
      error: null,
      transcriptId: result.transcriptId ?? null,
    });
  }

  failRun(id: string, failure: string | RunFailure): ScheduleRun {
    const detail: RunFailure = typeof failure === "string" ? { error: failure } : failure;
    return this.finishRun(id, {
      status: ScheduleRunStatus.Failed,
      exitCode: detail.exitCode ?? null,
      stdoutTail: boundedTail(detail.stdout),
      stderrTail: boundedTail(detail.stderr),
      error: detail.error,
      transcriptId: detail.transcriptId ?? null,
    });
  }

  markInterrupted(id: string, reason: string): ScheduleRun {
    return this.finishRun(id, {
      status: ScheduleRunStatus.Interrupted,
      exitCode: null,
      stdoutTail: null,
      stderrTail: null,
      error: reason,
      transcriptId: null,
    });
  }

  listRuns(scheduleId?: string): ScheduleRun[] {
    return this.db.listRuns(scheduleId);
  }

  close(): void {
    this.db.close();
  }

  private finishRun(id: string, outcome: RunTerminalOutcome): ScheduleRun {
    const run = this.db.finishRun(id, outcome);
    if (!run) throw new Error(`schedule run ${id} does not exist or is not running`);
    this.publishRun(run);
    return run;
  }

  private publishRun(run: ScheduleRun): void {
    this.publish({
      kind: DomainEventKind.ScheduleRunChanged,
      scheduleId: run.scheduleId,
      runId: run.id,
      status: run.status,
    });
  }

  private publish(event: DomainEvent): void {
    this.bus.publish(event);
  }
}
