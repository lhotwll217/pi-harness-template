import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ScheduleRunStatus,
  ScheduleRunTrigger,
  harnessPaths,
  type Note,
  type ScheduleDefinition,
  type ScheduleRun,
  type ScheduleTriggerContext,
  type ScheduledPayload,
  type ScheduleTrigger,
} from "@pi-template/contracts";

export const LATEST_SCHEMA_VERSION = 1;

interface Migration {
  version: number;
  sql: string;
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE schedules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('at', 'every', 'cron')),
  trigger_json TEXT NOT NULL,
  payload_kind TEXT NOT NULL CHECK (payload_kind IN ('prompt', 'command')),
  payload_json TEXT NOT NULL,
  cwd TEXT NOT NULL,
  timeout_seconds INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  next_run_at TEXT,
  deleted_at TEXT
);

CREATE INDEX idx_schedules_due
  ON schedules(enabled, next_run_at) WHERE deleted_at IS NULL;

CREATE TABLE schedule_runs (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL REFERENCES schedules(id),
  trigger TEXT NOT NULL CHECK (trigger IN ('scheduled', 'manual')),
  trigger_context_json TEXT,
  payload_snapshot_json TEXT NOT NULL,
  cwd TEXT NOT NULL,
  timeout_seconds INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'interrupted')),
  created_at TEXT NOT NULL,
  scheduled_for TEXT,
  started_at TEXT,
  finished_at TEXT,
  exit_code INTEGER,
  stdout_tail TEXT,
  stderr_tail TEXT,
  error TEXT,
  transcript_id TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 1 CHECK (attempt_count = 1)
);

CREATE INDEX idx_schedule_runs_schedule_created
  ON schedule_runs(schedule_id, created_at DESC);
