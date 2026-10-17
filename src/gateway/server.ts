import { createHash, timingSafeEqual } from "node:crypto";
import { chmodSync, lstatSync, rmSync, statSync, type Stats } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  DAEMON_PROBE_TIMEOUT_MS,
  DEFAULT_DAEMON_PORT,
  DatabaseQueryAction,
  GatewayRouteError,
  MAX_REQUEST_BODY_CHARS,
  MAX_WORKSPACE_FILE_CHARS,
  ScheduledPayloadKind,
  isChatId,
  type Chat,
  type ChatCancelResult,
  type ChatStreamEvent,
  type ChatSummary,
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
  type WorkspaceFile,
  type WorkspaceFileWrite,
  type WorkspaceFileWriteResult,
  type WorkspaceTree,
  withoutAbsolutePaths,
} from "@pi-template/contracts";

type MaybePromise<T> = T | Promise<T>;

export interface GatewayNotes {
  list(): MaybePromise<Note[]>;
  create(input: NoteCreateInput): MaybePromise<Note>;
  delete(id: string): MaybePromise<boolean>;
}

/** Throws to refuse; called on the stored schedule in the same step as the write, so no change slips between. */
export type ScheduleAuthorization = (current: ScheduleDefinition) => void;

export interface GatewaySchedules {
  list(): MaybePromise<ScheduleDefinition[]>;
  create(input: ScheduleCreateInput): MaybePromise<ScheduleDefinition>;
  update(id: string, input: ScheduleCreateInput, authorize?: ScheduleAuthorization): MaybePromise<ScheduleDefinition>;
  delete(id: string): MaybePromise<boolean>;
  run(id: string, authorize?: ScheduleAuthorization): Promise<ScheduleRun>;
  runById(id: string): MaybePromise<ScheduleRun | undefined>;
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

/** Refusals are thrown as GatewayRouteError; `send` throws them before the first event, so each gets its own status. */
export interface GatewayChats {
  list(): MaybePromise<ChatSummary[]>;
  get(id: string): MaybePromise<Chat>;
  send(id: string, text: string): Promise<AsyncIterable<ChatStreamEvent>>;
  cancel(id: string, turnId?: string): MaybePromise<ChatCancelResult>;
  rename(id: string, title: string): MaybePromise<ChatSummary>;
  delete(id: string): MaybePromise<void>;
}

export interface GatewayWorkspaceFiles {
  tree(): MaybePromise<WorkspaceTree>;
  read(path: string): MaybePromise<WorkspaceFile>;
  write(path: string, input: WorkspaceFileWrite): MaybePromise<WorkspaceFileWriteResult>;
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
  chats: GatewayChats;
  workspace: GatewayWorkspaceFiles;
  events: GatewayEvents;
  diagnostics: GatewayDiagnostics;
  port?: number;
  agentSocket?: string;
}

export interface RunningGateway {
  host: "127.0.0.1";
  port: number;
  agentSocketProblem?: string;
  close(): Promise<void>;
}

export type Caller = "owner" | "agent";

const AGENT_COMMAND_SCHEDULE_REFUSAL = {
  error: "agent callers cannot create, change, or run a command schedule",
  hint: "the owner runs pi-template schedule add -- <argv>",
} as const;

const isCommandPayload = (body: unknown): boolean =>
  (body as { payload?: { kind?: unknown } } | undefined)?.payload?.kind === ScheduledPayloadKind.Command;

class CommandScheduleRefused extends Error {}

const agentAuthorization = (caller: Caller): ScheduleAuthorization | undefined => caller === "agent"
  ? (current) => { if (isCommandPayload(current)) throw new CommandScheduleRefused(); }
  : undefined;

const SETUP_REQUIRED = {
  error: {
    code: "setup_required",
    message: "Onboarding is incomplete; run `pi-template onboard`.",
  },
} as const;

// JSON writes a control character as a six-character \u escape (RFC 8259 section 7), so a file
// at the size limit still fits; the rest holds the keys and the base revision.
const MAX_WORKSPACE_WRITE_BODY_CHARS = 6 * MAX_WORKSPACE_FILE_CHARS + 1_024;

async function readBody(request: IncomingMessage, limit = MAX_REQUEST_BODY_CHARS): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    let raw = "";
    let overflowed = false;
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      if (overflowed) return;
      raw += chunk;
      if (raw.length > limit) {
        overflowed = true;
        raw = "";
        reject(new GatewayRouteError(413, "too_large", `the request body is longer than ${limit} characters`));
      }
    });
    request.on("end", () => {
      if (overflowed) return;
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

function chatId(id: string): string {
  if (!isChatId(id)) throw new GatewayRouteError(400, "invalid_request", `${JSON.stringify(id)} is not a chat id; mint one with crypto.randomUUID()`);
  return id;
}

function isLookupError(value: DocsDocument | DocsLookupError): value is DocsLookupError {
  return "code" in value;
}

/** A caller on the agent socket is allowed, or refused with this 403 body. */
export type AgentPolicy = "allow" | { error: string; hint?: string; code?: string };

/**
 * Who may call a route. The owner (loopback TCP with the bearer token) may call every route;
 * `agent` decides for callers on the agent socket; a setup-gated route answers 428 until
 * onboarding completes. A route's handler still decides on the request body, as the command
 * schedule refusal does.
 */
export interface CallerPolicy {
  agent: AgentPolicy;
  setupGated: boolean;
}

const OPEN: CallerPolicy = { agent: "allow", setupGated: false };
const GATED: CallerPolicy = { agent: "allow", setupGated: true };
const OWNER_CHATS: CallerPolicy = {
  agent: { error: "agent callers cannot use chat routes", code: "owner_only" },
  setupGated: true,
};
const OWNER_FILES: CallerPolicy = {
  agent: { error: "agent callers cannot use workspace file routes; use your file tools", code: "owner_only" },
  setupGated: true,
};

interface RouteContext {
  caller: Caller;
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  params: string[];
  respond(status: number, body: unknown): void;
}

interface Route {
  method: string;
  path: RegExp;
  policy: CallerPolicy;
  handle(context: RouteContext): Promise<void> | void;
}

function route(method: string, pattern: string, policy: CallerPolicy, handle: Route["handle"]): Route {
  const source = pattern.split("/").map((segment) => segment.startsWith(":") ? "([^/]+)" : segment).join("/");
  return { method, path: new RegExp(`^${source}$`), policy, handle };
}

function routeParams(route: Route, pathname: string): string[] | undefined {
  const match = route.path.exec(pathname);
  if (!match) return undefined;
  try { return match.slice(1).map(decodeURIComponent); } catch { return undefined; }
}

/** Loopback and agent-socket transports: behavior is supplied through injected module interfaces. */
export async function startGateway(options: GatewayOptions): Promise<RunningGateway> {
  const streams = new Set<ServerResponse>();
  const unsubscribe = options.events.subscribe((event) => {
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const stream of streams) stream.write(frame);
  });

  const routes: Route[] = [
    route("GET", "/health", OPEN, ({ respond }) => respond(200, options.health())),
    route("GET", "/ready", OPEN, ({ respond }) => {
      const readiness = options.ready();
      respond(readiness.ready ? 200 : 503, readiness);
    }),
    route("GET", "/events", OPEN, ({ request, response }) => {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      response.write(":ready\n\n");
      streams.add(response);
      request.on("close", () => streams.delete(response));
    }),
    route("GET", "/doctor", OPEN, async ({ respond }) => respond(200, await options.diagnostics.doctor())),

    route("GET", "/docs", OPEN, async ({ respond }) => respond(200, await options.docs.list())),
    route("POST", "/docs/query", OPEN, async ({ request, respond }) => {
      const body = await readBody(request) as { question?: unknown };
      if (typeof body.question !== "string" || !body.question.trim()) {
        return respond(400, { error: "question must be a non-empty string" });
      }
      respond(200, await options.docs.query(body.question));
    }),
    route("GET", "/docs/:id", OPEN, async ({ params: [id], respond }) => {
      const document = await options.docs.read(id!);
      respond(isLookupError(document) ? 404 : 200, document);
    }),

    route("GET", "/notes", GATED, async ({ respond }) => respond(200, await options.notes.list())),
    route("POST", "/notes", GATED, async ({ request, respond }) => {
      const body = await readBody(request) as { body?: unknown };
      if (typeof body.body !== "string" || !body.body.trim()) {
        return respond(400, { error: "body must be a non-empty string" });
      }
      respond(201, await options.notes.create({ body: body.body }));
    }),
    route("DELETE", "/notes/:id", GATED, async ({ params: [id], respond }) => {
      const deleted = await options.notes.delete(id!);
      deleted ? respond(200, { ok: true }) : respond(404, { error: "no such note" });
    }),

    route("GET", "/schedules", GATED, async ({ respond }) => respond(200, await options.schedules.list())),
    route("POST", "/schedules", GATED, async ({ caller, request, respond }) => {
      const body = await readBody(request);
      if (caller === "agent" && isCommandPayload(body)) return respond(403, AGENT_COMMAND_SCHEDULE_REFUSAL);
      respond(201, await options.schedules.create(body as ScheduleCreateInput));
    }),
    route("POST", "/schedules/:id/run", GATED, async ({ caller, params: [id], respond }) =>
      respond(202, await options.schedules.run(id!, agentAuthorization(caller)))),
    route("PUT", "/schedules/:id", GATED, async ({ caller, params: [id], request, respond }) => {
      const body = await readBody(request);
      if (caller === "agent" && isCommandPayload(body)) return respond(403, AGENT_COMMAND_SCHEDULE_REFUSAL);
      respond(200, await options.schedules.update(id!, body as ScheduleCreateInput, agentAuthorization(caller)));
    }),
    route("DELETE", "/schedules/:id", GATED, async ({ params: [id], respond }) => {
      const deleted = await options.schedules.delete(id!);
      deleted ? respond(200, { ok: true }) : respond(404, { error: "no such schedule" });
    }),
    route("GET", "/schedule-runs/:id", GATED, async ({ params: [id], respond }) => {
      const run = await options.schedules.runById(id!);
      run ? respond(200, run) : respond(404, { error: "no such schedule run" });
    }),

    route("POST", "/query-database", GATED, async ({ request, respond }) => {
      const query = await readBody(request) as Record<string, unknown>;
      try {
        if (query.action === DatabaseQueryAction.ListTables) return respond(200, options.query.listTables());
        if (query.action === DatabaseQueryAction.DescribeTable && typeof query.table === "string") {
          return respond(200, options.query.describeTable(query.table));
        }
        if (query.action === DatabaseQueryAction.Query && typeof query.sql === "string") {
          return respond(200, await options.query.runQuery(query.sql));
        }
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        const { hint, closest } = error as { hint?: string; closest?: string[] };
        return respond(400, { error: error.message, hint, closest });
      }
      respond(400, { error: "invalid database query request" });
    }),

    route("GET", "/chats", OWNER_CHATS, async ({ respond }) => respond(200, await options.chats.list())),
    route("GET", "/chats/:id", OWNER_CHATS, async ({ params: [id], respond }) => respond(200, await options.chats.get(chatId(id!)))),
    route("POST", "/chats/:id/messages", OWNER_CHATS, async ({ params: [id], request, response }) => {
      const body = await readBody(request) as { text?: unknown };
      if (typeof body.text !== "string" || !body.text.trim()) {
        throw new GatewayRouteError(400, "invalid_request", "text must be a non-empty string");
      }
      const events = await options.chats.send(chatId(id!), body.text);
      response.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-cache" });
      for await (const event of events) {
        if (!response.destroyed) response.write(`${JSON.stringify(event)}\n`);
      }
      response.end();
    }),
    route("POST", "/chats/:id/cancel", OWNER_CHATS, async ({ params: [id], request, respond }) => {
      const body = await readBody(request) as { turnId?: unknown };
      if (body.turnId !== undefined && typeof body.turnId !== "string") {
        throw new GatewayRouteError(400, "invalid_request", "turnId must be a string");
      }
      respond(200, await options.chats.cancel(chatId(id!), body.turnId));
    }),
    route("PATCH", "/chats/:id", OWNER_CHATS, async ({ params: [id], request, respond }) => {
      const body = await readBody(request) as { title?: unknown };
      if (typeof body.title !== "string") throw new GatewayRouteError(400, "invalid_request", "title must be a string");
      respond(200, await options.chats.rename(chatId(id!), body.title));
    }),
    route("DELETE", "/chats/:id", OWNER_CHATS, async ({ params: [id], respond }) => {
      await options.chats.delete(chatId(id!));
      respond(200, { ok: true });
    }),

    route("GET", "/workspace/tree", OWNER_FILES, async ({ respond }) => respond(200, await options.workspace.tree())),
    route("GET", "/workspace/file", OWNER_FILES, async ({ url, respond }) =>
      respond(200, await options.workspace.read(url.searchParams.get("path") ?? ""))),
    route("PUT", "/workspace/file", OWNER_FILES, async ({ url, request, respond }) =>
      respond(200, await options.workspace.write(url.searchParams.get("path") ?? "",
        await readBody(request, MAX_WORKSPACE_WRITE_BODY_CHARS) as WorkspaceFileWrite))),
  ];

  const handle = async (caller: Caller, request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const respond = (status: number, body: unknown): void => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };

    try {
      if (caller === "owner" && !hasValidAuthorization(request.headers.authorization, options.authToken)) {
        response.setHeader("www-authenticate", "Bearer");
        return respond(401, { error: "unauthorized" });
      }

      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const { pathname } = url;
      const atPath = routes.flatMap((candidate) => {
        const params = routeParams(candidate, pathname);
        return params ? [{ route: candidate, params }] : [];
      });
      if (atPath.some(({ route }) => route.policy.setupGated) && options.ready().setupRequired) {
        return respond(428, SETUP_REQUIRED);
      }
      const matched = atPath.find(({ route }) => route.method === request.method);
      if (!matched) return respond(404, { error: "unknown route" });
      const { agent } = matched.route.policy;
      if (caller === "agent" && agent !== "allow") return respond(403, agent);
      return await matched.route.handle({ caller, request, response, url, params: matched.params, respond });
    } catch (error) {
      if (response.headersSent) return void response.end();
      if (error instanceof CommandScheduleRefused) return respond(403, AGENT_COMMAND_SCHEDULE_REFUSAL);
      if (error instanceof GatewayRouteError) return respond(error.status, { error: error.message, code: error.code, ...error.details });
      return respond(400, { error: withoutAbsolutePaths(error instanceof Error ? error.message : String(error)) });
    }
  };

  let closing = false;
  const listeners: Server[] = [];
  /** A keep-alive connection whose response ends after close() began would hold close() open until it times out. */
  const serve = (caller: Caller) => (request: IncomingMessage, response: ServerResponse): void => {
    response.once("close", () => {
      if (closing) setImmediate(() => { for (const listener of listeners) listener.closeIdleConnections(); });
    });
    void handle(caller, request, response);
  };
  const server: Server = createServer(serve("owner"));
  listeners.push(server);
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
  const agent = options.agentSocket
    ? await listenAgentSocket(options.agentSocket, serve("agent"))
    : undefined;
  if (agent?.server) listeners.push(agent.server);

  return {
    host: "127.0.0.1",
    port,
    ...(agent?.problem ? { agentSocketProblem: agent.problem } : {}),
    async close() {
      closing = true;
      unsubscribe();
      for (const stream of streams) stream.end();
      streams.clear();
      await Promise.all(listeners.map((listener) =>
        new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()))));
      agent?.remove();
    },
  };
}

