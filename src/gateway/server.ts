import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  DEFAULT_DAEMON_PORT,
  DatabaseQueryAction,
  type DaemonHealth,
  type DaemonReady,
  type DocsCatalogEntry,
  type DocsDocument,
  type DocsLookupError,
  type DocsQueryResult,
  type GatewayEvent,
  type Note,
  type NoteCreateInput,
  type ScheduleCreateInput,
  type ScheduleDefinition,
  type ScheduleRun,
} from "@pi-template/contracts";

type MaybePromise<T> = T | Promise<T>;

export interface GatewayNotes {
  list(): MaybePromise<Note[]>;
  create(input: NoteCreateInput): MaybePromise<Note>;
  delete(id: string): MaybePromise<boolean>;
}

export interface GatewaySchedules {
  list(): MaybePromise<ScheduleDefinition[]>;
  create(input: ScheduleCreateInput): MaybePromise<ScheduleDefinition>;
  update(id: string, input: ScheduleCreateInput): MaybePromise<ScheduleDefinition>;
  delete(id: string): MaybePromise<boolean>;
  run(id: string): Promise<ScheduleRun>;
}

export interface GatewayQueryService {
  listTables(): unknown;
  describeTable(table: string): unknown;
  runQuery(sql: string): unknown;
}

export interface GatewayDocs {
  list(): MaybePromise<DocsCatalogEntry[]>;
  read(id: string): MaybePromise<DocsDocument | DocsLookupError>;
  query(question: string): MaybePromise<DocsQueryResult>;
}

export interface GatewayEvents {
  subscribe(listener: (event: GatewayEvent) => void): () => void;
}

export interface GatewayDiagnostics {
  doctor(): MaybePromise<unknown>;
}

export interface GatewayOptions {
  authToken: string;
  health: () => DaemonHealth;
  ready: () => DaemonReady;
  notes: GatewayNotes;
  schedules: GatewaySchedules;
  query: GatewayQueryService;
  docs: GatewayDocs;
  events: GatewayEvents;
  diagnostics: GatewayDiagnostics;
  port?: number;
}

export interface RunningGateway {
  host: "127.0.0.1";
  port: number;
  close(): Promise<void>;
}

const SETUP_REQUIRED = {
  error: {
    code: "setup_required",
    message: "Onboarding is incomplete; run `pi-template onboard`.",
  },
} as const;

async function readBody(request: IncomingMessage): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      raw += chunk;
      if (raw.length > 1_000_000) reject(new Error("request body too large"));
    });
    request.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error("invalid JSON")); }
    });
    request.on("error", reject);
  });
}

function hasValidAuthorization(header: string | undefined, authToken: string): boolean {
  const digest = (value: string): Buffer => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(header ?? ""), digest(`Bearer ${authToken}`));
}

function listenPort(override: number | undefined): number {
  if (override !== undefined) return override;
  if (process.env.PI_TEMPLATE_PORT === undefined) return DEFAULT_DAEMON_PORT;
  const raw = process.env.PI_TEMPLATE_PORT.trim();
  if (!raw) throw new Error("PI_TEMPLATE_PORT must not be blank");
  const configured = Number(raw);
  if (!Number.isInteger(configured) || configured < 0 || configured > 65_535) {
    throw new Error("PI_TEMPLATE_PORT must be an integer from 0 through 65535");
  }
  return configured;
}

function routeId(pathname: string, family: string): string | undefined {
  const match = new RegExp(`^/${family}/([^/]+)$`).exec(pathname);
  if (!match) return undefined;
  try { return decodeURIComponent(match[1]); } catch { return undefined; }
}

function isLookupError(value: DocsDocument | DocsLookupError): value is DocsLookupError {
  return "code" in value;
}