`,
  },
];

export function defaultDbPath(): string {
  return harnessPaths().stateDb;
}

export interface StateDatabaseOptions {
  now?: () => string;
}

export interface RunTerminalOutcome {
  status: ScheduleRunStatus.Completed | ScheduleRunStatus.Failed | ScheduleRunStatus.Interrupted;
  exitCode: number | null;
  stdoutTail: string | null;
  stderrTail: string | null;
  error: string | null;
  transcriptId: string | null;
}

interface ScheduleRow extends Record<string, unknown> {
  id: string;
  name: string;
  enabled: number;
  triggerJson: string;
  payloadJson: string;
  cwd: string;
  timeoutSeconds: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
  nextRunAt: string | null;
}

function scheduleFromRow(row: ScheduleRow): ScheduleDefinition {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled !== 0,
    trigger: JSON.parse(row.triggerJson) as ScheduleTrigger,
    payload: JSON.parse(row.payloadJson) as ScheduledPayload,
    cwd: row.cwd,
    timeoutSeconds: row.timeoutSeconds,
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    nextRunAt: row.nextRunAt,
  };
}

/** SQLite adapter used only by State; callers import the curated State seam instead. */
export class StateDatabase {
  private readonly db: DatabaseSync;
  private readonly now: () => string;

  constructor(dbPath: string = defaultDbPath(), options: StateDatabaseOptions = {}) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.now = options.now ?? (() => new Date().toISOString());
    this.db = new DatabaseSync(dbPath);
    try {
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA foreign_keys = ON");
      this.db.exec("PRAGMA busy_timeout = 5000");
      this.applyMigrations();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private applyMigrations(): void {
    this.inTransaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL
        )
      `);
    });

    const applied = (this.db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{
      version: number;
    }>).map(({ version }) => version);
    const known = new Set(MIGRATIONS.map(({ version }) => version));
    const unknown = applied.find((version) => !known.has(version));
    if (unknown !== undefined) {
      const relationship = unknown > LATEST_SCHEMA_VERSION ? "newer" : "unknown";
      throw new Error(
        `state database has ${relationship} schema version ${unknown}; this build supports through ${LATEST_SCHEMA_VERSION}`,
      );
    }

    for (let index = 0; index < applied.length; index += 1) {
      if (applied[index] !== MIGRATIONS[index]?.version) {
        throw new Error(`state database migration history is not a known ordered prefix: ${applied.join(", ")}`);
      }
    }

    const appliedSet = new Set(applied);
    for (const migration of MIGRATIONS) {
      if (appliedSet.has(migration.version)) continue;
      this.inTransaction(() => {
        this.db.exec(migration.sql);
        this.db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
          .run(migration.version, this.now());
      });
    }
  }

  private inTransaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the operation error if SQLite already ended the transaction.
      }
      throw error;
    }
  }

  createNote(note: Note): Note {
    return this.inTransaction(() => {
      this.db.prepare("INSERT INTO notes (id, body, created_at, updated_at) VALUES (?, ?, ?, ?)")
        .run(note.id, note.body, note.createdAt, note.updatedAt);
      return note;
    });
  }

  listNotes(): Note[] {
    const rows = this.db.prepare(
      `SELECT id, body, created_at AS createdAt, updated_at AS updatedAt
       FROM notes ORDER BY created_at DESC, rowid DESC`,
    ).all() as unknown as Note[];
    return rows.map((row) => ({ ...row }));
  }

  deleteNote(id: string): boolean {
    return this.inTransaction(
      () => Number(this.db.prepare("DELETE FROM notes WHERE id = ?").run(id).changes) > 0,
    );
  }

  createSchedule(schedule: ScheduleDefinition): ScheduleDefinition {
    return this.inTransaction(() => {
      this.db.prepare(
        `INSERT INTO schedules (
           id, name, enabled, trigger_kind, trigger_json, payload_kind, payload_json,
           cwd, timeout_seconds, revision, created_at, updated_at, next_run_at, deleted_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      ).run(
        schedule.id,
        schedule.name,
        schedule.enabled ? 1 : 0,
        schedule.trigger.kind,
        JSON.stringify(schedule.trigger),
        schedule.payload.kind,
        JSON.stringify(schedule.payload),
        schedule.cwd,
        schedule.timeoutSeconds,
        schedule.revision,
        schedule.createdAt,
        schedule.updatedAt,
        schedule.nextRunAt,
      );
      return schedule;
    });
  }

  updateSchedule(schedule: ScheduleDefinition, expectedRevision: number): ScheduleDefinition | undefined {
    return this.inTransaction(() => {
      const changed = Number(this.db.prepare(
        `UPDATE schedules SET name = ?, enabled = ?, trigger_kind = ?, trigger_json = ?,
           payload_kind = ?, payload_json = ?, cwd = ?, timeout_seconds = ?, revision = ?,
           updated_at = ?, next_run_at = ?
         WHERE id = ? AND deleted_at IS NULL AND revision = ?`,
      ).run(
        schedule.name,
        schedule.enabled ? 1 : 0,
        schedule.trigger.kind,
        JSON.stringify(schedule.trigger),
        schedule.payload.kind,
        JSON.stringify(schedule.payload),
        schedule.cwd,
        schedule.timeoutSeconds,
        schedule.revision,
        schedule.updatedAt,
        schedule.nextRunAt,
        schedule.id,
        expectedRevision,
      ).changes);
      return changed > 0 ? schedule : undefined;
    });
  }

  listSchedules(): ScheduleDefinition[] {
    const rows = this.db.prepare(
      `${this.scheduleProjection()} WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE, id`,
    ).all() as unknown as ScheduleRow[];
    return rows.map(scheduleFromRow);
  }

  scheduleById(id: string): ScheduleDefinition | undefined {
    const row = this.db.prepare(
      `${this.scheduleProjection()} WHERE id = ? AND deleted_at IS NULL`,
    ).get(id) as unknown as ScheduleRow | undefined;
    return row ? scheduleFromRow(row) : undefined;
  }

  listDueSchedules(nowIso: string): ScheduleDefinition[] {
    const rows = this.db.prepare(
      `${this.scheduleProjection()}
       WHERE deleted_at IS NULL AND enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
       ORDER BY next_run_at, id`,
    ).all(nowIso) as unknown as ScheduleRow[];
    return rows.map(scheduleFromRow);
  }

  deleteSchedule(id: string): boolean {
    return this.inTransaction(() => Number(this.db.prepare(
      `UPDATE schedules SET enabled = 0, revision = revision + 1, updated_at = ?, deleted_at = ?
       WHERE id = ? AND deleted_at IS NULL`,
    ).run(this.now(), this.now(), id).changes) > 0);
  }

  claimScheduledRun(params: {
    id: string;
    schedule: ScheduleDefinition;
    scheduledFor: string;
    nextRunAt: string | null;
    enabled: boolean;
    triggerContext: ScheduleTriggerContext;
  }): ScheduleRun | undefined {
    return this.inTransaction(() => {
      const changed = Number(this.db.prepare(
        `UPDATE schedules SET next_run_at = ?, enabled = ?, revision = revision + 1, updated_at = ?
         WHERE id = ? AND deleted_at IS NULL AND enabled = 1 AND revision = ? AND next_run_at = ?`,
      ).run(
        params.nextRunAt,
        params.enabled ? 1 : 0,
        this.now(),
        params.schedule.id,
        params.schedule.revision,
        params.scheduledFor,
      ).changes);
      if (changed === 0) return undefined;
      return this.insertRun({
        id: params.id,
        schedule: params.schedule,
        trigger: ScheduleRunTrigger.Scheduled,
        scheduledFor: params.scheduledFor,
        triggerContext: params.triggerContext,
        createdAt: this.now(),
      });
    });
  }

  createRun(params: {
    id: string;
    schedule: ScheduleDefinition;
    trigger: ScheduleRunTrigger;
    scheduledFor: string | null;
    triggerContext?: ScheduleTriggerContext;
  }): ScheduleRun {
    return this.inTransaction(() => this.insertRun({ ...params, createdAt: this.now() }));
  }

  private insertRun(params: {
    id: string;
    schedule: ScheduleDefinition;
    trigger: ScheduleRunTrigger;
    scheduledFor: string | null;
    triggerContext?: ScheduleTriggerContext;
    createdAt: string;
  }): ScheduleRun {
    this.db.prepare(
      `INSERT INTO schedule_runs (
         id, schedule_id, trigger, trigger_context_json, payload_snapshot_json,
         cwd, timeout_seconds, status, created_at, scheduled_for, started_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      params.id,
      params.schedule.id,
      params.trigger,
      params.triggerContext === undefined ? null : JSON.stringify(params.triggerContext),
      JSON.stringify(params.schedule.payload),
      params.schedule.cwd,
      params.schedule.timeoutSeconds,
      ScheduleRunStatus.Running,
      params.createdAt,
      params.scheduledFor,
      params.createdAt,
    );
    return this.runById(params.id)!;
  }

  finishRun(id: string, outcome: RunTerminalOutcome): ScheduleRun | undefined {
    return this.inTransaction(() => {
      const changed = Number(this.db.prepare(
        `UPDATE schedule_runs SET status = ?, finished_at = ?, exit_code = ?, stdout_tail = ?,
           stderr_tail = ?, error = ?, transcript_id = ?
         WHERE id = ? AND status = ?`,
      ).run(
        outcome.status,
        this.now(),
        outcome.exitCode,
        outcome.stdoutTail,
        outcome.stderrTail,
        outcome.error,
        outcome.transcriptId,
        id,
        ScheduleRunStatus.Running,
      ).changes);
      return changed > 0 ? this.runById(id) : undefined;
    });
  }

  interruptRunningRuns(reason: string): ScheduleRun[] {
    return this.inTransaction(() => {
      const ids = this.db.prepare(
        "SELECT id FROM schedule_runs WHERE status = ? ORDER BY created_at, rowid",
      ).all(ScheduleRunStatus.Running) as Array<{ id: string }>;
      if (ids.length === 0) return [];
      this.db.prepare(
        "UPDATE schedule_runs SET status = ?, finished_at = ?, error = ? WHERE status = ?",
      ).run(ScheduleRunStatus.Interrupted, this.now(), reason, ScheduleRunStatus.Running);
      return ids.flatMap(({ id }) => this.runById(id) ?? []);
    });
  }

  listRuns(scheduleId?: string): ScheduleRun[] {
    const sql = `${this.runProjection()} ${scheduleId ? "WHERE schedule_id = ?" : ""}
                 ORDER BY created_at DESC, rowid DESC`;
    const rows = (scheduleId ? this.db.prepare(sql).all(scheduleId) : this.db.prepare(sql).all()) as unknown as ScheduleRun[];
    return rows.map((row) => ({ ...row }));
  }

  private runById(id: string): ScheduleRun | undefined {
    const row = this.db.prepare(`${this.runProjection()} WHERE id = ?`).get(id) as unknown as ScheduleRun | undefined;
    return row ? { ...row } : undefined;
  }

  private runProjection(): string {
    return `SELECT id, schedule_id AS scheduleId, trigger, status,
                   scheduled_for AS scheduledFor, started_at AS startedAt,
                   finished_at AS finishedAt, exit_code AS exitCode,
                   stdout_tail AS stdoutTail, stderr_tail AS stderrTail,
                   error, transcript_id AS transcriptId, attempt_count AS attemptCount
            FROM schedule_runs`;
  }

  private scheduleProjection(): string {
    return `SELECT id, name, enabled, trigger_json AS triggerJson, payload_json AS payloadJson,
                   cwd, timeout_seconds AS timeoutSeconds, revision, created_at AS createdAt,
                   updated_at AS updatedAt, next_run_at AS nextRunAt
            FROM schedules`;
  }

  close(): void {
    this.db.close();
  }
}
