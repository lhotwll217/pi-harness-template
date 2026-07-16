import assert from "node:assert/strict";
import {
  DatabaseQueryAction,
  ScheduleKind,
  ScheduleRunStatus,
  ScheduleRunTrigger,
  ScheduledPayloadKind,
  type DaemonHealth,
  type DaemonReady,
  type DocsDocument,
  type ScheduleDefinition,
} from "@pi-template/contracts";
import { startGateway } from "./server";

const token = "test-gateway-token";
const health: DaemonHealth = {
  ok: true,
  port: 0,
  pid: process.pid,
  startedAt: "2026-01-01T00:00:00.000Z",
  fingerprint: "test-fingerprint",
  stale: false,
};
let setupRequired = true;
const readiness = (): DaemonReady => ({
  ready: true,
  setupRequired,
  modules: { state: true, scheduler: true, gateway: true },
});
const document: DocsDocument = {
  id: "scheduler",
  title: "Scheduler",
  summary: "Schedule prompts and commands.",
  readWhen: ["Adding scheduled work"],
  path: "docs/scheduler.md",
  contentHash: "abc",
  body: "# Scheduler",
  sections: [{ id: "scheduler", heading: "Scheduler", startLine: 1 }],
};
const schedule: ScheduleDefinition = {
  id: "schedule-1",
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
const notes = [{
  id: "note-1",
  body: "remember",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
}];
const calls: string[] = [];

let gateway: Awaited<ReturnType<typeof startGateway>>;
try {
  gateway = await startGateway({
    authToken: token,
    port: 0,
    health: () => ({ ...health, port: gateway?.port ?? 0 }),
    ready: readiness,
    notes: {
      list: () => notes,
      create: (input) => { calls.push(`note:create:${input.body}`); return notes[0]; },
      delete: (id) => { calls.push(`note:delete:${id}`); return true; },
    },
    schedules: {
      list: () => [schedule],
      create: (input) => { calls.push(`schedule:create:${input.name}`); return schedule; },
      update: (id, input) => { calls.push(`schedule:update:${id}:${input.name}`); return schedule; },
      delete: (id) => { calls.push(`schedule:delete:${id}`); return true; },
      run: async (id) => ({
        id: "run-1", scheduleId: id, trigger: ScheduleRunTrigger.Manual,
        status: ScheduleRunStatus.Running, scheduledFor: null,
        startedAt: null, finishedAt: null, exitCode: null, stdoutTail: null,
        stderrTail: null, error: null, transcriptId: null, attemptCount: 1,
      }),
    },
    query: {
      listTables: () => [{ name: "notes", rows: 1, description: "Notes" }],
      describeTable: (table) => ({ table }),
      runQuery: (sql) => ({ rows: [{ sql }], truncated: false }),
    },
    docs: {
      list: () => [document],
      read: () => document,
      query: (question) => ({
        matches: [{ id: "scheduler", title: "Scheduler", score: 8, matchedOn: ["title"] }],
        readingPlan: question ? ["scheduler"] : [],
      }),
    },
    events: { subscribe: () => () => undefined },
    diagnostics: { doctor: () => ({ ok: false, checks: { sandbox: "not verified" } }) },
  });
} catch (error) {
  if ((error as NodeJS.ErrnoException).code === "EPERM") {
    process.stdout.write("SKIP — Gateway route integration requires loopback bind permission\n");
    process.exit(0);
  }
  throw error;
}

const base = `http://${gateway.host}:${gateway.port}`;
const headers = { authorization: `Bearer ${token}` };
const jsonHeaders = { ...headers, "content-type": "application/json" };
const json = async (path: string, init: RequestInit = {}) => {
  const response = await fetch(`${base}${path}`, { ...init, headers: init.body ? jsonHeaders : headers });
  return { response, body: await response.json() as any };
};

try {
  assert.equal((await fetch(`${base}/health`)).status, 401);
  assert.equal((await json("/doctor")).body.ok, false, "doctor serves before onboarding");
  assert.equal((await json("/docs")).response.status, 200, "docs list serves before onboarding");
  assert.equal((await json("/docs/scheduler")).body.id, "scheduler");
  assert.deepEqual((await json("/docs/query", {
    method: "POST", body: JSON.stringify({ question: "scheduled prompt" }),
  })).body.readingPlan, ["scheduler"]);

  for (const [path, init] of [
    ["/notes", {}],
    ["/schedules", {}],
    ["/query-database", { method: "POST", body: JSON.stringify({ action: "list_tables" }) }],
  ] as const) {
    const gated = await json(path, init);
    assert.equal(gated.response.status, 428);
    assert.equal(gated.body.error.code, "setup_required");
  }

  setupRequired = false;
  assert.deepEqual((await json("/notes")).body, notes);
  assert.equal((await json("/notes", { method: "POST", body: JSON.stringify({ body: "remember" }) })).response.status, 201);
  assert.equal((await json("/notes/note-1", { method: "DELETE" })).response.status, 200);
  assert.equal((await json("/schedules")).body[0].id, schedule.id);
  assert.equal((await json("/schedules", { method: "POST", body: JSON.stringify(schedule) })).response.status, 201);
  assert.equal((await json(`/schedules/${schedule.id}`, { method: "PUT", body: JSON.stringify(schedule) })).response.status, 200);
  assert.equal((await json(`/schedules/${schedule.id}/run`, { method: "POST", body: "{}" })).response.status, 202);
  assert.equal((await json(`/schedules/${schedule.id}`, { method: "DELETE" })).response.status, 200);
  assert.equal((await json("/query-database", {
    method: "POST", body: JSON.stringify({ action: DatabaseQueryAction.ListTables }),
  })).body[0].name, "notes");
  assert.equal((await json("/query-database", {
    method: "POST", body: JSON.stringify({ action: DatabaseQueryAction.DescribeTable, table: "notes" }),
  })).body.table, "notes");
  assert.equal((await json("/query-database", {
    method: "POST", body: JSON.stringify({ action: DatabaseQueryAction.Query, sql: "SELECT 1" }),
  })).body.rows[0].sql, "SELECT 1");
  assert.deepEqual(calls, [
    "note:create:remember", "note:delete:note-1", "schedule:create:daily",
    "schedule:update:schedule-1:daily", "schedule:delete:schedule-1",
  ]);
  process.stdout.write("ok — injected Gateway routes authenticate, gate setup, and delegate\n");
} finally {
  await gateway.close();
}
