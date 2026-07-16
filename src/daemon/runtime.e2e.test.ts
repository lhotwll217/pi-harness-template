import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DatabaseQueryAction,
  GatewayEventKind,
  ScheduleKind,
  ScheduleRunStatus,
  ScheduledPayloadKind,
  harnessPaths,
  type DaemonInfo,
  type NoteCreateInput,
} from "@pi-template/contracts";
import {
  createSaveNoteTool,
  runOnboarding,
} from "../agent";
import { connectGateway, GatewayRequestError } from "../gateway/client";
import { State } from "../state";
import { passingOnboardingDependencies, testOnboardingAnswers } from "../../test/helpers/onboarding";
import { startDaemon } from "./lifecycle";

const previousHome = process.env.PI_TEMPLATE_HOME;
const home = mkdtempSync(join(tmpdir(), "pi-template-daemon-e2e-"));
const dbPath = join(home, "state.db");
process.env.PI_TEMPLATE_HOME = home;
let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;

class InstrumentedState extends State {
  createNoteCalls = 0;

  override createNote(input: NoteCreateInput) {
    this.createNoteCalls += 1;
    return super.createNote(input);
  }
}

const state = new InstrumentedState(dbPath);
const waitFor = async (predicate: () => boolean, message: string): Promise<void> => {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${message}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
};
const executeTool = async (tool: { execute: (...args: any[]) => Promise<any> }, input: object) => {
  const result = await tool.execute("call-1", input, undefined, undefined, undefined);
  return JSON.parse(result.content[0].text);
};

