/** Git-tracked prompt surface served by listTables/describeTable. Keep with database.ts. */
export interface ColumnDoc {
  name: string;
  description: string;
}

export interface TableDoc {
  name: string;
  description: string;
  columns: readonly ColumnDoc[];
}

export const SCHEMA_DOCS: readonly TableDoc[] = [
  {
    name: "schema_migrations",
    description: "Ordered migration versions already committed to this durable database.",
    columns: [
      { name: "version", description: "Unique schema version applied in ascending order." },
      { name: "applied_at", description: "ISO time the migration transaction committed." },
    ],
  },
  {
    name: "notes",
    description: "Worked example records demonstrating the typed write, event, and read-only query path.",
    columns: [
      { name: "id", description: "Stable note id." },
      { name: "body", description: "Owner-authored note text." },
      { name: "created_at", description: "ISO creation time." },
      { name: "updated_at", description: "ISO last-update time." },
    ],
  },
  {
    name: "schedules",
    description: "Durable schedule definitions; active rows drive future prompt or exact-command runs.",
    columns: [
      { name: "id", description: "Stable schedule id." },
      { name: "name", description: "Unique human-readable schedule name." },
      { name: "enabled", description: "1 permits future triggers; 0 disables them." },
      { name: "trigger_kind", description: "at | every | cron discriminator." },
      { name: "trigger_json", description: "Typed trigger definition serialized as JSON." },
      { name: "payload_kind", description: "prompt | command discriminator." },
      { name: "payload_json", description: "Typed prompt or exact argument-vector payload serialized as JSON." },
      { name: "cwd", description: "Absolute working directory used by runs." },
      { name: "timeout_seconds", description: "Per-run timeout in seconds." },
      { name: "revision", description: "Monotonic optimistic-concurrency token." },
      { name: "created_at", description: "ISO creation time." },
      { name: "updated_at", description: "ISO last-mutation time." },
      { name: "next_run_at", description: "ISO next timer occurrence; NULL when none is scheduled." },
      { name: "deleted_at", description: "ISO soft-deletion time; NULL for active schedules." },
    ],
  },
  {
    name: "schedule_runs",
    description: "Durable execution history with immutable launch context and terminal outcome tails.",
    columns: [
      { name: "id", description: "Stable run id." },
      { name: "schedule_id", description: "References the originating schedule." },
      { name: "trigger", description: "scheduled | manual origin." },
      { name: "trigger_context_json", description: "Typed missed-occurrence timing context serialized as JSON." },
      { name: "payload_snapshot_json", description: "Immutable payload actually selected for this run." },
      { name: "cwd", description: "Immutable working directory selected for this run." },
      { name: "timeout_seconds", description: "Immutable timeout selected for this run." },
      { name: "status", description: "running | completed | failed | interrupted lifecycle state." },
      { name: "created_at", description: "ISO durable claim time used for history ordering." },
      { name: "scheduled_for", description: "ISO intended timer occurrence, when applicable." },
      { name: "started_at", description: "ISO execution start time." },
      { name: "finished_at", description: "ISO terminal time; NULL while running." },
      { name: "exit_code", description: "Process or prompt result code when available." },
      { name: "stdout_tail", description: "Bounded final standard-output bytes." },
      { name: "stderr_tail", description: "Bounded final standard-error bytes." },
      { name: "error", description: "Terminal failure or interruption explanation." },
      { name: "transcript_id", description: "Fresh Pi transcript id for a prompt run, when available." },
      { name: "attempt_count", description: "Execution attempt count; fixed at 1 in schema v1." },
    ],
  },
];

export function tableDoc(name: string): TableDoc | undefined {
  return SCHEMA_DOCS.find((table) => table.name === name);
}
