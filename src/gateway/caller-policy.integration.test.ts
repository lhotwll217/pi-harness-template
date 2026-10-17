import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ScheduleKind,
  ScheduleRunStatus,
  ScheduleRunTrigger,
  ScheduledPayloadKind,
  parseWorkspacePath,
  type DaemonReady,
  type ScheduleDefinition,
  type ScheduleRun,
} from "@pi-template/contracts";
import { startGateway } from "./server";

const token = "caller-policy-token";
let setupRequired = true;
const prompt: ScheduleDefinition = {
  id: "prompt-schedule",
  name: "daily",
  enabled: true,
  trigger: { kind: ScheduleKind.Every, everyMs: 60_000, anchorMs: 0 },
  payload: { kind: ScheduledPayloadKind.Prompt, prompt: "check" },
  cwd: "/tmp",
  timeoutSeconds: 60,
  revision: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  nextRunAt: null,
};
const command: ScheduleDefinition = { ...prompt, id: "command-schedule", payload: { kind: ScheduledPayloadKind.Command, argv: ["true"] } };
const run: ScheduleRun = {
  id: "run-1", scheduleId: prompt.id, trigger: ScheduleRunTrigger.Manual, status: ScheduleRunStatus.Running,
  scheduledFor: null, startedAt: null, finishedAt: null, exitCode: null, stdoutTail: null, stderrTail: null,
  error: null, transcriptId: null, attemptCount: 1,
};
const byId = (id: string) => [prompt, command].find((schedule) => schedule.id === id);
const input = (schedule: ScheduleDefinition) => JSON.stringify({
  name: schedule.name, enabled: schedule.enabled, trigger: schedule.trigger, payload: schedule.payload,
  cwd: schedule.cwd, timeoutSeconds: schedule.timeoutSeconds,
});

const socketDir = mkdtempSync(join(tmpdir(), "pi-template-policy-"));
const agentSocket = join(socketDir, "agent.sock");
const gateway = await startGateway({
  authToken: token,
  port: 0,
  agentSocket,
  health: () => ({ ok: true, port: 0, pid: process.pid, startedAt: "", fingerprint: "", stale: false, repoRoot: "/" }),
  ready: (): DaemonReady => ({ ready: true, setupRequired, modules: { state: true, scheduler: true, gateway: true } }),
  notes: {
    list: () => [],
    create: ({ body }) => ({ id: "note-1", body, createdAt: "", updatedAt: "" }),
    delete: (id) => id === "note-1",
  },
  schedules: {
    list: () => [prompt, command],
    create: () => prompt,
    update: (id, _input, authorize) => { authorize?.(byId(id)!); return byId(id)!; },
    delete: (id) => byId(id) !== undefined,
    run: async (id, authorize) => { authorize?.(byId(id)!); return { ...run, scheduleId: id }; },
    runById: (id) => id === run.id ? run : undefined,
  },
  query: {
    listTables: () => [],
    describeTable: (table) => ({ table }),
    runQuery: () => ({ rows: [], truncated: false }),
  },
  docs: {
    list: () => [],
    read: (id) => id === "scheduler"
      ? { id, title: "", summary: "", readWhen: [], path: "", contentHash: "", body: "", sections: [] }
      : { code: "unknown_doc", error: "no such doc", closest: [] } as never,
    query: () => ({ matches: [], readingPlan: [] }),
  },
  chats: {
    list: () => [],
    get: (id) => ({ id, title: "", createdAt: "", updatedAt: "", messageCount: 0, running: false, messages: [] }),
    send: async (chatId) => (async function* () {
      yield { seq: 0, type: "turn.started" as const, chatId, turnId: "t1" };
      yield { seq: 1, type: "turn.finished" as const, status: "completed" as const };
    })(),
    cancel: () => ({ cancelled: false }),
    rename: (id, title) => ({ id, title, createdAt: "", updatedAt: "", messageCount: 0, running: false }),
    delete: () => undefined,
  },
  workspace: {
    tree: () => ({ entries: [], truncated: false }),
    read: (path) => ({ path: parseWorkspacePath(path).join("/"), content: "", revision: "sha256:0", modifiedAt: "" }),
    write: (path) => ({ path: parseWorkspacePath(path).join("/"), revision: "sha256:0", modifiedAt: "", created: true }),
  },
  events: { subscribe: () => () => undefined },
  diagnostics: { doctor: () => ({ ok: true }) },
});

type Caller = "owner" | "agent" | "no-token";
function status(caller: Caller, method: string, path: string, body?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = body ? { "content-type": "application/json" } : {};
    if (caller === "owner") headers.authorization = `Bearer ${token}`;
    const outgoing = httpRequest({
      ...(caller === "agent" ? { socketPath: agentSocket } : { host: gateway.host, port: gateway.port }),
      agent: false, method, path, headers,
    }, (incoming) => {
      resolve(incoming.statusCode ?? 0);
      incoming.destroy();
    });
    outgoing.once("error", reject);
    outgoing.end(body);
  });
}

