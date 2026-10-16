import { readFileSync } from "node:fs";
import {
  harnessPaths,
  type DaemonHealth,
  type DaemonInfo,
  type DaemonReady,
  type DatabaseQueryRequest,
  type DatabaseQueryResponse,
  type DocsCatalogEntry,
  type DocsDocument,
  type DocsQueryResult,
  type GatewayApi,
  type GatewayEvent,
  type Note,
  type NoteCreateInput,
  type ScheduleCreateInput,
  type ScheduleDefinition,
  type ScheduleRun,
} from "@pi-template/contracts";

export interface GatewayClient extends GatewayApi {
  listDocs(): Promise<DocsCatalogEntry[]>;
  readDocs(id: string): Promise<DocsDocument>;
  queryDocs(question: string): Promise<DocsQueryResult>;
  doctor(): Promise<unknown>;
}

export class GatewayRequestError extends Error {
  constructor(readonly status: number, readonly body: unknown, path: string) {
    const detail = body && typeof body === "object" && "error" in body
      ? JSON.stringify((body as { error: unknown }).error)
      : `HTTP ${status}`;
    super(`Gateway ${path}: ${detail}`);
    this.name = "GatewayRequestError";
  }
}

export type GatewayProbe =
  | { kind: "absent" }
  | { kind: "reachable"; info: DaemonInfo; health: DaemonHealth; ready: DaemonReady }
  | { kind: "unreachable"; info: DaemonInfo; cause: unknown };

function readDaemonInfo(): DaemonInfo | null {
  try {
    const info = JSON.parse(readFileSync(harnessPaths().daemonInfo, "utf8")) as DaemonInfo | null;
    const valid = info && Number.isSafeInteger(info.pid) && info.pid > 0 &&
      Number.isInteger(info.port) && info.port > 0 && info.port <= 65_535;
    return valid ? info : null;
  } catch {
    return null;
  }
}

interface GatewayJsonOptions {
  init?: RequestInit;
  acceptStatuses?: readonly number[];
  signal?: AbortSignal;
}

async function gatewayJson<T>(
  info: DaemonInfo,
  path: string,
  options: GatewayJsonOptions = {},
): Promise<T> {
  const headers = new Headers(options.init?.headers);
  headers.set("authorization", `Bearer ${info.authToken}`);
  const response = await fetch(`http://127.0.0.1:${info.port}${path}`, {
    ...options.init,
    headers,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok && !options.acceptStatuses?.includes(response.status)) {
    let body: unknown;
    try { body = await response.json(); } catch { body = undefined; }
    throw new GatewayRequestError(response.status, body, path);
  }
  return await response.json() as T;
}

export interface GatewayProbeOptions {
  signal?: AbortSignal;
}

export async function probeGateway(options: GatewayProbeOptions = {}): Promise<GatewayProbe> {
  const info = readDaemonInfo();
  if (!info) return { kind: "absent" };
  try {
    if (!info.authToken) throw new Error("daemon discovery has no authentication token");
    const health = await gatewayJson<DaemonHealth>(info, "/health", { signal: options.signal });
    const ready = await gatewayJson<DaemonReady>(info, "/ready", { acceptStatuses: [503], signal: options.signal });
    if (health.pid !== info.pid || health.fingerprint !== info.fingerprint) {
      throw new Error("Gateway identity does not match daemon discovery");
    }
    return { kind: "reachable", info, health, ready };
  } catch (cause) {
    return { kind: "unreachable", info, cause };
  }
}

/** Connect to an authenticated live daemon, including one with setup still required. */
export async function connectGateway(options: GatewayProbeOptions = {}): Promise<GatewayClient | null> {
  const probe = await probeGateway(options);
  if (probe.kind !== "reachable") return null;
  const { info } = probe;
  const json = <T>(path: string, init?: RequestInit): Promise<T> => gatewayJson<T>(info, path, { init });
  const send = <T>(method: "POST" | "PUT", path: string, body: unknown): Promise<T> => json<T>(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const remove = async (path: string): Promise<void> => {
    await json(path, { method: "DELETE" });
  };
  const subscriptions = new Set<() => void>();

  return {
    health: () => json<DaemonHealth>("/health"),
    ready: () => gatewayJson<DaemonReady>(info, "/ready", { acceptStatuses: [503] }),
    listNotes: () => json<Note[]>("/notes"),
    createNote: (input: NoteCreateInput) => send<Note>("POST", "/notes", input),
    deleteNote: (id: string) => remove(`/notes/${encodeURIComponent(id)}`),
    listSchedules: () => json<ScheduleDefinition[]>("/schedules"),
    createSchedule: (input: ScheduleCreateInput) => send<ScheduleDefinition>("POST", "/schedules", input),
    updateSchedule: (id: string, input: ScheduleCreateInput) =>
      send<ScheduleDefinition>("PUT", `/schedules/${encodeURIComponent(id)}`, input),
    deleteSchedule: (id: string) => remove(`/schedules/${encodeURIComponent(id)}`),
    runSchedule: (id: string) => send<ScheduleRun>("POST", `/schedules/${encodeURIComponent(id)}/run`, {}),
    queryDatabase: (request: DatabaseQueryRequest) =>
      send<DatabaseQueryResponse>("POST", "/query-database", request),
    listDocs: () => json<DocsCatalogEntry[]>("/docs"),
    readDocs: (id: string) => json<DocsDocument>(`/docs/${encodeURIComponent(id)}`),
    queryDocs: (question: string) => send<DocsQueryResult>("POST", "/docs/query", { question }),
    doctor: () => json<unknown>("/doctor"),
    subscribe(listener) {
      const controller = new AbortController();
      const stop = (): void => {
        controller.abort();
        subscriptions.delete(stop);
      };
      subscriptions.add(stop);

      void (async () => {
        try {
          const response = await fetch(`http://127.0.0.1:${info.port}/events`, {
            headers: { authorization: `Bearer ${info.authToken}` },
            signal: controller.signal,
          });
          if (!response.ok) throw new Error(`Gateway /events: ${response.status}`);
          const reader = response.body?.getReader();
          if (!reader) throw new Error("Gateway event stream has no body");
          const decoder = new TextDecoder();
          let buffer = "";
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
            let boundary = buffer.indexOf("\n\n");
            while (boundary !== -1) {
              const frame = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              for (const line of frame.split("\n")) {
                if (!line.startsWith("data: ")) continue;
                try { listener(JSON.parse(line.slice(6)) as GatewayEvent); } catch { /* malformed frame */ }
              }
              boundary = buffer.indexOf("\n\n");
            }
          }
        } catch {
          // Closing the client aborts the event stream.
        }
      })();
      return stop;
    },
    close() {
      for (const stop of subscriptions) stop();
    },
  };
}