/** Loopback transport only: behavior is supplied through injected module interfaces. */
export async function startGateway(options: GatewayOptions): Promise<RunningGateway> {
  const streams = new Set<ServerResponse>();
  const unsubscribe = options.events.subscribe((event) => {
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const stream of streams) stream.write(frame);
  });

  const server: Server = createServer(async (request, response) => {
    const respond = (status: number, body: unknown): void => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };

    try {
      if (!hasValidAuthorization(request.headers.authorization, options.authToken)) {
        response.setHeader("www-authenticate", "Bearer");
        return respond(401, { error: "unauthorized" });
      }

      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const route = `${request.method} ${url.pathname}`;
      if (route === "GET /health") return respond(200, options.health());
      if (route === "GET /ready") {
        const readiness = options.ready();
        return respond(readiness.ready ? 200 : 503, readiness);
      }
      if (route === "GET /events") {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        response.write(":ready\n\n");
        streams.add(response);
        request.on("close", () => streams.delete(response));
        return;
      }
      if (route === "GET /doctor") return respond(200, await options.diagnostics.doctor());

      if (route === "GET /docs") return respond(200, await options.docs.list());
      if (route === "POST /docs/query") {
        const body = await readBody(request) as { question?: unknown };
        if (typeof body.question !== "string" || !body.question.trim()) {
          return respond(400, { error: "question must be a non-empty string" });
        }
        return respond(200, await options.docs.query(body.question));
      }
      const docsId = routeId(url.pathname, "docs");
      if (request.method === "GET" && docsId !== undefined) {
        const document = await options.docs.read(docsId);
        return isLookupError(document) ? respond(404, document) : respond(200, document);
      }

      const gatedRoute = url.pathname === "/notes" || url.pathname.startsWith("/notes/") ||
        url.pathname === "/schedules" || url.pathname.startsWith("/schedules/") ||
        url.pathname === "/query-database";
      if (gatedRoute && options.ready().setupRequired) return respond(428, SETUP_REQUIRED);

      if (route === "GET /notes") return respond(200, await options.notes.list());
      if (route === "POST /notes") {
        const body = await readBody(request) as { body?: unknown };
        if (typeof body.body !== "string" || !body.body.trim()) {
          return respond(400, { error: "body must be a non-empty string" });
        }
        return respond(201, await options.notes.create({ body: body.body }));
      }
      const noteId = routeId(url.pathname, "notes");
      if (request.method === "DELETE" && noteId !== undefined) {
        const deleted = await options.notes.delete(noteId);
        return deleted ? respond(200, { ok: true }) : respond(404, { error: "no such note" });
      }

      if (route === "GET /schedules") return respond(200, await options.schedules.list());
      if (route === "POST /schedules") {
        return respond(201, await options.schedules.create(await readBody(request) as ScheduleCreateInput));
      }
      const runMatch = /^\/schedules\/([^/]+)\/run$/.exec(url.pathname);
      if (request.method === "POST" && runMatch) {
        return respond(202, await options.schedules.run(decodeURIComponent(runMatch[1])));
      }
      const scheduleId = routeId(url.pathname, "schedules");
      if (request.method === "PUT" && scheduleId !== undefined) {
        return respond(200, await options.schedules.update(
          scheduleId,
          await readBody(request) as ScheduleCreateInput,
        ));
      }
      if (request.method === "DELETE" && scheduleId !== undefined) {
        const deleted = await options.schedules.delete(scheduleId);
        return deleted ? respond(200, { ok: true }) : respond(404, { error: "no such schedule" });
      }

      if (route === "POST /query-database") {
        const query = await readBody(request) as Record<string, unknown>;
        if (query.action === DatabaseQueryAction.ListTables) return respond(200, options.query.listTables());
        if (query.action === DatabaseQueryAction.DescribeTable && typeof query.table === "string") {
          return respond(200, options.query.describeTable(query.table));
        }
        if (query.action === DatabaseQueryAction.Query && typeof query.sql === "string") {
          return respond(200, options.query.runQuery(query.sql));
        }
        return respond(400, { error: "invalid database query request" });
      }

      return respond(404, { error: "unknown route" });
    } catch (error) {
      return respond(400, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  let port: number;
  try {
    port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(listenPort(options.port), "127.0.0.1", () => {
        const address = server.address();
        resolve(typeof address === "object" && address ? address.port : 0);
      });
    });
  } catch (error) {
    unsubscribe();
    throw error;
  }

  return {
    host: "127.0.0.1",
    port,
    async close() {
      unsubscribe();
      for (const stream of streams) stream.end();
      streams.clear();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}