async function runTest(): Promise<void> {
try {
  try {
    daemon = await startDaemon({
      port: 0,
      dbPath,
      stateFactory: () => state,
      fingerprintIntervalMs: 60_000,
      scheduler: {
        wakeIntervalMs: 60_000,
        promptRunner: async () => ({
          exitCode: 0,
          stdout: "fake prompt completed",
          stderr: "",
          transcriptId: "fake-transcript",
        }),
      },
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      process.stdout.write("SKIP — composed daemon e2e requires loopback bind permission\n");
      return;
    }
    throw error;
  }

  const paths = harnessPaths();
  const info = JSON.parse(readFileSync(paths.daemonInfo, "utf8")) as DaemonInfo;
  assert.equal(info.port, daemon.port);
  assert.equal(info.pid, process.pid);
  assert.equal(info.fingerprint, daemon.fingerprint);
  assert.ok(info.authToken.length >= 32);
  assert.equal(statSync(paths.daemonInfo).mode & 0o777, 0o600);
  await assert.rejects(
    startDaemon({
      port: daemon.port,
      fingerprintIntervalMs: 60_000,
      scheduler: {
        promptRunner: async () => ({ exitCode: 0, stdout: "unused", stderr: "" }),
      },
    }),
    (error) => (error as NodeJS.ErrnoException).code === "EADDRINUSE",
  );
  assert.equal(
    (JSON.parse(readFileSync(paths.daemonInfo, "utf8")) as DaemonInfo).authToken,
    info.authToken,
    "a failed second daemon leaves the live daemon discovery record intact",
  );

  const client = await connectGateway();
  assert.ok(client, "authenticated live daemon is discoverable before onboarding");
  assert.deepEqual(await client.ready(), {
    ready: true,
    setupRequired: true,
    modules: { state: true, scheduler: true, gateway: true },
  });
  assert.ok((await client.listDocs()).some(({ id }) => id === "scheduler"));
  assert.equal((await client.readDocs("scheduler")).id, "scheduler");
  assert.equal((await client.queryDocs("how do I add a scheduled prompt")).matches[0]?.id, "scheduler");
  const doctor = await client.doctor() as { checks: { roots: { harnessHome: string } } };
  assert.equal(doctor.checks.roots.harnessHome, home);
  assert.equal(daemon.scheduler.status().lifecycle, "idle", "automatic work stays stopped before onboarding");
  // Thunks, not eager promises: a promise created before assert.rejects attaches
  // its handler can reject first and crash the test as an unhandled rejection.
  for (const gated of [
    () => client.listNotes(),
    () => client.listSchedules(),
    () => client.queryDatabase({ action: DatabaseQueryAction.ListTables }),
  ]) {
    await assert.rejects(
      gated,
      (error) => error instanceof GatewayRequestError && error.status === 428,
    );
  }

  const onboarding = await runOnboarding(
    testOnboardingAnswers(home),
    passingOnboardingDependencies(home),
  );
  assert.equal(onboarding.complete, true);
  assert.equal((await client.ready()).setupRequired, false);
  assert.equal(daemon.scheduler.status().lifecycle, "running");

  let eventConnectionResolve = (): void => undefined;
  const eventConnection = new Promise<void>((resolve) => { eventConnectionResolve = resolve; });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    const response = await originalFetch(...args);
    if (String(args[0]).endsWith("/events") && response.ok) eventConnectionResolve();
    return response;
  };
  const noteEvent = new Promise<void>((resolve) => {
    const unsubscribe = client.subscribe((event) => {
      if (event.kind !== GatewayEventKind.NotesChanged) return;
      unsubscribe();
      resolve();
    });
  });
  try {
    await Promise.race([
      eventConnection,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("SSE connection timed out")), 2_000)),
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
  await client.createNote({ body: "from the Gateway route" });
  await Promise.race([
    noteEvent,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("notes invalidation timed out")), 2_000)),
  ]);

  const saveNote = createSaveNoteTool(daemon.toolDependencies.notes);
  await executeTool(saveNote, { body: "from the save_note tool" });
  assert.equal(state.createNoteCalls, 2, "notes route and save_note call the same State.createNote method");
  const disposableNote = await client.createNote({ body: "remove me" });
  await client.deleteNote(disposableNote.id);
  assert.equal((await client.listNotes()).some(({ id }) => id === disposableNote.id), false);
  const tables = await client.queryDatabase({ action: DatabaseQueryAction.ListTables }) as Array<{ name: string }>;
  assert.ok(tables.some(({ name }) => name === "notes"));
  const described = await client.queryDatabase({
    action: DatabaseQueryAction.DescribeTable,
    table: "notes",
  }) as { columns: Array<{ name: string }> };
  assert.ok(described.columns.some(({ name }) => name === "body"));
  const queried = await client.queryDatabase({
    action: DatabaseQueryAction.Query,
    sql: "SELECT body FROM notes ORDER BY created_at, id",
  }) as { rows: Array<{ body: string }> };
  assert.deepEqual(queried.rows.map(({ body }) => body).sort(), [
    "from the Gateway route", "from the save_note tool",
  ]);

  const schedule = await client.createSchedule({
    name: "fake prompt",
    enabled: false,
    trigger: { kind: ScheduleKind.Every, everyMs: 60_000, anchorMs: Date.now() },
    payload: { kind: ScheduledPayloadKind.Prompt, prompt: "run the fake" },
    cwd: home,
    timeoutSeconds: 60,
  });
  assert.ok((await client.listSchedules()).some(({ id }) => id === schedule.id));
  const updated = await client.updateSchedule(schedule.id, {
    name: "updated fake prompt",
    enabled: false,
    trigger: schedule.trigger,
    payload: schedule.payload,
    cwd: schedule.cwd,
    timeoutSeconds: schedule.timeoutSeconds,
  });
  assert.equal(updated.name, "updated fake prompt");
  assert.equal((await client.runSchedule(schedule.id)).status, ScheduleRunStatus.Running);
  await waitFor(
    () => daemon!.state.listRuns(schedule.id)[0]?.status === ScheduleRunStatus.Completed,
    "fake scheduled prompt completion",
  );
  const removable = await client.createSchedule({
    name: "remove this schedule",
    enabled: false,
    trigger: { kind: ScheduleKind.Every, everyMs: 60_000, anchorMs: Date.now() },
    payload: { kind: ScheduledPayloadKind.Prompt, prompt: "never runs" },
    cwd: home,
    timeoutSeconds: 60,
  });
  await client.deleteSchedule(removable.id);
  assert.equal((await client.listSchedules()).some(({ id }) => id === removable.id), false);
  client.close();
  process.stdout.write("ok — daemon composes routes, onboarding gate, events, tools, docs, and scheduler\n");
} finally {
  if (daemon) {
    await daemon.close();
    assert.equal(existsSync(harnessPaths().daemonInfo), false);
    assert.equal(await connectGateway(), null);
  }
  if (previousHome === undefined) delete process.env.PI_TEMPLATE_HOME;
  else process.env.PI_TEMPLATE_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
}
}

await runTest();
