import type { GatewayEvent } from "./events";
import type { Note, NoteCreateInput } from "./notes";
import type { ScheduleCreateInput, ScheduleDefinition, ScheduleRun } from "./scheduling";

// Distinct from Owner Operator's 47711 so both daemons can coexist on one machine.
export const DEFAULT_DAEMON_PORT = 47811;

export interface DaemonInfo {
  port: number;
  pid: number;
  startedAt: string;
  fingerprint: string;
  authToken: string;
}

export interface DaemonHealth {
  ok: true;
  port: number;
  pid: number;
  startedAt: string;
  fingerprint: string;
  stale: boolean;
}

export interface DaemonReady {
  ready: boolean;
  setupRequired: boolean;
  modules: {
    state: boolean;
    scheduler: boolean;
    gateway: boolean;
  };
}

export enum DatabaseQueryAction {
  ListTables = "list_tables",
  DescribeTable = "describe_table",
  Query = "query",
}

export type DatabaseQueryRequest =
  | { action: DatabaseQueryAction.ListTables }
  | { action: DatabaseQueryAction.DescribeTable; table: string }
  | { action: DatabaseQueryAction.Query; sql: string };

export type DatabaseQueryResponse = unknown;

export interface GatewayApi {
  health(): Promise<DaemonHealth>;
  ready(): Promise<DaemonReady>;
  listNotes(): Promise<Note[]>;
  createNote(input: NoteCreateInput): Promise<Note>;
  deleteNote(id: string): Promise<void>;
  listSchedules(): Promise<ScheduleDefinition[]>;
  createSchedule(input: ScheduleCreateInput): Promise<ScheduleDefinition>;
  updateSchedule(id: string, input: ScheduleCreateInput): Promise<ScheduleDefinition>;
  deleteSchedule(id: string): Promise<void>;
  runSchedule(id: string): Promise<ScheduleRun>;
  queryDatabase(request: DatabaseQueryRequest): Promise<DatabaseQueryResponse>;
  subscribe(listener: (event: GatewayEvent) => void): () => void;
  close(): void;
}

export type { GatewayEvent } from "./events";
