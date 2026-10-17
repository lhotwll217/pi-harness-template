import type { ScheduleRunStatus } from "./scheduling";

export enum DomainEventKind {
  NoteChanged = "note.changed",
  ScheduleChanged = "schedule.changed",
  ScheduleRunChanged = "schedule-run.changed",
  ChatChanged = "chat.changed",
  WorkspaceChanged = "workspace.changed",
}

export type DomainEvent =
  | { kind: DomainEventKind.NoteChanged; noteId: string }
  | { kind: DomainEventKind.ScheduleChanged; scheduleId: string }
  | { kind: DomainEventKind.ScheduleRunChanged; scheduleId: string; runId: string; status: ScheduleRunStatus }
  | { kind: DomainEventKind.ChatChanged; chatId: string }
  | { kind: DomainEventKind.WorkspaceChanged };

export enum GatewayEventKind {
  NotesChanged = "notes.changed",
  ScheduleChanged = "schedule.changed",
  ScheduleRunChanged = "schedule-run.changed",
  ChatChanged = "chat.changed",
  WorkspaceChanged = "workspace.changed",
}

/** External events invalidate a projection; clients always refetch durable truth. */
export type GatewayEvent =
  | { kind: GatewayEventKind.NotesChanged }
  | { kind: GatewayEventKind.ScheduleChanged }
  | { kind: GatewayEventKind.ScheduleRunChanged }
  | { kind: GatewayEventKind.ChatChanged; chatId: string }
  | { kind: GatewayEventKind.WorkspaceChanged };
