import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  type ScheduleRun,
} from "@pi-template/contracts";
import { agentTransport, gatewayClient, GatewayRequestError } from "./client";
import { startGateway } from "./server";

const token = "test-gateway-token";
const health: DaemonHealth = {
  ok: true,
  port: 0,
  pid: process.pid,
  startedAt: "2026-01-01T00:00:00.000Z",
  fingerprint: "test-fingerprint",
  stale: false,
  repoRoot: "/test/checkout",
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
const run: ScheduleRun = {
  id: "run-1", scheduleId: "schedule-1", trigger: ScheduleRunTrigger.Manual,
  status: ScheduleRunStatus.Running, scheduledFor: null,
  startedAt: null, finishedAt: null, exitCode: null, stdoutTail: null,
  stderrTail: null, error: null, transcriptId: null, attemptCount: 1,
};
const commandSchedule: ScheduleDefinition = {
  ...schedule,
  id: "schedule-command",
  name: "nightly command",
  payload: { kind: ScheduledPayloadKind.Command, argv: ["touch", "/tmp/owned"] },
};
// The listing still shows the owner's earlier prompt; the stored row the write lands on is now a command.
const raced: ScheduleDefinition = { ...schedule, id: "schedule-raced", name: "raced" };
const stored = (id: string): ScheduleDefinition | undefined =>
  id === raced.id ? { ...raced, payload: commandSchedule.payload } : [schedule, commandSchedule].find((entry) => entry.id === id);
const calls: string[] = [];
const socketDir = mkdtempSync(join(tmpdir(), "pi-template-gateway-"));
const agentSocket = join(socketDir, "agent.sock");

let gateway: Awaited<ReturnType<typeof startGateway>>;
try {
  gateway = await startGateway({
    authToken: token,
    port: 0,
    agentSocket,
    health: () => ({ ...health, port: gateway?.port ?? 0 }),
    ready: readiness,
    notes: {
      list: () => notes,
      create: (input) => { calls.push(`note:create:${input.body}`); return notes[0]; },
      delete: (id) => { calls.push(`note:delete:${id}`); return true; },
    },
    schedules: {
      list: () => [schedule, commandSchedule, raced],
      create: (input) => { calls.push(`schedule:create:${input.name}`); return schedule; },
      update: (id, input, authorize) => {
        authorize?.(stored(id)!);
        calls.push(`schedule:update:${id}:${input.name}`);
        return schedule;
      },
      delete: (id) => { calls.push(`schedule:delete:${id}`); return true; },
      run: async (id, authorize) => {
        authorize?.(stored(id)!);
        calls.push(`schedule:run:${id}`);
        return { ...run, scheduleId: id };
      },
      runById: (id) => id === run.id ? run : undefined,
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
    ["/schedule-runs/run-1", {}],
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
  assert.deepEqual((await json("/schedule-runs/run-1")).body, run, "a run is read from State, not through a query process");
  assert.equal((await json("/schedule-runs/absent")).response.status, 404);
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
    "schedule:update:schedule-1:daily", "schedule:run:schedule-1", "schedule:delete:schedule-1",
  ]);

  assert.equal(statSync(agentSocket).mode & 0o777, 0o600);
  const agent = gatewayClient(agentTransport(agentSocket));
  calls.length = 0;
  const refusal = { status: 403, body: {
    error: "agent callers cannot create, change, or run a command schedule",
    hint: "the owner runs pi-template schedule add -- <argv>",
  } };
  const refused = async (attempt: () => Promise<unknown>): Promise<void> => {
    await assert.rejects(attempt, (error) => error instanceof GatewayRequestError &&
      error.status === refusal.status && JSON.stringify(error.body) === JSON.stringify(refusal.body));
  };
  const asInput = ({ name, enabled, trigger, payload, cwd, timeoutSeconds }: ScheduleDefinition) =>
    ({ name, enabled, trigger, payload, cwd, timeoutSeconds });
  await refused(() => agent.createSchedule(asInput(commandSchedule)));
  await refused(() => agent.updateSchedule(schedule.id, asInput({ ...schedule, payload: commandSchedule.payload })));
  await refused(() => agent.updateSchedule(commandSchedule.id, asInput({ ...commandSchedule, payload: schedule.payload })));
  await refused(() => agent.runSchedule(commandSchedule.id));
  await refused(() => agent.updateSchedule(raced.id, asInput(raced)));
  await refused(() => agent.runSchedule(raced.id));
  assert.deepEqual(calls, [], "a refused agent call reaches no schedule method");
  assert.equal((await agent.health()).pid, process.pid);
  assert.deepEqual(await agent.listNotes(), notes);
  await agent.createNote({ body: "from the agent" });
  await agent.createSchedule(asInput(schedule));
  await agent.updateSchedule(schedule.id, asInput(schedule));
  await agent.runSchedule(schedule.id);
  await agent.deleteSchedule(commandSchedule.id);
  assert.deepEqual(calls, [
    "note:create:from the agent", "schedule:create:daily", "schedule:update:schedule-1:daily",
    "schedule:run:schedule-1", "schedule:delete:schedule-command",
  ]);
  calls.length = 0;
  assert.equal((await json("/schedules", { method: "POST", body: JSON.stringify(asInput(commandSchedule)) })).response.status, 201);
  assert.equal((await json(`/schedules/${commandSchedule.id}`, { method: "PUT", body: JSON.stringify(asInput(commandSchedule)) })).response.status, 200);
  assert.equal((await json(`/schedules/${commandSchedule.id}/run`, { method: "POST", body: "{}" })).response.status, 202);
  assert.deepEqual(calls, [
    "schedule:create:nightly command", "schedule:update:schedule-command:nightly command", "schedule:run:schedule-command",
  ], "the owner's token still creates, changes, and runs a command schedule");
  process.stdout.write("ok — injected Gateway routes authenticate, gate setup, and delegate; the agent socket refuses command schedules\n");
} finally {
  await gateway.close();
  rmSync(socketDir, { recursive: true, force: true });
}