type Row = [method: string, path: string, body: string | undefined,
  ownerBeforeSetup: number, agentBeforeSetup: number, ownerAfterSetup: number, agentAfterSetup: number];
const ROWS: Row[] = [
  ["GET", "/health", undefined, 200, 200, 200, 200],
  ["GET", "/ready", undefined, 200, 200, 200, 200],
  ["GET", "/events", undefined, 200, 200, 200, 200],
  ["GET", "/doctor", undefined, 200, 200, 200, 200],
  ["GET", "/docs", undefined, 200, 200, 200, 200],
  ["POST", "/docs/query", JSON.stringify({ question: "schedule" }), 200, 200, 200, 200],
  ["POST", "/docs/query", JSON.stringify({}), 400, 400, 400, 400],
  ["GET", "/docs/scheduler", undefined, 200, 200, 200, 200],
  ["GET", "/docs/absent", undefined, 404, 404, 404, 404],
  ["GET", "/notes", undefined, 428, 428, 200, 200],
  ["POST", "/notes", JSON.stringify({ body: "milk" }), 428, 428, 201, 201],
  ["POST", "/notes", JSON.stringify({ body: " " }), 428, 428, 400, 400],
  ["DELETE", "/notes/note-1", undefined, 428, 428, 200, 200],
  ["DELETE", "/notes/absent", undefined, 428, 428, 404, 404],
  ["GET", "/schedules", undefined, 428, 428, 200, 200],
  ["POST", "/schedules", input(prompt), 428, 428, 201, 201],
  ["POST", "/schedules", input(command), 428, 428, 201, 403],
  ["PUT", `/schedules/${prompt.id}`, input(prompt), 428, 428, 200, 200],
  ["PUT", `/schedules/${prompt.id}`, input(command), 428, 428, 200, 403],
  ["PUT", `/schedules/${command.id}`, input(prompt), 428, 428, 200, 403],
  ["POST", `/schedules/${prompt.id}/run`, "{}", 428, 428, 202, 202],
  ["POST", `/schedules/${command.id}/run`, "{}", 428, 428, 202, 403],
  ["DELETE", `/schedules/${prompt.id}`, undefined, 428, 428, 200, 200],
  ["DELETE", "/schedules/absent", undefined, 428, 428, 404, 404],
  ["GET", "/schedule-runs/run-1", undefined, 428, 428, 200, 200],
  ["GET", "/schedule-runs/absent", undefined, 428, 428, 404, 404],
  ["POST", "/query-database", JSON.stringify({ action: "list_tables" }), 428, 428, 200, 200],
  ["POST", "/query-database", JSON.stringify({ action: "nonsense" }), 428, 428, 400, 400],
  ["GET", "/chats", undefined, 428, 428, 200, 403],
  ["GET", "/chats/c1", undefined, 428, 428, 200, 403],
  ["GET", "/chats/not%20an%20id", undefined, 428, 428, 400, 403],
  ["POST", "/chats/c1/messages", JSON.stringify({ text: "say hi" }), 428, 428, 200, 403],
  ["POST", "/chats/c1/messages", JSON.stringify({ text: " " }), 428, 428, 400, 403],
  ["POST", "/chats/c1/cancel", "{}", 428, 428, 200, 403],
  ["PATCH", "/chats/c1", JSON.stringify({ title: "Greeting" }), 428, 428, 200, 403],
  ["DELETE", "/chats/c1", undefined, 428, 428, 200, 403],
  ["GET", "/workspace/tree", undefined, 428, 428, 200, 403],
  ["GET", "/workspace/file?path=a.md", undefined, 428, 428, 200, 403],
  ["GET", "/workspace/file?path=../daemon.json", undefined, 428, 428, 400, 403],
  ["GET", "/workspace/file?path=skills/x", undefined, 428, 428, 403, 403],
  ["PUT", "/workspace/file?path=a.md", JSON.stringify({ content: "a" }), 428, 428, 200, 403],
  ["GET", "/no-such-route", undefined, 404, 404, 404, 404],
  ["PATCH", "/notes", undefined, 428, 428, 404, 404],
  ["GET", "/docs/scheduler/extra", undefined, 404, 404, 404, 404],
];

try {
  const answered = async (): Promise<Row[]> => {
    const rows: Row[] = [];
    for (const [method, path, body] of ROWS) {
      setupRequired = true;
      const before = [await status("owner", method, path, body), await status("agent", method, path, body)];
      setupRequired = false;
      const after = [await status("owner", method, path, body), await status("agent", method, path, body)];
      rows.push([method, path, body, before[0]!, before[1]!, after[0]!, after[1]!]);
    }
    return rows;
  };
  assert.deepEqual(await answered(), ROWS);
  for (const [method, path, body] of ROWS) {
    assert.equal(await status("no-token", method, path, body), 401, `${method} ${path} without the token`);
  }
  process.stdout.write(`ok — ${ROWS.length} routes answer each caller and setup state as declared; every one needs the token over TCP\n`);
} finally {
  await gateway.close();
  rmSync(socketDir, { recursive: true, force: true });
}