const inode = (path: string): bigint | undefined => {
  try {
    return statSync(path, { bigint: true }).ino;
  } catch {
    return undefined;
  }
};

const removeSocketIfStillOurs = (path: string, own: bigint | undefined): void => {
  if (own !== undefined && inode(path) === own) rmSync(path, { force: true });
};

/** Whether a daemon holds the socket: it answers, or it accepts and then hangs. */
function answers(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = httpRequest({ socketPath: path, path: "/health", agent: false, timeout: DAEMON_PROBE_TIMEOUT_MS });
    probe.once("response", (response) => { response.resume(); resolve(true); });
    probe.once("timeout", () => { probe.destroy(); resolve(true); });
    probe.once("error", () => resolve(false));
    probe.end();
  });
}

/** Never throws: a socket that cannot listen leaves the daemon running, and doctor names the problem. */
async function listenAgentSocket(
  path: string,
  listener: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ server?: Server; problem?: string; remove(): void }> {
  const refused = (problem: string) => ({ problem, remove() {} });
  let existing: Stats | undefined;
  try {
    existing = lstatSync(path);
  } catch {}
  if (existing && !existing.isSocket()) return refused(`${path} exists and is not a socket; the owner removes it and restarts the daemon`);
  if (existing && await answers(path)) return refused(`another daemon already listens on ${path}`);
  const server = createServer(listener);
  try {
    rmSync(path, { force: true });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => resolve());
    });
    chmodSync(path, 0o600);
  } catch (error) {
    server.close();
    return refused(`the agent socket ${path} cannot listen: ${error instanceof Error ? error.message : String(error)}`);
  }
  const own = inode(path);
  return { server, remove: () => removeSocketIfStillOurs(path, own) };
}
